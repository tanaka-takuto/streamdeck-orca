import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { OldestPRController } = await loadModule("src/oldest-pr-controller.ts");
const tick = () => new Promise(setImmediate);
const pr = (n) => ({
  repo: "acme/app",
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/acme/app/pull/${n}`,
  author: "author",
  updatedAt: `2026-01-0${n}T00:00:00Z`,
});
function fixture(t) {
  let data = {
      account: "me",
      accountId: 7,
      totalCount: 120,
      incomplete: false,
      partial: true,
      rows: [pr(1), pr(2)],
    },
    failure,
    lookup,
    launchWait;
  const images = [],
    calls = [],
    effects = [],
    queries = [],
    opened = new Set();
  const keys = [];
  const github = {
    async list(...args) {
      queries.push(args);
      if (lookup) await lookup;
      if (failure) throw Error(failure);
      return structuredClone(data);
    },
  };
  const launcher = {
    async launch(p, account, settings, current, order) {
      calls.push({ p, account, settings, current, order });
      if (launchWait) await launchWait;
      if (!current()) return { status: "cancelled", message: "cancelled" };
      effects.push(p.number);
      const seen = opened.has(p.number);
      opened.add(p.number);
      return {
        status: seen ? "opened" : "accepted",
        message: seen ? "WSを開いた" : "AI起動済み",
      };
    },
    async forget() {},
  };
  const c = new OldestPRController(github, launcher, 60000);
  function key(id = "k") {
    const k = {
      id,
      device: { id: "deck", isConnected: true },
      async setImage(image) {
        images.push({ id, image: decodeURIComponent(image) });
      },
      async showAlert() {},
      async showOk() {},
    };
    keys.push(k);
    return k;
  }
  t.after(() => {
    for (const k of keys) c.unbind(k.id);
  });
  return {
    c,
    key,
    images,
    calls,
    effects,
    queries,
    launcher,
    async bind(k, settings = {}) {
      c.bind(k, settings);
      await tick();
      await tick();
    },
    data(value) {
      data = { ...data, ...value };
    },
    fail(value) {
      failure = value;
    },
    lookup(value) {
      lookup = value;
    },
    launchWait(value) {
      launchWait = value;
    },
  };
}
test("全件数と最古PRを表示し個人宛てascで検索、再押下でも件数と対象を維持", async (t) => {
  const f = fixture(t),
    k = f.key();
  await f.bind(k, { reviewMode: "team" });
  assert.match(f.images.at(-1).image, />120<|120件/u);
  assert.match(f.images.at(-1).image, /#1/u);
  assert.match(f.images.at(-1).image, /Orca既定/u);
  assert.deepEqual(f.queries[0], ["personal", undefined, "asc"]);
  await f.c.press(k.id);
  await tick();
  await f.c.press(k.id);
  await tick();
  assert.deepEqual(f.effects, [1, 1]);
  assert.equal(f.c.view(k.id).count, 120);
  assert.equal(f.calls[0].order, "asc");
  assert.equal(f.calls[0].settings.handoff, "none");
});
test("押下直前に最古が変われば別PRを同じ押下で起動しない", async (t) => {
  const f = fixture(t),
    k = f.key();
  await f.bind(k);
  f.data({ rows: [pr(2)], totalCount: 119 });
  await f.c.press(k.id);
  await tick();
  assert.deepEqual(f.effects, []);
  assert.match(f.images.at(-1).image, /#2/u);
  await f.c.press(k.id);
  assert.deepEqual(f.effects, [2]);
});
test("取得失敗・不完全検索・正常ゼロ件を区別して起動しない", async (t) => {
  const f = fixture(t),
    k = f.key();
  f.fail("network");
  await f.bind(k);
  assert.match(f.images.at(-1).image, /取得失敗/u);
  assert.equal(f.c.view(k.id).count, undefined);
  await f.c.press(k.id);
  assert.deepEqual(f.effects, []);
  f.fail(undefined);
  f.data({ incomplete: true });
  await f.c.refresh(k.id);
  await tick();
  assert.match(f.images.at(-1).image, /一部|未確定/u);
  await f.c.press(k.id);
  assert.deepEqual(f.effects, []);
  f.data({ incomplete: false, rows: [], totalCount: 0 });
  await f.c.refresh(k.id);
  await tick();
  assert.match(f.images.at(-1).image, /0件|>0</u);
  assert.doesNotMatch(f.images.at(-1).image, /取得失敗/u);
});
test("遅い再検索中の設定変更・ページ離脱で操作を取り消す", async (t) => {
  const f = fixture(t),
    k = f.key();
  await f.bind(k);
  let release;
  f.lookup(
    new Promise((r) => {
      release = r;
    }),
  );
  const pending = f.c.press(k.id);
  await tick();
  f.c.bind(k, { body: "new", handoff: "send" });
  release();
  await pending;
  await tick();
  assert.deepEqual(f.effects, []);
  f.lookup(undefined);
  await f.c.refresh(k.id);
  await tick();
  let finish;
  f.launchWait(
    new Promise((r) => {
      finish = r;
    }),
  );
  const launch = f.c.press(k.id);
  await tick();
  f.c.unbind(k.id);
  finish();
  await launch;
  assert.deepEqual(f.effects, []);
});
test("処理中の連打を溜めず、切断後の遅い起動を中止", async (t) => {
  const f = fixture(t),
    k = f.key();
  await f.bind(k);
  let finish;
  f.launchWait(
    new Promise((r) => {
      finish = r;
    }),
  );
  const one = f.c.press(k.id);
  await tick();
  await f.c.press(k.id);
  await f.c.press(k.id);
  assert.equal(f.calls.length, 1);
  f.c.disconnect("deck");
  finish();
  await one;
  await tick();
  assert.deepEqual(f.effects, []);
  assert.equal(f.calls.length, 1);
});
test("画像が未確定のボタンと取得中に別accountへ変わったボタンでは起動しない", async (t) => {
  const f = fixture(t),
    k = f.key();
  let release;
  const original = k.setImage;
  k.setImage = () =>
    new Promise((r) => {
      release = r;
    });
  await f.bind(k);
  await f.c.press(k.id);
  assert.deepEqual(f.effects, []);
  k.setImage = original;
  release();
  await tick();
  await f.c.refresh(k.id);
  await tick();
  f.data({ account: "other", accountId: 8 });
  await f.c.press(k.id);
  assert.deepEqual(f.effects, []);
});

test("最古PRが変わると旧PRの起動失敗を新しい対象へ残さない", async (t) => {
  const f = fixture(t),
    k = f.key();
  await f.bind(k);
  f.launcher.launch = async () => {
    throw Error("old PR failed");
  };
  await f.c.press(k.id);
  await tick();
  assert.match(f.images.at(-1).image, /起動失敗/u);
  f.data({ rows: [pr(2)], totalCount: 1 });
  await f.c.refresh(k.id);
  await tick();
  assert.doesNotMatch(f.images.at(-1).image, /起動失敗/u);
  assert.equal(f.c.view(k.id).message, undefined);
});
test("ボタンに起動AIと渡し方を表示し、件数と候補の不整合を取得失敗にする", async (t) => {
  const f = fixture(t),
    k = f.key();
  await f.bind(k, { agent: "claude", handoff: "send" });
  assert.match(f.images.at(-1).image, /Claude/u);
  assert.match(f.images.at(-1).image, /入力して送信/u);
  f.data({ rows: [], totalCount: 1 });
  await f.c.refresh(k.id);
  await tick();
  assert.match(f.images.at(-1).image, /取得失敗/u);
});
