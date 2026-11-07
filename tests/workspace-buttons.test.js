import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceButtons } = await loadModule("src/workspace-buttons.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (workspaces) => ({
  snapshot: { runtimeId: "r", workspaces, truncated: false },
  error: null,
});
const workspace = (id, name, state) => ({
  id,
  name,
  hostId: "local",
  activity: "active",
  terminalVerdict: "live",
  agents: [{ paneKey: "tab:main", state }],
});
function fixture(client = { focusWorkspace: async () => true }) {
  let listener;
  let unsubscribed = 0;
  const images = [];
  const errors = [];
  const key = {
    id: "key-a",
    setImage: async (image) => {
      images.push(decodeURIComponent(image.slice(image.indexOf(",") + 1)));
    },
    showAlert: async () => {},
  };
  const monitor = {
    subscribe(callback) {
      listener = callback;
      callback({ snapshot: null, error: null });
      return () => {
        unsubscribed++;
      };
    },
  };
  const buttons = new WorkspaceButtons(monitor, client, (id, error) =>
    errors.push({ id, error }),
  );
  return {
    buttons,
    key,
    images,
    errors,
    emit(state) {
      listener?.(state);
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test("選択したワークスペースの入力待ちをキー画像に表示する", async () => {
  const f = fixture();
  f.buttons.bind(f.key, { workspaceId: "a", workspaceName: "A" });
  f.emit(snapshot([workspace("a", "作業 A", "waiting")]));
  await tick();
  assert.match(f.images.at(-1) ?? "", /入力待ち/u);
  assert.match(f.images.at(-1), /作業 A/u);
});

test("一覧順が変わっても固定 ID を維持し、消失時は不明を表示する", async () => {
  const selected = [];
  const f = fixture({
    focusWorkspace: async (id) => {
      selected.push(id);
      return true;
    },
  });
  f.buttons.bind(f.key, { workspaceId: "a", workspaceName: "A" });
  f.emit(
    snapshot([workspace("b", "B", "waiting"), workspace("a", "A", "working")]),
  );
  await tick();
  await f.buttons.press(f.key.id);
  assert.deepEqual(selected, ["a"]);
  f.emit(snapshot([workspace("b", "B", "waiting")]));
  await tick();
  assert.match(f.images.at(-1), /状態不明/u);
});

test("接続失敗では前回の進行中表示を残さない", async () => {
  const f = fixture();
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "A", "working")]));
  await tick();
  f.emit({ snapshot: null, error: "offline" });
  await tick();
  assert.match(f.images.at(-1), /状態不明/u);
});

test("割り当て変更で遅いナビゲーション要求を無効にする", async () => {
  let current;
  const f = fixture({
    focusWorkspace: async (_id, isCurrent) => {
      current = isCurrent;
      return false;
    },
  });
  f.buttons.bind(f.key, { workspaceId: "a" });
  await f.buttons.press(f.key.id);
  assert.equal(current?.(), true);
  f.buttons.bind(f.key, { workspaceId: "b" });
  assert.equal(current(), false);
  f.buttons.unbind(f.key.id);
  assert.equal(f.unsubscribed, 2);
});

test("キー画像へワークスペース名を XML として挿入しない", async () => {
  const f = fixture();
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "<script>&", "done")]));
  await tick();
  assert.doesNotMatch(f.images.at(-1) ?? "", /<script>/u);
  assert.match(f.images.at(-1) ?? "", /&lt;script/u);
});

test("別のキーを押した後に古い要求で画面を奪わない", async () => {
  const guards = [];
  const f = fixture({
    focusWorkspace: async (_id, current) => {
      guards.push(current);
      return false;
    },
  });
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.buttons.bind({ ...f.key, id: "key-b" }, { workspaceId: "b" });
  await f.buttons.press("key-a");
  await f.buttons.press("key-b");
  assert.equal(guards[0](), false);
  assert.equal(guards[1](), true);
});

test("進行中だけキー画像が連続して変わり、入力待ちになると止まる", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  t.after(() => f.buttons.unbind(f.key.id));
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "作業 A", "working")]));
  await tick();
  const initial = f.images.at(-1);
  t.mock.timers.tick(100);
  await tick();
  assert.notEqual(f.images.at(-1), initial, "進行中の画像が動く");
  assert.match(f.images.at(-1), /作業 A/u);
  assert.match(f.images.at(-1), /進行中/u);
  f.emit(snapshot([workspace("a", "作業 A", "waiting")]));
  await tick();
  const stopped = f.images.length;
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal(f.images.length, stopped, "入力待ちの画像を繰り返し送信しない");
  assert.match(f.images.at(-1), /入力待ち/u);
});

test("接続失敗・キー消失・割り当て変更で以前のアニメーションを止める", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  t.after(() => f.buttons.unbind(f.key.id));
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "A", "working")]));
  await tick();
  t.mock.timers.tick(100);
  await tick();
  assert.ok(new Set(f.images).size > 1, "進行中のフレームが更新される");
  f.emit({ snapshot: null, error: "offline" });
  await tick();
  let stopped = f.images.length;
  t.mock.timers.tick(500);
  await tick();
  assert.equal(f.images.length, stopped);
  assert.match(f.images.at(-1), /状態不明/u);
  f.emit(snapshot([workspace("a", "A", "working")]));
  await tick();
  f.buttons.unbind(f.key.id);
  stopped = f.images.length;
  t.mock.timers.tick(500);
  await tick();
  assert.equal(f.images.length, stopped);
  f.buttons.bind(f.key, { workspaceId: "b", workspaceName: "B" });
  f.emit(
    snapshot([workspace("a", "A", "working"), workspace("b", "B", "done")]),
  );
  await tick();
  stopped = f.images.length;
  t.mock.timers.tick(500);
  await tick();
  assert.equal(f.images.length, stopped);
  assert.match(f.images.at(-1), />B<|返答あり/u);
});

test("画像送信が遅くてもフレームを溜めず、切り替え後に古い表示を送らない", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  t.after(() => f.buttons.unbind(f.key.id));
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "A", "working")]));
  await tick();
  const original = f.key.setImage;
  let finish;
  f.key.setImage = async (image) => {
    await original(image);
    await new Promise((resolve) => {
      finish = resolve;
    });
  };
  const start = f.images.length;
  t.mock.timers.tick(100);
  await tick();
  assert.equal(f.images.length, start + 1, "アニメーションの送信が始まる");
  t.mock.timers.tick(5_000);
  await tick();
  assert.equal(
    f.images.length,
    start + 1,
    "遅い送信が終わるまで次のフレームを送らない",
  );
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  f.key.setImage = original;
  finish();
  await tick();
  const waiting = f.images.length;
  assert.match(f.images.at(-1), /入力待ち/u);
  t.mock.timers.tick(1_000);
  await tick();
  assert.equal(f.images.length, waiting);
});
