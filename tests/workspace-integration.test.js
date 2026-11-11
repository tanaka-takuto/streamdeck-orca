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

test("専用キーは表示済み AI に入力し、保存や選択変更だけでは入力しない", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture(t);
  f.setActiveSelection("a");
  f.appear("input", "active", "unused", {
    body: "入力だけ",
    recipientMode: "displayed-v1",
  });
  await f.wait(
    (m) =>
      m.event === "setImage" &&
      m.context === "input" &&
      decodeURIComponent(m.payload.image).includes("Pr/") &&
      decodeURIComponent(m.payload.image).includes('data-icon="input"'),
  );
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
      "fresh-a",
      "--text",
      "入力だけ",
      "--json",
    ],
  ]);
  const start = f.history.length;
  f.send("didReceiveSettings", "input", "active", {
    settings: { body: "送信する", enter: true, recipientMode: "displayed-v1" },
  });
  f.setActiveSelection("a");
  const preview = await f.wait(
    (m) =>
      m.event === "setImage" &&
      m.context === "input" &&
      decodeURIComponent(m.payload.image).includes(">送信<") &&
      decodeURIComponent(m.payload.image).includes("Pr/") &&
      decodeURIComponent(m.payload.image).includes('data-icon="input"'),
    start,
  );
  const displayedA = decodeURIComponent(preview.payload.image).includes(
    "/A</text>",
  );
  f.setActiveSelection(displayedA ? "b" : "a");
  f.send("keyDown", "input", "active");
  await f.wait((m) => m.event === "showOk" && m.context === "input", start);
  assert.deepEqual(f.executions().at(-1), [
    "terminal",
    "send",
    "--terminal",
    displayedA ? "fresh-a" : "fresh-b",
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
if(args[0] === 'file'){fs.appendFileSync(${JSON.stringify(executionsPath)},JSON.stringify(args)+'\\n');console.log(JSON.stringify({ok:true,_meta:data._meta,result:{opened:true,kind:'text'}}));}
else if (args[0] === 'status') console.log(JSON.stringify({ok:true,_meta:data._meta,result:{app:{running:true,desktopWindowStatus:'available'}}}));
else if (args[0] === 'reference' && args[1] === 'list') {
 const id = args[args.indexOf('--worktree') + 1].slice(3);
 const row = data.result.worktrees.find(w => w.worktreeId === id);
 console.log(JSON.stringify({ok:true,_meta:data._meta,result:{worktree:{id,hostId:row?.hostId,instanceId:row?.instanceId},references:data.testReferences?.[id]??[]}}));
}
else if (args[0] === 'worktree') setTimeout(() => console.log(JSON.stringify(data)), data.testDelayMs || 0);
else if (args[1] === 'list') {
 const id = args[args.indexOf('--worktree') + 1].slice(3);
 console.log(JSON.stringify({ok:true,_meta:data._meta,result:{hostScope:{hostIds:['local'],omittedHostIds:[]},truncated:false,topologyRevisions:{[id]:1},visualLayouts:[{worktreeId:id,root:{type:'group',tabs:[{tabId:'tab',panes:{type:'terminal',handle:'fresh-'+id,tabId:'tab',leafId:id}}]}}],terminals:[{handle:'fresh-'+id,incarnationId:'inc-'+id,agentIdentity:'codex',title:'Codex '+id,worktreeId:id,tabId:'tab',leafId:id,executionHostId:'local',connected:true,writable:true,orphaned:false}]}}));
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
  const actionSettings = new Map();
  const waits = new Set();
  let socket;
  let settings = saved;
  server.on("connection", (connected) => {
    socket = connected;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      history.push(message);
      if (message.event === "setSettings")
        actionSettings.set(message.context, message.payload);
      if (message.event === "getSettings")
        socket.send(
          JSON.stringify({
            event: "didReceiveSettings",
            action: actions.key,
            context: message.context,
            device,
            payload: { settings: actionSettings.get(message.context) ?? {} },
          }),
        );
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
        reject(
          new Error(
            `SDK message timeout; stderr: ${stderr}; last events: ${JSON.stringify(history.slice(-6).map(({ event, context }) => ({ event, context })))}`,
          ),
        );
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
  socket.send(
    JSON.stringify({
      event: "deviceDidConnect",
      device,
      deviceInfo: info.devices[0],
    }),
  );
  return {
    directory,
    wait,
    history,
    get settings() {
      return settings;
    },
    setGlobalSettings(value) {
      settings = value;
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
      actionSettings.set(context, { controlId, ...extra });
      this.send("willAppear", context, kind, {
        controller: "Keypad",
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
          "-cmd",
          ".timeout 5000",
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

test("確認先キーだけで待ちと返答を一巡し、状態ボタンの旧割当と件数を変えず送信しない", async (t) => {
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
      .some((m) => decodeURIComponent(m.payload.image).includes("入力待ち")),
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
  await f.wait(imageContains("nav", "移動中"), start);
  const opening = f.history.length;
  await f.wait(imageContains("nav", "入力待ち"), opening);
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
        f.appear(`old-${i}`, "key", `slot${i}`, {
          workspaceButtonVersion: 1,
          workspace: {
            workspaceId: i ? "b" : "a",
            workspaceName: i ? "B" : "A",
          },
        });
      for (let i = 0; i < oldCount; i++)
        await f.wait(imageContains(`old-${i}`, "進行中"));
      f.setRows(["a", "b"], ["a", "b"], 150);
      const start = f.history.length;
      for (let i = 0; i < oldCount; i++)
        f.send("willDisappear", `old-${i}`, "key");
      for (let i = 0; i < nextCount; i++)
        f.appear(`new-${i}`, "key", `slot${i}`, {
          workspaceButtonVersion: 1,
          workspace: {
            workspaceId: i ? "b" : "a",
            workspaceName: i ? "B" : "A",
          },
        });
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
  const f = await fixture(t, {
    workspaceSelections: { main: { workspaceId: "a", workspaceName: "A" } },
  });
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

test("未割当ボタンは先頭WSを選ばずkeyDownだけでは移動しない", async (t) => {
  const f = await fixture(t);
  f.appear("blank", "key", undefined, { workspaceButtonVersion: 1 });
  await f.wait(imageContains("blank", "未割当"));
  f.send("keyDown", "blank", "key");
  f.send("keyUp", "blank", "key");
  await f.wait((m) => m.event === "showAlert" && m.context === "blank");
  assert.deepEqual(f.switches(), []);
});

test("SDKでWS削除後は割当を保存解除して未割当に戻り、他キーを変えず長押し再登録できる", async (t) => {
  const f = await fixture(t);
  f.appear("deleted", "key", undefined, {
    workspaceButtonVersion: 1,
    workspace: { workspaceId: "a", workspaceName: "A", hostId: "local" },
    custom: "keep",
  });
  f.appear("other", "key", undefined, {
    workspaceButtonVersion: 1,
    workspace: { workspaceId: "b", workspaceName: "B", hostId: "local" },
  });
  await f.wait(imageContains("deleted", "進行中"));
  await f.wait(imageContains("other", "進行中"));
  const start = f.history.length;
  f.setRows(["b"]);
  const cleared = await f.wait(
    (m) =>
      m.event === "setSettings" &&
      m.context === "deleted" &&
      !m.payload.workspace,
    start,
  );
  assert.equal(cleared.payload.custom, "keep");
  assert.equal(cleared.payload.workspaceButtonVersion, 1);
  await f.wait(imageContains("deleted", "未割当"), start);
  assert.ok(
    f.history
      .slice(start)
      .every((m) => m.event !== "setSettings" || m.context !== "other"),
  );
  assert.deepEqual(f.switches(), []);
  assert.deepEqual(f.executions(), []);
  const selected = snapshot(["b"]);
  selected.result.worktrees[0].isActive = true;
  f.setSnapshot(selected);
  f.send("keyDown", "deleted", "key");
  await f.wait((m) => m.event === "showOk" && m.context === "deleted", start);
  f.send("keyUp", "deleted", "key");
  const registered = f.history.findLast(
    (m) => m.event === "setSettings" && m.context === "deleted",
  );
  assert.equal(registered.payload.workspace.workspaceId, "b");
  assert.deepEqual(f.switches(), []);
});

test("SDKでOrca再起動後も既存キーの警告を残さず、保存済WSへの移動と長押し再登録ができる", async (t) => {
  const f = await fixture(t),
    initial = {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    };
  f.appear("existing", "key", undefined, initial);
  await f.wait(imageContains("existing", "進行中"));
  const start = f.history.length,
    restarted = snapshot(["a", "b"]);
  restarted._meta.runtimeId = "restarted-runtime";
  restarted.result.worktrees[1].isActive = true;
  f.setSnapshot(restarted);
  f.send("propertyInspectorDidAppear", "existing", "key");
  f.send("sendToPlugin", "existing", "key", {
    type: "get-workspace-button",
    requestId: "after-restart",
  });
  const view = await f.wait(
    (m) =>
      m.event === "sendToPropertyInspector" &&
      m.payload.requestId === "after-restart",
    start,
  );
  assert.deepEqual(view.payload.workspace, initial.workspace);
  assert.equal(view.payload.ready, true);
  assert.ok(
    f.history
      .slice(start)
      .every(
        (m) =>
          m.event !== "setImage" ||
          !decodeURIComponent(m.payload.image).includes("環境変更"),
      ),
  );
  assert.deepEqual(f.switches(), []);
  assert.deepEqual(f.executions(), []);
  const press = f.history.length;
  f.send("keyDown", "existing", "key");
  f.send("keyUp", "existing", "key");
  await f.wait(imageContains("existing", "移動中"), press);
  await f.wait(imageContains("existing", "進行中"), f.history.length);
  assert.equal(f.switches().at(-1)[3], "fresh-a");
  f.send("keyDown", "existing", "key");
  await f.wait((m) => m.event === "showOk" && m.context === "existing");
  f.send("keyUp", "existing", "key");
  const written = f.history.findLast(
    (m) => m.event === "setSettings" && m.context === "existing",
  );
  assert.equal(written.payload.workspace.workspaceId, "b");
  assert.equal(f.switches().length, 1);
  assert.deepEqual(f.executions(), []);
});

test("SDK長押しはAIなしの画面選択WSを登録し移動せず他ボタンに影響しない", async (t) => {
  const f = await fixture(t),
    initial = {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    };
  const snap = snapshot(["a", "b"]);
  for (const row of snap.result.worktrees) {
    row.agents = [];
    row.terminalVerdict = "none";
    row.isActive = row.worktreeId === "b";
  }
  f.setSnapshot(snap);
  f.appear("register", "key", undefined, initial);
  f.appear("mirror", "key", undefined, initial);
  await f.wait(imageContains("register", "A"));
  f.send("keyDown", "register", "key");
  const written = await f.wait(
    (m) =>
      m.event === "setSettings" &&
      m.context === "register" &&
      m.payload.workspace?.workspaceId === "b",
  );
  assert.equal(written.payload.workspace.workspaceName, "B");
  await f.wait((m) => m.event === "showOk" && m.context === "register");
  f.send("keyUp", "register", "key");
  f.send("propertyInspectorDidAppear", "mirror", "key");
  f.send("sendToPlugin", "mirror", "key", {
    type: "get-workspace-button",
    requestId: "mirror",
  });
  const view = await f.wait(
    (m) =>
      m.event === "sendToPropertyInspector" && m.payload.requestId === "mirror",
  );
  assert.equal(view.payload.workspace.workspaceId, "a");
  assert.deepEqual(f.switches(), []);
  assert.deepEqual(f.executions(), []);
});

test("SDKダブルで割当WSのPRとIssueを全件開き、旧選択messageと設定確認だけでは開かない", async (t) => {
  const f = await fixture(t),
    snap = snapshot(["a", "b"]);
  const refs = [
    {
      provider: "github",
      type: "issue",
      key: "issue",
      url: "https://github.com/acme/app/issues/1",
      selected: true,
    },
    {
      provider: "github",
      type: "pr",
      key: "p2",
      url: "https://github.com/acme/app/pull/2",
    },
    {
      provider: "github",
      type: "pr",
      key: "p3",
      url: "https://github.com/acme/app/pull/3",
    },
  ];
  snap.testReferences = { a: [...refs, { ...refs[1], key: "dup" }] };
  f.setSnapshot(snap);
  f.appear("batch", "key", undefined, {
    workspaceButtonVersion: 1,
    workspace: { workspaceId: "a", workspaceName: "A" },
    reference: {
      workspaceId: "a",
      key: "deleted",
      url: "https://github.com/acme/app/pull/99",
    },
  });
  await f.wait(imageContains("batch", "A"));
  f.send("propertyInspectorDidAppear", "batch", "key");
  f.send("sendToPlugin", "batch", "key", {
    type: "select-reference",
    requestId: "old-choice",
    workspaceId: "a",
    key: "p2",
    revision: "obsolete",
  });
  f.send("sendToPlugin", "batch", "key", {
    type: "get-workspace-button",
    requestId: "all-links",
  });
  const view = await f.wait(
    (m) =>
      m.event === "sendToPropertyInspector" &&
      m.payload.requestId === "all-links",
  );
  assert.equal(view.payload.references.length, 3);
  assert.deepEqual(
    f.history.filter((m) => m.event === "openUrl"),
    [],
  );
  f.setActiveSelection("b");
  for (const event of ["keyDown", "keyUp", "keyDown", "keyUp"])
    f.send(event, "batch", "key");
  await f.wait((m) => m.event === "openUrl" && m.payload.url === refs[2].url);
  assert.deepEqual(
    f.history.filter((m) => m.event === "openUrl").map((m) => m.payload.url),
    refs.map((r) => r.url),
  );
  assert.deepEqual(f.switches(), []);
  assert.deepEqual(f.executions(), []);
});
