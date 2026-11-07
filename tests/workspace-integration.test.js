import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const device = "test-deck";
const actions = {
  key: "com.tanaka-takuto.orca.workspace-status",
  dial: "com.tanaka-takuto.orca.workspace-dial",
  command: "com.tanaka-takuto.orca.workspace-command",
  active: "com.tanaka-takuto.orca.active-ai-input",
  attention: "com.tanaka-takuto.orca.attention",
};
const info = {
  application: {
    version: "7.6.1",
    platform: "mac",
    platformVersion: "14.0",
    language: "ja",
    font: "Arial",
  },
  plugin: { uuid: "com.tanaka-takuto.orca", version: "0.4.1.0" },
  devices: [
    {
      id: device,
      name: "Stream Deck +",
      type: 7,
      size: { columns: 4, rows: 2 },
    },
  ],
};

test("専用キーは画面の選択中 AI に入力し、保存時は入力せず、Enter は設定時だけ送る", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture(t);
  f.setActiveSelection("a");
  f.appear("input", "active", "unused", { body: "入力だけ" });
  await f.wait((m) => m.event === "setImage" && m.context === "input");
  assert.deepEqual(f.executions(), []);
  f.setActiveSelection("b");
  f.send("keyDown", "input", "active");
  f.send("keyDown", "input", "active");
  await f.wait((m) => m.event === "showOk" && m.context === "input");
  assert.deepEqual(f.executions(), [
    [
      "terminal",
      "send",
      "--terminal",
      "fresh-b",
      "--text",
      "入力だけ",
      "--json",
    ],
  ]);
  const start = f.history.length;
  f.send("didReceiveSettings", "input", "active", {
    settings: { body: "送信する", enter: true },
  });
  f.setActiveSelection("a");
  f.send("keyDown", "input", "active");
  await f.wait((m) => m.event === "showOk" && m.context === "input", start);
  assert.deepEqual(f.executions().at(-1), [
    "terminal",
    "send",
    "--terminal",
    "fresh-a",
    "--text",
    "送信する",
    "--enter",
    "--json",
  ]);
});
const row = (id, agentState = "working") => ({
  worktreeId: id,
  displayName: id.toUpperCase(),
  repo: "Project",
  path: `/${id}`,
  hostId: "local",
  status: agentState === "waiting" ? "permission" : "working",
  terminalVerdict: "live",
  agents: [{ paneKey: `tab:${id}`, state: agentState }],
});
const response = (result) => ({
  ok: true,
  _meta: { runtimeId: "test-runtime" },
  result,
});
const snapshot = (ids, waitingIds = []) =>
  response({
    worktrees: ids.map((id) =>
      row(id, waitingIds.includes(id) ? "waiting" : "working"),
    ),
    hostScope: { hostIds: ["local"], omittedHostIds: [] },
    truncated: false,
  });

async function fixture(t, saved = {}) {
  const directory = mkdtempSync(join(tmpdir(), "streamdeck-orca-sdk-"));
  const dataPath = join(directory, "snapshot.json");
  const switchesPath = join(directory, "switches.jsonl");
  const executionsPath = join(directory, "executions.jsonl");
  writeFileSync(dataPath, JSON.stringify(snapshot(["a", "b"])));
  copyFileSync(
    resolve("com.tanaka-takuto.orca.sdPlugin/manifest.json"),
    join(directory, "manifest.json"),
  );
  const command = join(directory, "orca-test.cjs");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(dataPath)}, 'utf8'));
