import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, initialIds = ["A", "B"]) {
  const built = await build({
    entryPoints: ["src/workspace-service.ts"],
    bundle: true,
    write: false,
    platform: "node",
    target: "node20",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "sdk-boundary",
        setup(b) {
          b.onResolve({ filter: /^@elgato\/streamdeck$/ }, () => ({
            path: "mock",
            namespace: "sdk",
          }));
          b.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({
            contents: "export default testSdk;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const sdk = { logger: { warn() {} }, ui: {}, settings: {} };
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    "require",
    "testSdk",
    built.outputFiles[0].text,
  )(module, module.exports, createRequire(import.meta.url), sdk);
  const service = module.exports.workspaceService;
  const rows = initialIds.map((id) => ({
    id,
    name: id,
    project: "P",
    path: `/${id}`,
    hostId: "local",
    agents: [],
    activity: "active",
    terminalVerdict: "none",
  }));
  service.client.snapshot = async () => ({
    runtimeId: "r",
    workspaces: rows,
    truncated: false,
  });
  const executions = [];
  service.executor.execute = async (id, settings, current) => {
    if (current()) executions.push({ id, body: settings.body });
    return { status: "accepted", message: "mock" };
  };
  service.selections.hydrate({
    main: { workspaceId: initialIds[0], workspaceName: initialIds[0] },
  });
  let visible;
  let block;
  const deferred = [];
  const key = {
    id: "run",
    async setImage(image) {
      const text = decodeURIComponent(image);
      if (block?.(text)) await new Promise((resolve) => deferred.push(resolve));
      visible = text;
    },
    async showAlert() {},
    async showOk() {},
  };
  t.after(() => {
    service.unbind(key.id);
    for (const resolve of deferred) resolve();
  });
  return {
    service,
    sdk,
    rows,
    key,
    executions,
    get visible() {
      return visible;
    },
    block(fn) {
      block = fn;
    },
    async release() {
      block = undefined;
      for (const resolve of deferred.splice(0)) resolve();
      await tick();
    },
  };
}

test("短タグだけでなく名前の表示も重複するときはコマンドを拒否し、改名後の明示押下だけ実行する", async (t) => {
  const ids = ["collision-11vsk8p-13317", "collision-1c0e837-25368"];
  const f = await fixture(t, ids);
  for (const row of f.rows) row.name = "main";
  f.service.bindCommand(f.key, { body: "test", mode: "shell" });
  await tick();
  assert.match(f.visible, /表示重複/u);
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, []);
  f.rows[1].name = "区別できる名前";
  await f.service.monitor.refresh();
  await tick();
  assert.deepEqual(f.executions, [], "一覧更新だけでは実行しない");
  await f.service.execute(f.key.id);
  assert.equal(f.executions[0]?.id, ids[0]);
});

for (const variant of [
  "empty-project",
  "filtered-name",
  "collapsed-spaces",
  "canonical-unicode",
]) {
  test(`描画後に同じになる${variant}も、同名・同タグとして実行を拒否する`, async (t) => {
    const f = await fixture(t, [
      "collision-11vsk8p-13317",
      "collision-1c0e837-25368",
    ]);
    for (const row of f.rows) row.name = "main";
    if (variant === "empty-project") {
      f.rows[0].project = "";
      f.rows[1].project = "未取得";
    } else if (variant === "filtered-name") f.rows[1].name = "ma\u0001in";
    else if (variant === "collapsed-spaces") {
      f.rows[0].name = "a b";
      f.rows[1].name = "a  b";
    } else {
      f.rows[0].name = "e\u0301";
      f.rows[1].name = "é";
    }
    f.service.bindCommand(f.key, { body: "test", mode: "shell" });
    await tick();
    await f.service.execute(f.key.id);
    assert.deepEqual(f.executions, []);
    assert.match(f.visible, /表示重複/u);
  });
}

test("実行の詳細に完全ID・プロジェクト・パス・短タグを返し、消失時は古いパスを出さない", async (t) => {
  const f = await fixture(t);
  const views = [];
  f.sdk.ui.action = f.key;
  f.sdk.ui.sendToPropertyInspector = async (view) => views.push(view);
  f.service.bindCommand(f.key, { body: "test", mode: "shell" });
  await f.service.sendExecutionView(f.key.id, "command", false);
  for (const view of views) {
    assert.equal(view.workspaceIdentity.id, "A");
    assert.equal(view.workspaceIdentity.project, "P");
    assert.equal(view.workspaceIdentity.path, "/A");
    assert.ok(view.workspaceIdentity.tag);
  }
  f.rows[0].project = "\u0001　 ";
  await f.service.sendExecutionView(f.key.id, "empty-project", false);
  assert.equal(views.at(-1).workspaceIdentity.projectLabel, "未取得");
  f.rows.splice(0, 1);
  await f.service.sendExecutionView(f.key.id, "missing", false);
  assert.equal(views.at(-1).workspaceIdentity.id, "A");
  assert.equal(views.at(-1).workspaceIdentity.path, undefined);
  assert.equal(views.at(-1).workspaceIdentity.project, undefined);
});

test("コマンド要求中は次の選択先のプロジェクトや短タグへ表示を付け替えない", async (t) => {
  const f = await fixture(t);
  f.rows[0].project = "repo-A";
  f.rows[1].project = "repo-B";
  let finish;
  f.service.executor.execute = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.service.bindCommand(f.key, { body: "test", mode: "shell" });
  await tick();
  const pressing = f.service.execute(f.key.id);
  await tick();
  f.service.selections.rotate("main", 1);
  await tick();
  assert.match(f.visible, /repo-A/u);
  assert.doesNotMatch(f.visible, /repo-B/u);
  finish({ status: "accepted", message: "mock" });
  await pressing;
  await tick();
  assert.match(f.visible, /repo-B/u);
});
test("コマンドの表示Aが残る間に、選択だけBへ進んでもBで実行しない", async (t) => {
  const f = await fixture(t);
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "test-A",
  });
  await tick();
  f.block((s) => s.includes(">B</text>"));
  f.service.selections.rotate("main", 1);
  await tick();
  assert.match(f.visible, />A<\/text>/u);
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, []);
  await f.release();
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, [{ id: "B", body: "test-A" }]);
});
test("同じ宛先でも設定変更後の画像が未確定なら新しい本文を実行しない", async (t) => {
  const f = await fixture(t);
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "old",
    label: "旧操作",
  });
  await tick();
  f.block((s) => s.includes("新操作"));
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "new",
    label: "新操作",
  });
  await tick();
  assert.match(f.visible, /旧操作/u);
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, []);
  await f.release();
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, [{ id: "A", body: "new" }]);
});

