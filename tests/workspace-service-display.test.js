import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t) {
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
            contents: "export default {logger:{warn(){}},ui:{},settings:{}};",
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(
    module,
    module.exports,
    createRequire(import.meta.url),
  );
  const service = module.exports.workspaceService;
  const rows = ["A", "B"].map((id) => ({
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
    main: { workspaceId: "A", workspaceName: "A" },
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

test("明示的なダイヤル更新待ちでも、実際の対象名の表示完了までは実行しない", async (t) => {
  const f = await fixture(t);
  f.service.bindCommand(f.key, {
    controlId: "main",
    mode: "shell",
    body: "test",
  });
  f.service.bindDial({ id: "dial", async setFeedback() {} }, "main");
  t.after(() => f.service.unbind("dial"));
  await tick();
  f.block((s) => s.includes(">B</text>"));
  const rotate = f.service.rotate("dial", 1);
  const execute = f.service.execute(f.key.id);
  await tick();
  await tick();
  assert.deepEqual(f.executions, []);
  await f.release();
  await rotate;
  await execute;
  assert.deepEqual(f.executions, [{ id: "B", body: "test" }]);
  assert.match(f.visible, />B<\/text>/u);
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

for (const kind of ["status", "command"]) {
  test(`${kind}: 選択取得待ちの押下後に追加ダイヤルが来たら、新しい対象へ追従しない`, async (t) => {
    const f = await fixture(t);
    const opened = [];
    f.service.client.focusWorkspace = async (id) => {
      opened.push(id);
      return true;
    };
    if (kind === "status") f.service.bindKey(f.key, "main");
    else
      f.service.bindCommand(f.key, {
        controlId: "main",
        mode: "shell",
        body: "test",
      });
    f.service.bindDial({ id: "dial", async setFeedback() {} }, "main");
    t.after(() => f.service.unbind("dial"));
    await tick();
    const previous = f.service.monitor.state.snapshot;
    let release;
    f.service.client.snapshot = async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        ...previous,
        workspaces: [
          ...previous.workspaces,
          { ...previous.workspaces[1], id: "C", name: "C", path: "/C" },
        ],
      };
    };
    const first = f.service.rotate("dial", 1);
    const press =
      kind === "status"
        ? f.service.press(f.key.id)
        : f.service.execute(f.key.id);
    const second = f.service.rotate("dial", 1);
    release();
    await Promise.all([first, press, second]);
    assert.deepEqual(opened, []);
    assert.deepEqual(f.executions, []);
  });
}

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

for (const kind of ["status", "command"]) {
  test(`${kind}: 一覧取得と画像の共通期限を過ぎた旧押下は、遅い取得後も作用しない`, async (t) => {
    const f = await fixture(t);
    const opened = [];
    f.service.client.focusWorkspace = async (id) => {
      opened.push(id);
      return true;
    };
    if (kind === "status") f.service.bindKey(f.key, "main");
    else
      f.service.bindCommand(f.key, {
        controlId: "main",
        mode: "shell",
        body: "test",
      });
    f.service.bindDial({ id: "dial", async setFeedback() {} }, "main");
    t.after(() => f.service.unbind("dial"));
    await tick();
    const snapshot = f.service.monitor.state.snapshot;
    let release;
    f.service.client.snapshot = async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return snapshot;
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const rotate = f.service.rotate("dial", 1);
    const press =
      kind === "status"
        ? f.service.press(f.key.id)
        : f.service.execute(f.key.id);
    let settled = false;
    void press.then(() => {
      settled = true;
    });
    await tick();
    t.mock.timers.tick(2000);
    await tick();
    assert.equal(settled, true, "旧押下の待機は共通期限で終わる");
    release();
    await Promise.all([rotate, press]);
    await tick();
    assert.deepEqual(opened, []);
    assert.deepEqual(f.executions, []);
  });
}