if (args[0] === 'status') console.log(JSON.stringify({ok:true,_meta:data._meta,result:{app:{running:true,desktopWindowStatus:'available'}}}));
else if (args[0] === 'worktree') setTimeout(() => console.log(JSON.stringify(data)), data.testDelayMs || 0);
else if (args[1] === 'list') {
 const id = args[args.indexOf('--worktree') + 1].slice(3);
 console.log(JSON.stringify({ok:true,_meta:data._meta,result:{hostScope:{hostIds:['local'],omittedHostIds:[]},truncated:false,terminals:[{handle:'fresh-'+id,incarnationId:'inc-'+id,agentIdentity:'codex',title:'Codex '+id,worktreeId:id,tabId:'tab',leafId:id,executionHostId:'local',connected:true,writable:true,orphaned:false}]}}));
} else if (args[1] === 'switch') {
 fs.appendFileSync(${JSON.stringify(switchesPath)}, JSON.stringify(args)+'\\n');
 console.log(JSON.stringify({ok:true,_meta:data._meta,result:{focus:{navigated:true}}}));
} else if(args[1] === 'create' || args[1] === 'send') {
 fs.appendFileSync(${JSON.stringify(executionsPath)}, JSON.stringify(args)+'\\n');
 const result=args[1]==='create'?{terminal:{handle:'new-shell',worktreeId:args[args.indexOf('--worktree')+1].slice(3)}}:{send:{handle:args[args.indexOf('--terminal')+1],accepted:true,prompt:{requestId:'test-request',stages:['input_accepted']}}};
 console.log(JSON.stringify({ok:true,_meta:data._meta,result}));
} else process.exit(1);
`,
  );
  chmodSync(command, 0o755);
  const bundle = join(directory, "plugin.cjs");
  await build({
    entryPoints: ["src/plugin.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    logLevel: "silent",
    tsconfig: "tsconfig.json",
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const history = [];
  const waits = new Set();
  let socket;
  let settings = saved;
  server.on("connection", (connected) => {
    socket = connected;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      history.push(message);
      if (message.event === "getGlobalSettings")
        socket.send(
          JSON.stringify({
            event: "didReceiveGlobalSettings",
            payload: { settings },
          }),
        );
      if (message.event === "setGlobalSettings") settings = message.payload;
      for (const check of [...waits]) check();
    });
  });
  let stderr = "";
  const child = spawn(
    process.execPath,
    [
      bundle,
      "-port",
      String(server.address().port),
      "-pluginUUID",
      "test-plugin",
      "-registerEvent",
      "registerPlugin",
      "-info",
      JSON.stringify(info),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        ORCA_CLI_COMMAND: command,
        ORCA_USER_DATA_PATH: directory,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (value) => {
    stderr += value.toString();
  });
  t.after(async () => {
    const exit =
      child.exitCode === null ? once(child, "exit") : Promise.resolve();
    child.kill();
    for (const connected of server.clients) connected.terminate();
    await Promise.all([exit, new Promise((done) => server.close(done))]);
    rmSync(directory, { recursive: true, force: true });
  });
  const wait = (predicate, start = 0) =>
    new Promise((done, reject) => {
      const timer = setTimeout(() => {
        waits.delete(check);
        reject(new Error(`SDK message timeout; stderr: ${stderr}`));
      }, 6_000);
      function check() {
        const found = history.slice(start).find(predicate);
        if (!found) return;
        clearTimeout(timer);
        waits.delete(check);
        done(found);
      }
      waits.add(check);
      check();
    });
  await wait((message) => message.event === "registerPlugin");
  return {
    wait,
    history,
    get settings() {
      return settings;
    },
    send(event, context, kind, payload = {}) {
      socket.send(
        JSON.stringify({
          event,
          action: actions[kind],
          context,
          device,
          payload,
        }),
      );
    },
    appear(context, kind, controlId, extra = {}) {
      this.send("willAppear", context, kind, {
        controller: kind === "dial" ? "Encoder" : "Keypad",
        coordinates: { column: 0, row: 0 },
        isInMultiAction: false,
        settings: { controlId, ...extra },
        state: 0,
      });
    },
    setRows(ids, waitingIds = [], testDelayMs = 0) {
      writeFileSync(
        dataPath,
        JSON.stringify({ ...snapshot(ids, waitingIds), testDelayMs }),
      );
    },
    setSnapshot(value) {
      writeFileSync(dataPath, JSON.stringify(value));
    },
    setActiveSelection(id) {
      const profile = join(directory, "profiles", "current");
      mkdirSync(profile, { recursive: true });
      writeFileSync(
        join(directory, "orca-runtime.json"),
        JSON.stringify({ runtimeId: "test-runtime" }),
      );
      writeFileSync(
        join(directory, "orca-profile-index.json"),
        JSON.stringify({
          activeProfileId: "current",
          profiles: [{ id: "current" }],
        }),
      );
      const session = {
        activeWorktreeId: id,
        activeWorkspaceKey: `worktree:${id}`,
        activeTabId: "tab",
        activeTabTypeByWorktree: { [id]: "terminal" },
        activeTabIdByWorktree: { [id]: "tab" },
        tabsByWorktree: { [id]: [{ id: "tab" }] },
        terminalLayoutsByTabId: { tab: { activeLeafId: id } },
      };
      const payload = JSON.stringify(session).replaceAll("'", "''");
      execFileSync(
        process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3",
        [
          join(profile, "profile-state.db"),
          `CREATE TABLE IF NOT EXISTS profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT); INSERT OR REPLACE INTO profile_state_documents VALUES ('workspaceSession','${payload}');`,
        ],
      );
    },
    executions() {
      try {
        return readFileSync(executionsPath, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
      } catch {
        return [];
      }
    },
    switches() {
      try {
        return readFileSync(switchesPath, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
      } catch {
        return [];
      }
    },
  };
}
const imageContains = (context, text) => (message) =>
  message.event === "setImage" &&
  message.context === context &&
  decodeURIComponent(message.payload.image).includes(`>${text}</text>`);

test("確認先キーだけで待ちと返答を一巡し、固定IDの宛先と件数を変えず送信しない", async (t) => {
  const f = await fixture(t, {
    workspaceSelections: { main: { workspaceId: "b", workspaceName: "B" } },
  });
  const s = snapshot(["a", "b", "c"], ["a", "b"]);
  s.result.worktrees[2].agents[0].state = "done";
  f.setSnapshot(s);
  f.appear("nav", "attention");
  f.appear("fixed", "key", "main");
  await f.wait(imageContains("nav", "A"));
  for (const [id, next] of [
    ["a", "B"],
    ["b", "C"],
    ["c", "A"],
  ]) {
    const start = f.history.length;
    f.send("keyDown", "nav", "attention");
    await f.wait(imageContains("nav", next), start);
    assert.equal(f.switches().at(-1)[3], `fresh-${id}`);
  }
  assert.equal(f.switches().length, 3);
  assert.deepEqual(f.executions(), []);
  assert.equal(f.settings.workspaceSelections.main.workspaceId, "b");
  assert.ok(
    f.history
      .filter((m) => m.context === "nav" && m.event === "setImage")
      .some((m) =>
        decodeURIComponent(m.payload.image).includes("入力 2 · 返答 1"),
      ),
  );
});
test("確認先の消失後は表示を更新するが、その押下で代わりの相手を開かない", async (t) => {
  const f = await fixture(t);
  f.setRows(["a", "b"], ["a", "b"]);
  f.appear("nav", "attention");
  await f.wait(imageContains("nav", "A"));
  f.setRows(["b"], ["b"]);
  f.send("keyDown", "nav", "attention");
  await f.wait((m) => m.event === "showAlert" && m.context === "nav");
  assert.deepEqual(f.switches(), []);
  await f.wait(imageContains("nav", "B"));
  const start = f.history.length;
  f.send("keyDown", "nav", "attention");
  await f.wait(imageContains("nav", "開いています"), start);
  const opening = f.history.length;
  await f.wait(imageContains("nav", "押して開く"), opening);
  assert.equal(f.switches().at(-1)[3], "fresh-b");
});

test("旧ページが先に消えても、状態キー1個と2個の切替で不明を挟まず最新状態へ更新する", async (t) => {
  for (const [oldCount, nextCount] of [
    [1, 2],
    [2, 1],
  ]) {
    await t.test(`${oldCount}個から${nextCount}個`, async (t) => {
      const f = await fixture(t, {
        workspaceSelections: {
          slot0: { workspaceId: "a", workspaceName: "A" },
          slot1: { workspaceId: "b", workspaceName: "B" },
        },
      });
      f.setRows(["a", "b"], [], 150);
      for (let i = 0; i < oldCount; i++)
        f.appear(`old-${i}`, "key", `slot${i}`);
      for (let i = 0; i < oldCount; i++)
        await f.wait(imageContains(`old-${i}`, "進行中"));
      f.setRows(["a", "b"], ["a", "b"], 150);
      const start = f.history.length;
      for (let i = 0; i < oldCount; i++)
        f.send("willDisappear", `old-${i}`, "key");
      for (let i = 0; i < nextCount; i++)
        f.appear(`new-${i}`, "key", `slot${i}`);
      for (let i = 0; i < nextCount; i++) {
        const first = await f.wait(
          (m) => m.event === "setImage" && m.context === `new-${i}`,
          start,
        );
        assert.match(decodeURIComponent(first.payload.image), /進行中/u);
        await f.wait(imageContains(`new-${i}`, "入力待ち"), start);
      }
      assert.equal(
        f.history
          .slice(start)
          .some(
            (m) =>
              m.event === "setImage" &&
              m.context.startsWith("new-") &&
              decodeURIComponent(m.payload.image).includes("状態不明"),
          ),
        false,
      );
    });
  }
});

test("SDK の画像更新として進行中のアニメーションを送信する", async (t) => {
  const f = await fixture(t);
  f.appear("key-main", "key", "main");
  const first = await f.wait(
    (message) =>
      imageContains("key-main", "A")(message) &&
      decodeURIComponent(message.payload.image).includes("進行中"),
  );
  const next = await f.wait(
    (message) =>
      imageContains("key-main", "A")(message) &&
      message.payload.image !== first.payload.image,
    f.history.length,
  );
  assert.match(decodeURIComponent(next.payload.image), /進行中/u);
  assert.deepEqual(f.switches(), [], "アニメーションで画面を移動しない");
});

test("SDK の回転イベントで同じ ID のキーだけを切り替え、押したときだけ最新の対象を開く", async (t) => {
  const f = await fixture(t);
  f.appear("key-main", "key", "main");
  f.appear("key-mirror", "key", "main");
  f.appear("key-other", "key", "other");
  f.appear("dial-main", "dial", "main");
  await f.wait(imageContains("key-main", "A"));
  await f.wait(imageContains("key-other", "A"));
  const start = f.history.length;
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  await f.wait(imageContains("key-main", "B"), start);
  await f.wait(imageContains("key-mirror", "B"), start);
  await f.wait(
    (m) =>
      m.event === "setFeedback" &&
      m.context === "dial-main" &&
      m.payload.workspace === "B",
    start,
  );
  assert.equal(
    f.history.slice(start).some(imageContains("key-other", "B")),
    false,
  );
  assert.deepEqual(f.switches(), []);
  f.send("keyDown", "key-main", "key", { settings: { controlId: "main" } });
  await f.wait(
    (m) =>
      m.event === "setGlobalSettings" &&
      m.payload.workspaceSelections.main?.workspaceId === "b",
  );
  // Ask for a fresh view to await the focus command without a fixed delay.
  f.send("propertyInspectorDidAppear", "key-main", "key");
  f.send("sendToPlugin", "key-main", "key", {
    type: "get-control",
    requestId: "focused",
  });
  await f.wait(
    (m) =>
      m.event === "sendToPropertyInspector" &&
      m.payload.requestId === "focused",
  );
  // The CLI focus path runs several processes; wait for its file event as an observable effect.
  const deadline = Date.now() + 5_000;
  while (f.switches().length === 0 && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  assert.equal(f.switches().length, 1);
  assert.deepEqual(f.switches()[0], [
    "terminal",
    "switch",
    "--terminal",
    "fresh-b",
    "--json",
  ]);
});

test("SDK 再接続時に ID ごとの選択を復元し、新規ワークスペースを自動で候補に加える", async (t) => {
  const f = await fixture(t, {
    unrelated: "preserve",
    workspaceSelections: { main: { workspaceId: "b", workspaceName: "B" } },
  });
  f.appear("key-main", "key", "main");
  f.appear("dial-main", "dial", "main");
  await f.wait(imageContains("key-main", "B"));
  await f.wait(
    (m) => m.event === "setFeedback" && m.payload.position === "2 / 2",
  );
  f.setRows(["a", "b", "c"]);
  await f.wait(
    (m) => m.event === "setFeedback" && m.payload.position === "2 / 3",
  );
  const start = f.history.length;
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  await f.wait(imageContains("key-main", "C"), start);
  await f.wait(
    (m) =>
      m.event === "setGlobalSettings" &&
      m.payload.workspaceSelections.main?.workspaceId === "c",
  );
  assert.equal(f.settings.unrelated, "preserve");
  assert.deepEqual(f.switches(), []);
  const change = f.history.length;
  f.send("didReceiveSettings", "dial-main", "dial", {
    settings: { controlId: "other" },
  });
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  await f.wait(
    (m) =>
      m.event === "setFeedback" &&
      m.payload.title.startsWith("other") &&
      m.payload.workspace === "B",
    change,
  );
  assert.equal(
    f.history.slice(change).some(imageContains("key-main", "A")),
    false,
  );
});

test("ダイヤル押し込みで同じ ID のキーだけが入力待ちを順送りし、Orca は開かない", async (t) => {
  const f = await fixture(t);
  f.setRows(["a", "b", "c", "d"], ["b", "d"]);
  f.appear("key-main", "key", "main");
  f.appear("key-mirror", "key", "main");
  f.appear("key-other", "key", "other");
  f.appear("dial-main", "dial", "main");
  await f.wait(
    (m) => m.event === "setFeedback" && m.payload.position === "1 / 4",
  );
  f.send("propertyInspectorDidAppear", "dial-main", "dial");
  async function view(requestId) {
    f.send("sendToPlugin", "dial-main", "dial", {
      type: "get-control",
      requestId,
    });
    return (
      await f.wait(
        (m) =>
          m.event === "sendToPropertyInspector" &&
          m.payload.requestId === requestId,
      )
    ).payload;
  }
  const start = f.history.length;
  f.send("dialDown", "dial-main", "dial");
  f.send("dialUp", "dial-main", "dial");
  await f.wait(imageContains("key-main", "B"), start);
  await f.wait(imageContains("key-mirror", "B"), start);
  assert.equal(
    (await view("after-one-click")).workspaceName,
    "B",
    "押す・離すで二回進めない",
  );
  f.send("dialDown", "dial-main", "dial");
  await f.wait(imageContains("key-main", "D"), start);
  f.send("dialDown", "dial-main", "dial");
  assert.equal((await view("wrapped")).workspaceName, "B");
  assert.equal(
    f.history.slice(start).some(imageContains("key-other", "B")),
    false,
  );
  assert.equal(
    f.history.slice(start).some(imageContains("key-other", "D")),
    false,
  );
  assert.deepEqual(f.switches(), []);
  // Refresh the shared catalog after the remaining workspaces leave input-waiting.
  f.setRows(["a", "b", "c", "d"]);
  await view("no-waiting");
  f.send("dialDown", "dial-main", "dial");
  assert.equal((await view("kept-selection")).workspaceName, "B");
  assert.deepEqual(f.switches(), []);
});

test("回転時に最新の候補を取得し、連続回転の後すぐキーを押しても更新後の対象を開く", async (t) => {
  const f = await fixture(t);
  f.appear("key-main", "key", "main");
  f.appear("dial-main", "dial", "main");
  await f.wait(
    (m) => m.event === "setFeedback" && m.payload.position === "1 / 2",
  );
  f.setRows(["a", "c", "d"]);
  const start = f.history.length;
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  f.send("keyDown", "key-main", "key", { settings: { controlId: "main" } });
  await f.wait(imageContains("key-main", "D"), start);
  const deadline = Date.now() + 5_000;
  while (f.switches().length === 0 && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(f.switches(), [
    ["terminal", "switch", "--terminal", "fresh-d", "--json"],
  ]);
});

test("押し込みでも最新状態を取得し、取得中の操作 ID 変更で古い選択操作を捨てる", async (t) => {
  const f = await fixture(t);
  f.appear("key-main", "key", "main");
  f.appear("key-other", "key", "other");
  f.appear("dial-main", "dial", "main");
  await f.wait(
    (m) => m.event === "setFeedback" && m.payload.position === "1 / 2",
  );
  f.setRows(["a", "b"], ["b"]);
  const start = f.history.length;
  f.send("dialDown", "dial-main", "dial");
  await f.wait(imageContains("key-main", "B"), start);
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  f.send("didReceiveSettings", "dial-main", "dial", {
    settings: { controlId: "other" },
  });
  f.send("dialDown", "dial-main", "dial");
  await f.wait(imageContains("key-other", "B"), start);
  f.send("propertyInspectorDidAppear", "key-main", "key");
  f.send("sendToPlugin", "key-main", "key", {
    type: "get-control",
    requestId: "binding-guard",
  });
  const view = await f.wait(
    (m) =>
      m.event === "sendToPropertyInspector" &&
      m.payload.requestId === "binding-guard",
  );
  assert.equal(
    view.payload.workspaceName,
    "B",
    "以前の ID への遅い回転を反映しない",
  );
  assert.deepEqual(f.switches(), []);
});

test("設定だけでは実行せず、回転直後のコマンドボタンで選択先に一度だけシェルを起動する", async (t) => {
  const f = await fixture(t);
  f.appear("key-main", "key", "main");
  f.appear("dial-main", "dial", "main");
  f.appear("run", "command", "main", {
    mode: "shell",
    body: "npm test",
    label: "テスト",
  });
  await f.wait(imageContains("run", "A"));
  assert.deepEqual(f.executions(), []);
  f.setRows(["a", "c"]);
  f.send("dialRotate", "dial-main", "dial", { ticks: 1, pressed: false });
  f.send("keyDown", "run", "command");
  f.send("keyDown", "run", "command");
  await f.wait((m) => m.event === "showOk" && m.context === "run");
  assert.deepEqual(f.executions(), [
    [
      "terminal",
      "create",
      "--worktree",
      "id:c",
      "--title",
      "テスト",
      "--command",
      "npm test",
      "--focus",
      "--json",
    ],
  ]);
  await f.wait(imageContains("run", "C"));
});

test("AI ボタンで指示を送り、古いプロセスを指定した設定では再送しない", async (t) => {
  const f = await fixture(t);
  f.appear("run", "command", "main", {
    mode: "ai",
    body: "変更をレビューして",
  });
  await f.wait(imageContains("run", "A"));
  f.send("keyDown", "run", "command");
  await f.wait((m) => m.event === "showOk" && m.context === "run");
  assert.deepEqual(f.executions(), [
    [
      "terminal",
      "send",
      "--terminal",
      "fresh-a",
      "--text",
      "変更をレビューして",
      "--enter",
      "--json",
    ],
  ]);
  const start = f.history.length;
  f.send("didReceiveSettings", "run", "command", {
    settings: {
      controlId: "main",
      mode: "ai",
      body: "変更をレビューして",
      agentTargets: {
        a: {
          handle: "fresh-a",
          runtimeId: "test-runtime",
          incarnationId: "old",
        },
      },
    },
  });
  f.send("keyDown", "run", "command");
  await f.wait((m) => m.event === "showAlert" && m.context === "run", start);
  assert.equal(f.executions().length, 1);
});