test("実行中に選択が変わっても、表示中の実行先と次に使う宛先を混ぜない", async (t) => {
  const f = await fixture(t);
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "test",
  });
  await tick();
  let finish;
  f.service.executor.execute = async () =>
    await new Promise((resolve) => {
      finish = resolve;
    });
  const running = f.service.execute(f.key.id);
  await tick();
  f.service.selections.rotate("main", 1);
  await tick();
  assert.match(f.visible, />A<\/text>/u);
  f.block((s) => s.includes(">B</text>"));
  finish({ status: "unknown", message: "mock unknown" });
  await running;
  await tick();
  f.service.executor.execute = async (id) => {
    f.executions.push({ id });
    return { status: "accepted", message: "mock" };
  };
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, []);
  await f.release();
});

test("新しい対象の画像送信失敗は、その後の押下で実行を許可しない", async (t) => {
  const f = await fixture(t);
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "test",
  });
  await tick();
  f.block((s) => {
    if (s.includes(">B</text>")) throw Error("image failed");
    return false;
  });
  f.service.selections.rotate("main", 1);
  await tick();
  await f.service.execute(f.key.id);
  assert.deepEqual(f.executions, []);
});

test("実行中に設定を変えても、新しい操作を要求中と表示しない", async (t) => {
  const f = await fixture(t);
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "ai",
    body: "old",
    label: "旧操作",
  });
  await tick();
  let finish;
  f.service.executor.execute = async () =>
    await new Promise((resolve) => {
      finish = resolve;
    });
  const running = f.service.execute(f.key.id);
  await tick();
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "new",
    label: "新操作",
  });
  await tick();
  assert.match(f.visible, /旧操作/u);
  assert.doesNotMatch(f.visible, /新操作/u);
  finish({ status: "unknown", message: "mock unknown" });
  await running;
});

test("global取得失敗を旧割当なしと扱わず、移行フラグと旧IDを保存変更しない", async (t) => {
  const f = await fixture(t);
  const initial = { controlId: "main", custom: "keep" };
  const writes = [];
  f.sdk.settings.getGlobalSettings = async () => {
    throw Error("temporary offline");
  };
  f.key.getSettings = async () => initial;
  f.key.setSettings = async (value) => writes.push(value);
  await f.service.initialize();
  await f.service.status.bind(f.key, initial);
  t.after(() => f.service.status.unbind(f.key.id));
  assert.deepEqual(writes, []);
});
