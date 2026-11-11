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
    referenceReader,
    urlHandler;
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
  const cliSnapshot = structuredClone(state.snapshot);
  const monitor = {
    state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    async refresh() {
      return monitor.state;
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
      return { ...cliSnapshot, runtimeId };
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
        instanceId: id,
        hostId: "local",
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
    async (url) => {
      effects.push(["url", url]);
      await urlHandler?.(url);
    },
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
    openUrl(fn) {
      urlHandler = fn;
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
    monitorState(value) {
      monitor.state = value;
      for (const fn of listeners) fn(value);
    },
    monitorSnapshot(value) {
      state.snapshot = value;
      for (const fn of listeners) fn(state);
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
  assert.match(f.images.at(-1)[1], /未割当/);
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  await tick();
  assert.equal(k.settings.workspace.workspaceId, "b");
  assert.equal(k.settings.custom, "keep");
  assert.deepEqual(f.effects, []);
  assert.match(f.images.at(-1)[1], /登録済/);
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
test("待機中のOrca再起動では環境変更を出さず、既存キーの割当・移動・再登録を保つ", async (t) => {
  const f = fixture(t),
    initial = {
      workspaceButtonVersion: 1,
      workspace: {
        workspaceId: "a",
        workspaceName: "A",
        instanceId: "a",
        hostId: "local",
      },
    },
    k = f.key("x", initial);
  await f.bind(k);
  const start = f.images.length;
  f.setRuntime("restarted");
  f.monitorState({
    snapshot: {
      runtimeId: "restarted",
      workspaces: [ws("a"), ws("b")],
      truncated: false,
    },
    error: null,
  });
  await tick();
  assert.deepEqual(k.settings, initial);
  assert.ok(
    f.images.slice(start).every(([, image]) => !image.includes("環境変更")),
  );
  f.controller.down("x");
  f.controller.up("x");
  await f.advance(500);
  assert.deepEqual(f.effects, [["focus", "a"]]);
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  assert.equal(k.settings.workspace.workspaceId, "b");
  assert.match(f.images.at(-1)[1], /登録済/);
});

for (const runtimeId of ["r", "restarted"]) {
  test(`起動時の接続失敗から${runtimeId}へ復帰したら既存キーの警告を解消する`, async (t) => {
    const f = fixture(t),
      initial = {
        workspaceButtonVersion: 1,
        workspace: { workspaceId: "a", workspaceName: "A" },
      },
      k = f.key("x", initial);
    await f.bind(k);
    f.disconnect();
    await tick();
    assert.match(f.images.at(-1)[1], /取得失敗/);
    f.setRuntime(runtimeId);
    f.monitorState({
      snapshot: { runtimeId, workspaces: [ws("a"), ws("b")], truncated: false },
      error: null,
    });
    await tick();
    assert.match(f.images.at(-1)[1], /待機/);
    assert.doesNotMatch(f.images.at(-1)[1], /取得失敗|環境変更/);
    assert.deepEqual(k.settings, initial);
    assert.deepEqual(f.effects, []);
    f.controller.down("x");
    f.controller.up("x");
    await f.advance(500);
    assert.deepEqual(f.effects, [["focus", "a"]]);
  });
}

test("押下中の再起動は操作を中止し、警告を解消して同じキーの次の長押しを受け付ける", async (t) => {
  const f = fixture(t),
    initial = {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "a", workspaceName: "A" },
    },
    k = f.key("x", initial);
  await f.bind(k);
  f.controller.down("x");
  f.setRuntime("restarted");
  f.monitorState({
    snapshot: {
      runtimeId: "restarted",
      workspaces: [ws("a"), ws("b")],
      truncated: false,
    },
    error: null,
  });
  await tick();
  assert.match(f.images.at(-1)[1], /環境変更/);
  f.controller.up("x");
  await f.advance(2_000);
  assert.deepEqual(f.effects, []);
  assert.deepEqual(k.settings, initial);
  assert.match(f.images.at(-1)[1], /待機/);
  f.setSelected("b");
  f.controller.down("x");
  await f.advance(700);
  f.controller.up("x");
  assert.equal(k.settings.workspace.workspaceId, "b");
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
  assert.doesNotMatch(f.images.at(-1)[1], /登録済/);
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
  f.controller.down("x");
  f.controller.up("x");
  f.controller.down("x");
  f.controller.up("x");
  release();
  await tick();
  assert.equal(
    (await f.controller.view("x")).workspace.workspaceId,
    k.settings.workspace.workspaceId,
  );
  assert.deepEqual(f.effects, []);
});
test("保存済mainがあっても新規の空設定ボタンは未割当を保つ", async (t) => {
  const f = fixture(t, {
      workspaceSelections: { main: { workspaceId: "a", workspaceName: "A" } },
    }),
    k = f.key("new");
  await f.bind(k);
  assert.equal(k.settings.workspace, undefined);
  assert.match(f.images.at(-1)[1], /未割当/);
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

const batchRefs = (id = "a", numbers = [1, 2, 3]) => ({
  workspaceId: id,
  instanceId: id,
  hostId: "local",
  references: numbers.map((n, i) => ({
    key: `k${n}`,
    type: i ? "pr" : "issue",
    url: `https://github.com/acme/app/${i ? "pull" : "issues"}/${n}`,
    label: `Ref ${n}`,
    selected: i === 0,
  })),
  unsupportedSelected: false,
});
const assigned = () => ({
  workspaceButtonVersion: 1,
  workspace: { workspaceId: "a", workspaceName: "A" },
  reference: {
    workspaceId: "a",
    key: "deleted",
    url: "https://github.com/acme/app/pull/99",
  },
});
const double = async (f) => {
  f.controller.down("x");
  f.controller.up("x");
  await f.advance(100);
  f.controller.down("x");
  f.controller.up("x");
  await tick();
  await tick();
};
test("ダブルは割当WSのPRとIssueを全件開き、旧選択設定とアクティブWSでは絞らない", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned());
  await f.bind(k);
  f.setSelected("b");
  const data = batchRefs();
  data.references.push({ ...data.references[1], key: "dup" });
  f.references(async (id) => {
    assert.equal(id, "a");
    return data;
  });
  await double(f);
  assert.deepEqual(
    f.effects,
    batchRefs().references.map((r) => ["url", r.url]),
  );
  assert.equal(k.settings.reference.key, "deleted");
  assert.match((await f.controller.view("x")).notice, /3/u);
});
test("関連先一覧の順序変更は許容し、追加・消失・URL変更では一件も開かない", async (t) => {
  for (const kind of ["reorder", "added", "removed", "changed"]) {
    const f = fixture(t),
      k = f.key("x", assigned());
    await f.bind(k);
    let reads = 0;
    f.references(async () => {
      const d = batchRefs();
      if (++reads > 1) {
        if (kind === "reorder") d.references.reverse();
        if (kind === "added")
          d.references.push({
            ...d.references[1],
            key: "new",
            url: "https://github.com/acme/app/pull/4",
          });
        if (kind === "removed") d.references.pop();
        if (kind === "changed")
          d.references[1].url = "https://github.com/acme/app/pull/4";
      }
      return d;
    });
    await double(f);
    assert.equal(f.effects.length, kind === "reorder" ? 3 : 0, kind);
    t.mock.timers.reset();
  }
});
test("一件の送信結果が不明でも別URLは一回ずつ試し、結果不明と未送信を分ける", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned());
  await f.bind(k);
  f.references(async () => batchRefs());
  f.openUrl(async (url) => {
    if (url.endsWith("/2")) throw Error("browser response lost");
  });
  await double(f);
  assert.equal(f.effects.length, 3);
  const view = await f.controller.view("x");
  assert.equal(view.linkResult.requested.length, 2);
  assert.equal(view.linkResult.unconfirmed.length, 1);
  assert.equal(view.linkResult.notRequested.length, 0);
  assert.match(view.error, /確認でき/u);
});
test("一件目の遅い送信中の再割当・離脱・切断では残りを開かず連打も溜めない", async (t) => {
  for (const kind of ["rebind", "leave", "disconnect"]) {
    const f = fixture(t),
      k = f.key("x", assigned());
    await f.bind(k);
    f.references(async () => batchRefs());
    let release;
    f.openUrl(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await double(f);
    assert.equal(f.effects.length, 1);
    f.controller.down("x");
    f.controller.up("x");
    if (kind === "rebind")
      await f.bind(k, {
        workspaceButtonVersion: 1,
        workspace: { workspaceId: "b", workspaceName: "B" },
      });
    if (kind === "leave") f.controller.unbind("x");
    if (kind === "disconnect") f.disconnect();
    release();
    await tick();
    await f.advance(1000);
    assert.equal(f.effects.length, 1, kind);
    if (kind === "rebind")
      assert.equal((await f.controller.view("x")).linkResult, undefined);
    t.mock.timers.reset();
  }
});
test("最終参照応答のWS実体またはhostが違う場合は開かない", async (t) => {
  for (const patch of [{ instanceId: "recreated" }, { hostId: "remote" }]) {
    const initial = assigned();
    delete initial.reference;
    const f = fixture(t),
      k = f.key("x", initial);
    await f.bind(k);
    let reads = 0;
    f.references(async () => ({
      ...batchRefs(),
      ...(++reads > 1 ? patch : {}),
    }));
    await double(f);
    assert.deepEqual(f.effects, []);
    t.mock.timers.reset();
  }
});

test("監視未取得で開始しても最初に検証したruntimeへ固定し、別runtimeへの残り送信を止める", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned());
  f.monitorSnapshot(null);
  await f.bind(k);
  f.references(async () => batchRefs());
  let release;
  f.openUrl(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await double(f);
  assert.equal(f.effects.length, 1);
  f.monitorSnapshot({
    runtimeId: "r2",
    workspaces: [ws("a"), ws("b")],
    truncated: false,
  });
  release();
  await tick();
  await tick();
  assert.equal(f.effects.length, 1);
});
test("最後のURL送信中の操作中止でも取得中表示を残さず、送信済みと中止を両方示す", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned()),
    other = f.key("y", {
      workspaceButtonVersion: 1,
      workspace: { workspaceId: "b", workspaceName: "B" },
    });
  await f.bind(k);
  await f.bind(other);
  f.references(async () => batchRefs("a", [1]));
  let release;
  f.openUrl(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await double(f);
  f.controller.down("y");
  f.controller.up("y");
  await f.advance(500);
  release();
  await tick();
  await tick();
  const view = await f.controller.view("x");
  assert.equal(view.linkResult.requested.length, 1);
  assert.equal(view.linkResult.notRequested.length, 0);
  assert.equal(view.linkResult.cancelled, true);
  assert.match(f.images.filter(([id]) => id === "x").at(-1)[1], />中止</u);
});

