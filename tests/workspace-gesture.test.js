import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceGesture, DOUBLE_CLICK_MS, LONG_PRESS_MS } = await loadModule(
  "src/workspace-gesture.ts",
);
const tick = () => new Promise(setImmediate);
function fixture(t, slow = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let finish;
  const g = new WorkspaceGesture(
    async (kind, current) => {
      calls.push({ kind, current });
      if (slow)
        await new Promise((r) => {
          finish = r;
        });
    },
    () => {},
  );
  t.after(() => g.cancel());
  return { g, calls, finish: () => finish?.() };
}
test("定数と短押しの500ms待ち・ダブルの排他性", async (t) => {
  assert.equal(DOUBLE_CLICK_MS, 500);
  assert.equal(LONG_PRESS_MS, 700);
  const f = fixture(t);
  f.g.down();
  f.g.up();
  t.mock.timers.tick(499);
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(f.calls[0].kind, "short");
  f.g.down();
  f.g.up();
  t.mock.timers.tick(499);
  f.g.down();
  f.g.up();
  t.mock.timers.tick(1000);
  await tick();
  assert.deepEqual(
    f.calls.map((x) => x.kind),
    ["short", "double"],
  );
});
test("700ms成立時に一回だけ長押し・離しても移動しない", async (t) => {
  const f = fixture(t);
  f.g.down();
  t.mock.timers.tick(699);
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1);
  await tick();
  f.g.up();
  t.mock.timers.tick(1000);
  await tick();
  assert.deepEqual(
    f.calls.map((x) => x.kind),
    ["long"],
  );
});
test("二押目を長押しすると登録だけ・キャンセル後は遅い要求も無効", async (t) => {
  const f = fixture(t);
  f.g.down();
  f.g.up();
  t.mock.timers.tick(100);
  f.g.down();
  t.mock.timers.tick(700);
  await tick();
  f.g.up();
  assert.equal(f.calls[0].kind, "long");
  f.g.cancel();
  assert.equal(f.calls[0].current(), false);
  f.g.down();
  f.g.up();
  f.g.cancel();
  t.mock.timers.tick(1000);
  assert.equal(f.calls.length, 1);
});
test("処理中の連打は保留せず破棄しボタン間で混ぜない", async (t) => {
  const f = fixture(t, true);
  f.g.down();
  f.g.up();
  t.mock.timers.tick(500);
  await tick();
  f.g.down();
  f.g.up();
  f.finish();
  await tick();
  t.mock.timers.tick(1000);
  assert.equal(f.calls.length, 1);
});
test("500ms境界後は別の短押し、699msで離すと登録しない", async (t) => {
  const f = fixture(t);
  f.g.down();
  f.g.up();
  t.mock.timers.tick(500);
  await tick();
  f.g.down();
  t.mock.timers.tick(699);
  f.g.up();
  t.mock.timers.tick(500);
  await tick();
  assert.deepEqual(
    f.calls.map((x) => x.kind),
    ["short", "short"],
  );
});
test("別ボタンの短押しと長押しの判定を分離", async (t) => {
  const f = fixture(t),
    calls = [];
  const other = new WorkspaceGesture(
    async (kind) => {
      calls.push(kind);
    },
    () => {},
  );
  t.after(() => other.cancel());
  f.g.down();
  other.down();
  other.up();
  t.mock.timers.tick(500);
  await tick();
  t.mock.timers.tick(200);
  await tick();
  f.g.up();
  assert.deepEqual(calls, ["short"]);
  assert.deepEqual(
    f.calls.map((x) => x.kind),
    ["long"],
  );
});
