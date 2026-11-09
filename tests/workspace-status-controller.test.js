import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceStatusController } = await loadModule(
  "src/workspace-status-controller.ts",
);
const tick = () => new Promise(setImmediate);
const ws = (id) => ({
  id,
  name: id.toUpperCase(),
  project: "P",
  path: `/${id}`,
  hostId: "local",
  instanceId: id,
  agents: [],
  activity: "inactive",
  terminalVerdict: "none",
});
function fixture(t, saved = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let selected = "a",
    runtimeId = "r",
    failSave = false,
    failRead = false,
    delay,
    onWrite,
    selectionReader,
    referenceReader;
  const listeners = new Set(),
    effects = [],
    images = [],
    errors = [];
  const state = {
    snapshot: {
      runtimeId,
      workspaces: [ws("a"), ws("b")],
      truncated: false,
      omittedHosts: false,
    },
    error: null,
  };
  const monitor = {
    state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    async refresh() {
      return state;
    },
  };
  const client = {
    async selectedWorkspace() {
      if (delay) await delay;
      return selectionReader
        ? selectionReader()
        : { runtimeId, workspace: ws(selected) };
    },
    async snapshot() {
      return { ...state.snapshot, runtimeId };
    },
    async focusWorkspace(id, current) {
      if (delay) await delay;
      if (current()) effects.push(["focus", id]);
      return true;
    },
    async references(id, _r) {
      if (referenceReader) return await referenceReader(id);
      if (delay) await delay;
      return {
        workspaceId: id,
        references: [
          {
            key: "ref",
            url: `https://github.com/acme/app/pull/${id === "a" ? 1 : 2}`,
            type: "pr",
            selected: false,
            label: "PR",
          },
        ],
        unsupportedSelected: false,
      };
    },
  };
  const keys = new Map();
  function key(id, initial = {}) {
    let settings = structuredClone(initial);
    const k = {
      id,
      async setImage(image) {
        images.push([id, decodeURIComponent(image)]);
      },
      async showAlert() {},
      async showOk() {},
      async getSettings() {
        if (failRead) {
          failRead = false;
          throw Error("read failed");
        }
        return structuredClone(settings);
      },
      async setSettings(next) {
        if (failSave) throw Error("save failed");
        settings = structuredClone(next);
        await onWrite?.(next);
      },
      patch(value) {
        settings = { ...settings, ...value };
      },
      get settings() {
        return settings;
      },
    };
    keys.set(id, k);
    return k;
  }
  const controller = new WorkspaceStatusController(
    monitor,
    client,
    async () => saved,
    async (url) => effects.push(["url", url]),
    (id, msg) => errors.push([id, msg]),
  );
  t.after(() => {
    for (const id of keys.keys()) controller.unbind(id);
  });
  return {
    controller,
    key,
    effects,
    images,
    errors,
    async bind(k, s = k.settings) {
      await controller.bind(k, s);
      await tick();
    },
    references(fn) {
      referenceReader = fn;
    },
    onWrite(fn) {
      onWrite = fn;
    },
    selection(fn) {
      selectionReader = fn;
    },
    setSelected(id) {
      selected = id;
    },
    setRuntime(id) {
      runtimeId = id;
    },
    failSave() {
      failSave = true;
    },
    failRead() {
      failRead = true;
    },
    slow(p) {
      delay = p;
    },
    disconnect() {
      state.error = "offline";
      state.snapshot = null;
      for (const fn of listeners) fn(state);
    },
    advance: async (ms) => {
      t.mock.timers.tick(ms);
      await tick();
    },
  };
}
test("未割当は自動選択せず長押し保存確認後だけ登録し移動しない", async (t) => {
  const f = fixture(t),
    k = f.key("x", { custom: "keep" });
  await f.bind(k);
  assert.equal(k.settings.workspace, undefined);
  assert.match(f.images.at(-1)[1], /長押しで登録/);
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.equal(k.settings.workspace.workspaceId, "b");
  assert.equal(k.settings.custom, "keep");
  assert.deepEqual(f.effects, []);
  assert.match(f.images.at(-1)[1], /登録完了/);
});
test("旧IDから各ボタンへ一度移行し再割当/再起動後も独立、globalは不変", async (t) => {
  const saved = {
    workspaceSelections: { main: { workspaceId: "a", workspaceName: "A" } },
    prReviewLaunches: { keep: { status: "unknown" } },
  };
  const before = structuredClone(saved),
    f = fixture(t, saved),
    a = f.key("x", { controlId: "main", custom: 4 }),
    b = f.key("y", { controlId: "main" });
  await f.bind(a);
  await f.bind(b);
  assert.equal(a.settings.workspace.workspaceId, "a");
  assert.equal(b.settings.workspace.workspaceId, "a");
  assert.equal(a.settings.controlId, undefined);
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.equal(a.settings.workspace.workspaceId, "b");
  assert.equal(b.settings.workspace.workspaceId, "a");
  f.controller.unbind("x");
  await f.bind(a);
  assert.equal(a.settings.workspace.workspaceId, "b");
  assert.deepEqual(saved, before);
});
test("短押し/ダブルは割当先のみを操作、長押しと排他", async (t) => {
  const f = fixture(t),
    k = f.key("x", {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    });
  await f.bind(k);
  f.setSelected("b");
  f.controller.down("x");
  f.controller.up("x");
  await f.advance(499);
  assert.deepEqual(f.effects, []);
  await f.advance(1);
  await tick();
  assert.deepEqual(f.effects, [["focus", "a"]]);
  f.controller.down("x");
  f.controller.up("x");
  await f.advance(100);
  f.controller.down("x");
  f.controller.up("x");
  await tick();
  assert.deepEqual(f.effects, [
    ["focus", "a"],
    ["url", "https://github.com/acme/app/pull/1"],
  ]);
});
test("設定変更/離脱/切断で保留操作を破棄し、遅い応答を別WSに差し替えない", async (t) => {
  const f = fixture(t),
    k = f.key("x", {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    });
  await f.bind(k);
  f.controller.down("x");
  f.controller.up("x");
  await f.bind(k, {
    workspaceButtonVersion: 1,
    workspace: { workspaceId: "b", workspaceName: "B" },
  });
  await f.advance(500);
  assert.deepEqual(f.effects, []);
  let release;
  f.slow(
    new Promise((r) => {
      release = r;
    }),
  );
  f.controller.down("x");
  f.controller.up("x");
  await f.advance(500);
  f.controller.unbind("x");
  release();
  await tick();
  assert.deepEqual(f.effects, []);
  await f.bind(k);
  f.controller.down("x");
  f.controller.up("x");
  f.disconnect();
  await f.advance(500);
  assert.deepEqual(f.effects, []);
});
test("長押しの取得中に選択/実行環境変更・保存失敗でも元割当とリンクを保つ", async (t) => {
  const f = fixture(t),
    initial = {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
      reference: {
        workspaceId: "a",
        key: "old",
        url: "https://github.com/acme/app/pull/1",
      },
    },
    k = f.key("x", initial);
  await f.bind(k);
  f.setSelected("b");
  f.failSave();
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.deepEqual(k.settings, initial);
  assert.deepEqual(f.effects, []);
  assert.ok(f.errors.length);
});

