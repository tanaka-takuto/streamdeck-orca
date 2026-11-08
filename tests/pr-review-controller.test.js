import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { PRReviewController } = await loadModule("src/pr-review-controller.ts");
const tick = () => new Promise((r) => setImmediate(r));
const row = (number) => ({
  repo: "acme/app",
  number,
  title: `Title ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  author: "author",
});
async function fixture(t) {
  let visible,
    rows = [row(1), row(2)],
    block = false,
    release,
    error = false;
  const launches = [];
  const c = new PRReviewController(
    {
      list: async () => {
        if (error) throw new Error("接続失敗");
        return { account: "me", accountId: 7, rows, partial: false };
      },
    },
    {
      launch: async (...args) => {
        launches.push(args);
        return { status: "accepted", message: "起動受付" };
      },
      forget: async () => {},
    },
  );
  const dial = {
    id: "dial",
    showAlert: async () => {},
    setFeedback: async (data) => {
      if (block) {
        block = false;
        await new Promise((r) => {
          release = r;
        });
      }
      visible = data;
    },
  };
  c.bind(dial, { enter: false });
  await tick();
  await tick();
  t.after(() => {
    c.unbind(dial.id);
    release?.();
  });
  return {
    c,
    dial,
    launches,
    get visible() {
      return visible;
    },
    set rows(r) {
      rows = r;
    },
    block() {
      block = true;
    },
    release() {
      release?.();
    },
    fail() {
      error = true;
    },
  };
}
test("ダイヤルでPRを選び、保存済みEnter設定と表示したPRを起動へ渡す", async (t) => {
  const f = await fixture(t);
  f.c.rotate("dial", 1);
  await tick();
  assert.equal(f.c.view("dial").selected.number, 2);
  await f.c.launch("dial");
  assert.equal(f.launches[0][0].number, 2);
  assert.equal(f.launches[0][2].enter, false);
});
test("表示の切替が完了する前には別PRを起動しない", async (t) => {
  const f = await fixture(t);
  f.block();
  f.c.rotate("dial", 1);
  await tick();
  await f.c.launch("dial");
  assert.equal(f.launches.length, 0);
  f.release();
  await tick();
  await f.c.launch("dial");
  assert.equal(f.launches[0][0].number, 2);
});
test("ページ再表示前の遅れた描画で新しい設定の起動を許可しない", async (t) => {
  const f = await fixture(t);
  f.block();
  f.c.rotate("dial", 1);
  await tick();
  f.c.bind(f.dial, { enter: true });
  await f.c.launch("dial");
  assert.equal(f.launches.length, 0);
  f.release();
  await tick();
  await tick();
  await f.c.launch("dial");
  assert.equal(f.launches[0][2].enter, true);
});
test("更新で並び順が変わっても選択したPRを保つ", async (t) => {
  const f = await fixture(t);
  f.c.rotate("dial", 1);
  await tick();
  f.rows = [row(2), row(1)];
  await f.c.refresh("dial");
  await tick();
  assert.equal(f.c.view("dial").selected.number, 2);
});
test("取得失敗を依頼なしとして扱わず、起動を拒否する", async (t) => {
  const f = await fixture(t);
  f.fail();
  await f.c.refresh("dial");
  await tick();
  assert.match(f.c.view("dial").error, /接続失敗/);
  await f.c.launch("dial");
  assert.equal(f.launches.length, 0);
});
test("起動したPRが一覧から消えたら、次のPRへ起動済み表示を引き継がない", async (t) => {
  const f = await fixture(t);
  await f.c.launch("dial");
  f.rows = [row(2)];
  await f.c.refresh("dial");
  await tick();
  assert.equal(f.c.view("dial").selected.number, 2);
  assert.doesNotMatch(f.visible.operation, /起動受付|WSを開く/);
  assert.equal(f.c.view("dial").message, undefined);
});
