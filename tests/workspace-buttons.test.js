import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceButtons, keyImage } = await loadModule(
  "src/workspace-buttons.ts",
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const snapshot = (workspaces) => ({
  snapshot: {
    runtimeId: "r",
    workspaces,
    truncated: false,
    omittedHosts: false,
    hostIds: ["local"],
  },
  error: null,
});
const references = (id, types) => ({
  workspaceId: id,
  hostId: "local",
  references: types.map((type, i) => ({
    key: `${type}-${i}`,
    type,
    url: `https://github.com/acme/app/${type === "pr" ? "pull" : "issues"}/${i + 1}`,
    label: type,
  })),
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
  const buttons = new WorkspaceButtons(
    monitor,
    { references: async (id) => references(id, []), ...client },
    (id, error) => errors.push({ id, error }),
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

test("未確認・初回取得中・失敗・復帰を別表示にし、WSの状態は保つ", async () => {
  let resolve, reject;
  const f = fixture({
    references: () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  });
  f.buttons.bind(f.key, { workspaceId: "a" });
  await tick();
  const unknown = f.images.at(-1);
  assert.match(unknown, /data-reference-status="unknown"/u);
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  const loading = f.images.at(-1);
  assert.match(loading, /data-reference-status="loading"/u);
  assert.match(loading, />↻<\/text>/u);
  reject(Error("offline"));
  await tick();
  const failed = f.images.at(-1);
  assert.match(failed, /data-reference-status="error"/u);
  assert.match(failed, />!<\/text>/u);
  assert.doesNotMatch(failed, /data-reference-state="(?:linked|unlinked)"/u);
  assert.match(failed, /入力待ち/u);
  assert.notEqual(unknown, loading);
  assert.notEqual(loading, failed);
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  resolve(references("a", ["issue", "pr"]));
  await tick();
  assert.match(f.images.at(-1), /data-reference-status="ready"/u);
  assert.match(
    f.images.at(-1),
    /data-reference="pr" data-reference-state="linked"/u,
  );
  f.buttons.unbind(f.key.id);
});

test("遅い再取得では300ms後に前回値へ更新印を添え、失敗・再試行・復帰を示す", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reader = async (id) => references(id, ["issue", "pr"]),
    resolve,
    reject;
  const f = fixture({ references: (id) => reader(id) });
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  const ready = f.images.at(-1);
  reader = () =>
    new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  t.mock.timers.tick(299);
  await tick();
  assert.equal(f.images.at(-1), ready);
  t.mock.timers.tick(1);
  await tick();
  assert.match(f.images.at(-1), /data-reference-status="loading"/u);
  assert.match(
    f.images.at(-1),
    /data-reference="pr" data-reference-state="linked"/u,
  );
  assert.match(f.images.at(-1), />↻<\/text>/u);
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  assert.match(f.images.at(-1), /data-reference-status="loading"/u);
  reject(Error("offline"));
  await tick();
  const failed = f.images.at(-1);
  assert.match(failed, /data-reference-status="error"/u);
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  assert.equal(f.images.at(-1), failed);
  t.mock.timers.tick(300);
  await tick();
  assert.match(f.images.at(-1), /data-reference-status="loading"/u);
  resolve(references("a", []));
  await tick();
  assert.match(f.images.at(-1), /data-reference-status="ready"/u);
  assert.match(
    f.images.at(-1),
    /data-reference="pr" data-reference-state="unlinked"/u,
  );
  f.buttons.unbind(f.key.id);
});

test("速い定期更新は更新印を点滅させず、完了後に遅延タイマーも発火しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reader = async (id) => references(id, ["pr"]),
    resolve;
  const f = fixture({ references: (id) => reader(id) });
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  const count = f.images.length;
  reader = () =>
    new Promise((yes) => {
      resolve = yes;
    });
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  t.mock.timers.tick(200);
  resolve(references("a", ["pr"]));
  await tick();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(f.images.length, count);
  assert.match(f.images.at(-1), /data-reference-status="ready"/u);
  f.buttons.unbind(f.key.id);
});

for (const change of [
  "assignment",
  "runtime",
  "incomplete",
  "offline",
  "unbind",
]) {
  test(`遅い再取得のタイマーを${change}変更後の表示へ漏らさない`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reader = async (id) => references(id, ["pr"]);
    const f = fixture({ references: (id) => reader(id) });
    f.buttons.bind(f.key, { workspaceId: "a" });
    f.emit(snapshot([workspace("a", "A", "waiting")]));
    await tick();
    reader = () => new Promise(() => {});
    f.emit(snapshot([workspace("a", "A", "waiting")]));
    await tick();
    if (change === "assignment") f.buttons.bind(f.key, {});
    else if (change === "unbind") f.buttons.unbind(f.key.id);
    else if (change === "offline") f.emit({ snapshot: null, error: "offline" });
    else {
      const next = snapshot([workspace("a", "A", "waiting")]);
      if (change === "runtime") next.snapshot.runtimeId = "new";
      else next.snapshot.truncated = true;
      f.emit(next);
    }
    await tick();
    const count = f.images.length;
    t.mock.timers.tick(1000);
    await tick();
    assert.equal(f.images.length, count);
    f.buttons.unbind(f.key.id);
  });
}

test("Issue/PRの形は小型表示でも線と中心点が潰れにくい寸法にする", () => {
  const image = decodeURIComponent(
    keyImage("関連表示の確認", "waiting", 0, { project: "sateto" }, undefined, {
      issue: true,
      pr: true,
    }),
  );
  // 72pxでは1/2縮小される。22px原画の図形・太線を確保し、28pxのWS名は保つ。
  for (const type of ["issue", "pr"]) {
    assert.match(
      image,
      new RegExp(
        `data-icon="${type}"[^>]*scale\\(0\\.9166666666666666\\)"[^>]*stroke-width="3"`,
        "u",
      ),
    );
  }
  assert.match(image, /cx="12" cy="12" r="2\.75"/u);
  assert.match(image, /font-size="28"/u);
  assert.match(image, /入力待ち/u);
});

for (const types of [[], ["issue"], ["pr"], ["issue", "pr"]]) {
  test(`関連先${JSON.stringify(types)}をIssueとPRの別アイコンへ反映する`, async () => {
    const f = fixture({ references: async (id) => references(id, types) });
    f.buttons.bind(f.key, { workspaceId: "a" });
    f.emit(snapshot([workspace("a", "作業 A", "waiting")]));
    await tick();
    const image = f.images.at(-1);
    for (const type of ["issue", "pr"]) {
      assert.match(
        image,
        new RegExp(
          `data-reference="${type}" data-reference-state="${types.includes(type) ? "linked" : "unlinked"}"`,
          "u",
        ),
      );
      assert.match(image, new RegExp(`data-icon="${type}"`, "u"));
    }
    assert.match(image, /作業 A/u);
    assert.match(image, /入力待ち/u);
    f.buttons.unbind(f.key.id);
  });
}

test("関連先の追加・削除を更新し、取得失敗は関連なしと区別して復帰できる", async () => {
  let types = ["issue"],
    fail = false;
  const f = fixture({
    async references(id) {
      if (fail) throw Error("offline");
      return references(id, types);
    },
  });
  f.buttons.bind(f.key, { workspaceId: "a" });
  const refresh = async () => {
    f.emit(snapshot([workspace("a", "A", "waiting")]));
    await tick();
    return f.images.at(-1);
  };
  assert.match(
    await refresh(),
    /data-reference="issue" data-reference-state="linked"/u,
  );
  types = ["pr"];
  assert.match(
    await refresh(),
    /data-reference="issue" data-reference-state="unlinked"/u,
  );
  fail = true;
  const failed = await refresh();
  assert.match(failed, /data-reference="pr" data-reference-state="unknown"/u);
  assert.doesNotMatch(failed, /data-reference-state="unlinked"/u);
  fail = false;
  assert.match(
    await refresh(),
    /data-reference="pr" data-reference-state="linked"/u,
  );
  f.emit({ snapshot: null, error: "offline" });
  await tick();
  assert.match(
    f.images.at(-1),
    /data-reference="pr" data-reference-state="unknown"/u,
  );
  assert.deepEqual(f.errors, []);
  f.buttons.unbind(f.key.id);
});

for (const change of ["assignment", "runtime", "instance", "host", "unbind"]) {
  test(`遅い関連先応答を${change}変更後のキーに反映しない`, async () => {
    let release;
    const f = fixture({
      references: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    f.buttons.bind(f.key, { workspaceId: "a" });
    f.emit(snapshot([workspace("a", "A", "waiting")]));
    await tick();
    const complete = release;
    if (change === "assignment") {
      f.buttons.bind(f.key, { workspaceId: "b" });
      f.emit(snapshot([workspace("b", "B", "waiting")]));
    } else if (change === "unbind") {
      f.buttons.unbind(f.key.id);
    } else {
      const next = snapshot([workspace("a", "A", "waiting")]);
      if (change === "runtime") next.snapshot.runtimeId = "r2";
      else next.snapshot.workspaces[0][`${change}Id`] = "changed";
      f.emit(next);
    }
    await tick();
    const count = f.images.length;
    complete(references("a", ["issue", "pr"]));
    await tick();
    assert.equal(f.images.length, count);
    assert.doesNotMatch(f.images.at(-1), /data-reference-state="linked"/u);
    f.buttons.unbind(f.key.id);
  });
}

for (const mismatch of ["workspaceId", "instanceId", "hostId"]) {
  test(`関連先応答の${mismatch}不一致を未確認として表示する`, async () => {
    const f = fixture({
      references: async (id) => ({
        ...references(id, ["issue", "pr"]),
        instanceId: "original",
        [mismatch]: "wrong",
      }),
    });
    f.buttons.bind(f.key, { workspaceId: "a" });
    f.emit(
      snapshot([{ ...workspace("a", "A", "waiting"), instanceId: "original" }]),
    );
    await tick();
    assert.match(
      f.images.at(-1),
      /data-reference="issue" data-reference-state="unknown"/u,
    );
    assert.doesNotMatch(f.images.at(-1), /data-reference-state="linked"/u);
    f.buttons.unbind(f.key.id);
  });
}

test("未割当・不完全一覧・保存対象と違う実体から関連アイコンを確定しない", async () => {
  let calls = 0;
  const f = fixture({
    references: async (id) => {
      calls++;
      return references(id, ["pr"]);
    },
  });
  f.buttons.bind(f.key, {});
  f.emit(snapshot([workspace("a", "A", "waiting")]));
  await tick();
  assert.doesNotMatch(f.images.at(-1), /data-reference=/u);
  f.buttons.bind(f.key, { workspaceId: "a", instanceId: "original" });
  for (const extra of [
    { truncated: true },
    { omittedHosts: true },
    { hostIds: [] },
    { fromCache: true },
    {},
  ]) {
    const state = snapshot([
      { ...workspace("a", "A", "waiting"), instanceId: "original" },
    ]);
    if (extra.fromCache) state.fromCache = true;
    else Object.assign(state.snapshot, extra);
    if (!Object.keys(extra).length)
      state.snapshot.workspaces[0].instanceId = "new";
    f.emit(state);
    await tick();
    assert.match(
      f.images.at(-1),
      /data-reference="pr" data-reference-state="unknown"/u,
    );
  }
  assert.equal(calls, 0);
  f.buttons.unbind(f.key.id);
});

test("同じ一覧・WSの複数キーは関連先の取得を共有する", async () => {
  let calls = 0;
  const f = fixture({
    references: async (id) => {
      calls++;
      return references(id, ["pr"]);
    },
  });
  const state = snapshot([workspace("a", "A", "waiting")]);
  f.buttons.bind(f.key, { workspaceId: "a" });
  f.emit(state);
  await tick();
  f.buttons.bind({ ...f.key, id: "mirror" }, { workspaceId: "a" });
  f.emit(state);
  await tick();
  assert.equal(calls, 1);
  assert.match(
    f.images.at(-1),
    /data-reference="pr" data-reference-state="linked"/u,
  );
  f.buttons.unbind(f.key.id);
  f.buttons.unbind("mirror");
});

test("定期更新より遅い関連先読取も重複させず、完了した結果を表示する", async () => {
  let release,
    calls = 0;
  const f = fixture({
    references: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  f.buttons.bind(f.key, { workspaceId: "a" });
  for (let i = 0; i < 3; i++) {
    f.emit(snapshot([workspace("a", "A", "waiting")]));
    await tick();
  }
  assert.equal(calls, 1);
  release(references("a", ["issue", "pr"]));
  await tick();
  assert.match(
    f.images.at(-1),
    /data-reference="issue" data-reference-state="linked"/u,
  );
  f.buttons.unbind(f.key.id);
});

test("選択したワークスペースの入力待ちをキー画像に表示する", async () => {
  const f = fixture();
  f.buttons.bind(f.key, { workspaceId: "a", workspaceName: "A" });
  f.emit(snapshot([workspace("a", "作業 A", "waiting")]));
  await tick();
  assert.match(f.images.at(-1) ?? "", /入力待ち/u);
  assert.match(f.images.at(-1), /作業 A/u);
});

test("実一覧からプロジェクトを表示し、対象消失では取得済みとせず短タグも表示しない", async () => {
  const f = fixture();
  f.buttons.bind(f.key, { workspaceId: "a", workspaceName: "main" });
  f.emit(
    snapshot([{ ...workspace("a", "main", "waiting"), project: "sateto" }]),
  );
  await tick();
  assert.match(f.images.at(-1), /sateto/u);
  const { workspaceTag } = await loadModule("src/attention-image.ts");
  assert.ok(!f.images.at(-1).includes(workspaceTag("a")));
  f.emit({ snapshot: null, error: "offline" });
  await tick();
  assert.doesNotMatch(f.images.at(-1), /sateto/u);
  assert.ok(!f.images.at(-1).includes(workspaceTag("a")));
  assert.match(f.images.at(-1), /状態不明/u);
});

test("短タグ衝突と同名が重なる既知一覧では、状態キーに照合を促して移動しない", async () => {
  const opens = [];
  const f = fixture({
    async focusWorkspace(id) {
      opens.push(id);
      return true;
    },
  });
  const ids = ["collision-11vsk8p-13317", "collision-1c0e837-25368"];
  f.buttons.bind(f.key, { workspaceId: ids[0], workspaceName: "main" });
  f.emit(
    snapshot(
      ids.map((id) => ({ ...workspace(id, "main", "waiting"), project: "P" })),
    ),
  );
  await tick();
  assert.match(f.images.at(-1), /要照合/u);
  await f.buttons.press(f.key.id);
  assert.deepEqual(opens, []);
  assert.match(f.errors[0]?.error ?? "", /完全ID.*パス/u);
});

test("XML除去される文字だけが違う同タグの名前でも、状態キーから移動しない", async () => {
  const opens = [];
  const f = fixture({
    async focusWorkspace(id) {
      opens.push(id);
      return true;
    },
  });
  const ids = ["collision-11vsk8p-13317", "collision-1c0e837-25368"];
  f.buttons.bind(f.key, { workspaceId: ids[0] });
  f.emit(
    snapshot(
      ids.map((id, i) => ({
        ...workspace(id, i ? "ma\u0001in" : "main", "waiting"),
        project: "P",
      })),
    ),
  );
  await tick();
  await f.buttons.press(f.key.id);
  assert.deepEqual(opens, []);
});

for (const names of [
  ["a b", "a  b"],
  ["e\u0301", "é"],
]) {
  test(`表示用正規化で同じになる${JSON.stringify(names)}の同タグ対象へ状態キーで移動しない`, async () => {
    const opens = [];
    const f = fixture({
      async focusWorkspace(id) {
        opens.push(id);
        return true;
      },
    });
    const ids = ["collision-11vsk8p-13317", "collision-1c0e837-25368"];
    f.buttons.bind(f.key, { workspaceId: ids[0] });
    f.emit(
      snapshot(
        ids.map((id, i) => ({
          ...workspace(id, names[i], "waiting"),
          project: "P",
        })),
      ),
    );
    await tick();
    await f.buttons.press(f.key.id);
    assert.deepEqual(opens, []);
    assert.match(f.images.at(-1), /要照合/u);
  });
}

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
  await tick();
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
  await tick();
  await f.buttons.press("key-a");
  await f.buttons.press("key-b");
  assert.equal(guards[0](), false);
  assert.equal(guards[1](), true);
});

test("A表示中に割当Bの画像送信が遅れても、押下で見えていないBを開かない", async () => {
  const opened = [];
  const f = fixture({
    focusWorkspace: async (id) => {
      opened.push(id);
      return true;
    },
  });
  let release;
  let visible;
  const key = {
    ...f.key,
    setImage: async (image) => {
      const s = decodeURIComponent(image);
      if (s.includes(">B</text>"))
        await new Promise((resolve) => {
          release = resolve;
        });
      visible = s;
    },
  };
  f.buttons.bind(key, { workspaceId: "a", workspaceName: "A" });
  await tick();
  f.buttons.bind(key, { workspaceId: "b", workspaceName: "B" });
  await tick();
  assert.match(visible, />A<\/text>/u);
  await f.buttons.press(key.id);
  assert.deepEqual(opened, []);
  release();
  await tick();
  await f.buttons.press(key.id);
  assert.deepEqual(opened, ["b"]);
  f.buttons.unbind(key.id);
});

test("明示的な表示待ちにも上限があり、遅い画像が後で届いても自動移動しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let release;
  const key = {
    ...f.key,
    setImage: async () =>
      await new Promise((resolve) => {
        release = resolve;
      }),
  };
  f.buttons.bind(key, { workspaceId: "b", workspaceName: "B" });
  await tick();
  const pending = f.buttons.waitForDisplay(key.id);
  t.mock.timers.tick(2000);
  assert.equal(await pending, false);
  release();
  await tick();
  f.buttons.unbind(key.id);
});

test("新しい割当の画像送信が失敗した場合も、表示成功として開かない", async () => {
  const opened = [];
  const f = fixture({
    focusWorkspace: async (id) => {
      opened.push(id);
      return true;
    },
  });
  const key = {
    ...f.key,
    setImage: async () => {
      throw Error("image failed");
    },
  };
  f.buttons.bind(key, { workspaceId: "b", workspaceName: "B" });
  await tick();
  await f.buttons.press(key.id);
  assert.deepEqual(opened, []);
  assert.ok(f.errors.some((e) => e.error.includes("表示")));
  f.buttons.unbind(key.id);
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
