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
