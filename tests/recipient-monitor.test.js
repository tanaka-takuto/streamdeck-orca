import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { RecipientMonitor } = await loadModule("src/orca/recipient-monitor.ts");
const tick = () => new Promise((r) => setImmediate(r));
test("複数キーの候補取得を共有し、最後の非表示で停止、復帰キャッシュは表示専用", async () => {
  let calls = 0,
    now = 100,
    resolve;
  const m = new RecipientMonitor(
    () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    100000,
    () => now,
  );
  const stopA = m.subscribe(() => {}),
    stopB = m.subscribe(() => {});
  assert.equal(calls, 1);
  const pending = m.refresh();
  assert.equal(calls, 1);
  resolve({ id: "A" });
  await pending;
  stopA();
  assert.ok(m.state.recipient);
  stopB();
  assert.equal(m.state.recipient, null);
  now += 100;
  const stopC = m.subscribe(() => {});
  assert.equal(m.state.fromCache, true);
  assert.equal(calls, 2);
  stopC();
  resolve({ id: "stale" });
  await tick();
  assert.equal(m.state.recipient, null);
  now += 6000;
  const stopD = m.subscribe(() => {});
  assert.equal(m.state.recipient, null);
  resolve({ id: "D" });
  await tick();
  assert.equal(m.state.fromCache, undefined);
  stopD();
});
test("失敗した候補は旧対象で入力可能にしない", async () => {
  let fail = false;
  const m = new RecipientMonitor(async () => {
    if (fail) throw new Error("offline");
    return { id: "A" };
  }, 100000);
  const stop = m.subscribe(() => {});
  await m.refresh();
  fail = true;
  await m.refresh();
  assert.equal(m.state.recipient, null);
  assert.match(m.state.error, /offline/);
  stop();
});

test("ページをまたいで旧取得が保留でもprobeを重ねず、旧結果を新ページに使わない", async () => {
  let calls = 0,
    release;
  const m = new RecipientMonitor(() => {
    calls++;
    return new Promise((r) => {
      release = r;
    });
  }, 100000);
  const a = m.subscribe(() => {});
  a();
  const b = m.subscribe(() => {});
  await tick();
  assert.equal(calls, 1);
  release({ id: "old" });
  await tick();
  assert.equal(calls, 2);
  assert.equal(m.state.recipient, null);
  release({ id: "fresh" });
  await tick();
  assert.equal(m.state.recipient.id, "fresh");
  b();
});