test("遅い一覧取得の後も最新の起動結果と処理中状態を返し、記録なしへ戻さない", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned());
  await f.bind(k);
  let release,
    reads = 0;
  f.references(async () =>
    ++reads === 1
      ? await new Promise((resolve) => {
          release = () => resolve(batchRefs());
        })
      : batchRefs(),
  );
  const pending = f.controller.view("x");
  await tick();
  await double(f);
  release();
  assert.equal((await pending).linkResult.requested.length, 3);
});
test("送信中の結果は進行中と総件数を持ち、完了済み0件にしない", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned());
  await f.bind(k);
  f.references(async () => batchRefs());
  let release;
  f.openUrl(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await double(f);
  const view = await f.controller.view("x");
  assert.equal(view.linkResult.inProgress, true);
  assert.equal(view.linkResult.total, 3);
  assert.equal(view.ready, false);
  f.controller.unbind("x");
  release();
  await tick();
});

test("新しいダブル操作の進行中へ前回の部分失敗を混ぜない", async (t) => {
  const f = fixture(t),
    k = f.key("x", assigned());
  await f.bind(k);
  f.references(async () => batchRefs());
  f.openUrl(async () => {
    throw Error("previous batch failed");
  });
  await double(f);
  assert.ok((await f.controller.view("x")).error);
  let release;
  f.openUrl(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await double(f);
  const view = await f.controller.view("x");
  assert.equal(view.error, null);
  assert.equal(view.linkResult.inProgress, true);
  f.controller.unbind("x");
  release();
  await tick();
});

for (const kind of ["offline", "runtime"]) {
  test(`遅いPI一覧応答の間に${kind}へ変わった場合は古い関連先を確認済みとして出さない`, async (t) => {
    const f = fixture(t),
      k = f.key("x", assigned());
    await f.bind(k);
    let release;
    f.references(
      () =>
        new Promise((resolve) => {
          release = () => resolve(batchRefs());
        }),
    );
    const pending = f.controller.view("x");
    await tick();
    f.monitorState(
      kind === "offline"
        ? { snapshot: null, error: "offline" }
        : {
            snapshot: {
              runtimeId: "r2",
              workspaces: [ws("a")],
              truncated: false,
            },
            error: null,
          },
    );
    release();
    const view = await pending;
    assert.deepEqual(view.references, []);
    assert.equal(view.ready, false);
    assert.ok(view.error || view.linkError);
  });
}
