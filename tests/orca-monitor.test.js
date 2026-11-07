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
