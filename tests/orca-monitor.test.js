import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceMonitor } = await loadModule("src/orca/monitor.ts");
const snapshot = { runtimeId: "r", workspaces: [], truncated: false };

test("複数のボタンで同じポーリングを共有する", async (t) => {
  let calls = 0;
  const monitor = new WorkspaceMonitor({
    snapshot: async () => {
      calls++;
      return snapshot;
    },
  });
  const values = [];
  t.after(monitor.subscribe((state) => values.push(state)));
  t.after(monitor.subscribe(() => {}));
  await monitor.refresh();
  assert.equal(calls, 1);
  assert.equal(values.at(-1).snapshot, snapshot);
});

test("接続失敗時は前回の状態を残さず不明にする", async (t) => {
  let failed = false;
  const monitor = new WorkspaceMonitor({
    snapshot: async () => {
      if (failed) throw new Error("offline");
      return snapshot;
    },
  });
  t.after(monitor.subscribe(() => {}));
  await monitor.refresh();
  assert.equal(monitor.state.snapshot, snapshot);
  failed = true;
  await monitor.refresh();
  assert.equal(monitor.state.snapshot, null);
  assert.match(monitor.state.error, /offline/u);
});

test("監視終了前の遅い応答で再開後の状態を上書きしない", async (t) => {
  const pending = [];
  const monitor = new WorkspaceMonitor({
    snapshot: () => new Promise((resolve) => pending.push(resolve)),
  });
  const stop = monitor.subscribe(() => {});
  stop();
  const seen = [];
  t.after(monitor.subscribe((state) => seen.push(state)));
  const current = monitor.refresh();
  assert.equal(pending.length, 2);
  const latest = { ...snapshot, runtimeId: "latest" };
  pending[1](latest);
  await current;
  pending[0]({ ...snapshot, runtimeId: "old" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.at(-1).snapshot.runtimeId, "latest");
});

test("ページを切り替えて監視を再開しても、再取得中は直前の正常な状態を表示する", async (t) => {
  let reads = 0;
  let resolveNext;
  const monitor = new WorkspaceMonitor({
    snapshot: () =>
      ++reads === 1
        ? Promise.resolve(snapshot)
        : new Promise((resolve) => {
            resolveNext = resolve;
          }),
  });
  const stop = monitor.subscribe(() => {});
  await monitor.refresh();
  stop();
  const seen = [];
  t.after(monitor.subscribe((state) => seen.push(state)));
  assert.equal(seen[0].snapshot, snapshot);
  assert.equal(seen[0].fromCache, true);
  assert.equal(reads, 2, "再表示時も必ず最新情報を取り直す");
  const next = { ...snapshot, runtimeId: "next" };
  const refreshed = monitor.refresh();
  resolveNext(next);
  await refreshed;
  assert.equal(seen.at(-1).snapshot, next);
  assert.notEqual(seen.at(-1).fromCache, true);
  assert.equal(
    seen.some((state) => state.snapshot === null),
    false,
  );
});

test("最後の正常取得から5秒を超えた状態は、ページへ戻っても表示に再利用しない", async (t) => {
  let now = 0;
  let reads = 0;
  const monitor = new WorkspaceMonitor(
    {
      snapshot: async () => {
        reads++;
        return snapshot;
      },
    },
    2_000,
    () => now,
  );
  const stop = monitor.subscribe(() => {});
  await monitor.refresh();
  stop();
  now = 5_001;
  const seen = [];
  t.after(monitor.subscribe((state) => seen.push(state)));
  assert.equal(seen[0].snapshot, null);
  await monitor.refresh();
  assert.equal(reads, 2);
  assert.equal(seen.at(-1).snapshot, snapshot);
});

test("再取得が失敗したら保持した表示を不明にし、次の再表示でも失敗前の状態を復活させない", async (t) => {
  let reads = 0;
  let rejectNext;
  const monitor = new WorkspaceMonitor({
    snapshot: () =>
      ++reads === 1
        ? Promise.resolve(snapshot)
        : new Promise((_resolve, reject) => {
            rejectNext = reject;
          }),
  });
  const stop = monitor.subscribe(() => {});
  await monitor.refresh();
  stop();
  const seen = [];
  const stopAgain = monitor.subscribe((state) => seen.push(state));
  assert.equal(seen[0].snapshot, snapshot);
  const refreshed = monitor.refresh();
  rejectNext(new Error("offline"));
  await refreshed;
  assert.equal(seen.at(-1).snapshot, null);
  assert.equal(seen.at(-1).error, "offline");
  stopAgain();
  const reopened = [];
  t.after(monitor.subscribe((state) => reopened.push(state)));
  assert.equal(reopened[0].snapshot, null);
  const failedAgain = monitor.refresh();
  rejectNext(new Error("offline"));
  await failedAgain;
});

test("素早いページ切替の繰り返しや停止前の遅い応答で、保持できる5秒を延長しない", async (t) => {
  let now = 0;
  let reads = 0;
  const pending = [];
  const monitor = new WorkspaceMonitor(
    {
      snapshot: () =>
        ++reads === 1
          ? Promise.resolve(snapshot)
          : new Promise((resolve) => pending.push(resolve)),
    },
    2_000,
    () => now,
  );
  let stop = monitor.subscribe(() => {});
  await monitor.refresh();
  stop();
  for (now of [2_000, 4_000]) {
    const seen = [];
    stop = monitor.subscribe((state) => seen.push(state));
    assert.equal(seen[0].snapshot, snapshot);
    stop();
  }
  now = 4_500;
  for (const resolve of pending)
    resolve({ ...snapshot, runtimeId: "discarded" });
  await new Promise((resolve) => setImmediate(resolve));
  now = 5_001;
  const seen = [];
  t.after(monitor.subscribe((state) => seen.push(state)));
  assert.equal(seen[0].snapshot, null);
  const refreshed = monitor.refresh();
  pending.at(-1)(snapshot);
  await refreshed;
});