test("無関係な最新設定を保持し、保存後の読戻し失敗では元割当を復元", async (t) => {
  const f = fixture(t),
    initial = {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
      custom: "old",
    },
    k = f.key("x", initial);
  await f.bind(k);
  k.patch({ custom: "new", extra: 42 });
  let once = true;
  f.onWrite(() => {
    if (once) {
      once = false;
      f.failRead();
    }
  });
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.equal(k.settings.workspace.workspaceId, "a");
  assert.equal(k.settings.custom, "new");
  assert.equal(k.settings.extra, 42);
  assert.doesNotMatch(f.images.at(-1)[1], /登録完了/);
});
test("保存直前に画面選択WSまたはruntimeが変われば旧割当を維持", async (t) => {
  const f = fixture(t),
    k = f.key("x", {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    });
  await f.bind(k);
  let n = 0;
  f.selection(() => ({
    runtimeId: ++n === 1 ? "r" : "new",
    workspace: ws("b"),
  }));
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.equal(k.settings.workspace.workspaceId, "a");
  assert.deepEqual(f.effects, []);
});
test("保存中の関連先操作を溜めず表示と永続割当を一致させる", async (t) => {
  const f = fixture(t),
    k = f.key("x", {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    });
  await f.bind(k);
  let release;
  f.onWrite(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await f.controller.selectReference("x", "a", "ref");
  release();
  await tick();
  assert.equal(
    (await f.controller.view("x")).workspace.workspaceId,
    k.settings.workspace.workspaceId,
  );
});
test("保存済mainがあっても新規の空設定ボタンは未割当を保つ", async (t) => {
  const f = fixture(t, {
      workspaceSelections: { main: { workspaceId: "a", workspaceName: "A" } },
    }),
    k = f.key("new");
  await f.bind(k);
  assert.equal(k.settings.workspace, undefined);
  assert.match(f.images.at(-1)[1], /長押しで登録/);
});

test("再割当後に旧リンクを消し、遅い旧WSの取得失敗から詳細を復活させない", async (t) => {
  const f = fixture(t),
    k = f.key("x", {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
      reference: {
        workspaceId: "a",
        key: "old",
        url: "https://github.com/acme/app/pull/1",
      },
    });
  await f.bind(k);
  let reject;
  f.references(
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
  );
  const pending = f.controller.view("x");
  await tick();
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.equal(k.settings.workspace.workspaceId, "b");
  assert.equal(k.settings.reference, undefined);
  reject(Error("old WS offline"));
  assert.equal(await pending, undefined);
});
