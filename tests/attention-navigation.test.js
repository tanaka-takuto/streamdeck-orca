import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { OrcaClient } = await loadModule("src/orca/client.ts");
const { AttentionQueue, attentionTarget } =
  await loadModule("src/attention.ts");
const scope = { hostIds: ["local"], omittedHostIds: [] };
const response = (result) => ({ ok: true, _meta: { runtimeId: "r1" }, result });
const w = {
  id: "a",
  name: "A",
  project: "P",
  path: "/a",
  hostId: "local",
  activity: "working",
  terminalVerdict: "live",
  agents: [
    { paneKey: "tab:work", state: "working" },
    { paneKey: "tab:done", state: "done", stateStartedAt: 42 },
  ],
};
const q = new AttentionQueue();
q.update({
  snapshot: { runtimeId: "r1", truncated: false, workspaces: [w] },
  error: null,
});
const target = attentionTarget(q.view);
test("並行作業中の返答候補は進行中ではなく返答ペインを開く", async () => {
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    if (args[0] === "worktree")
      return response({
        hostScope: scope,
        truncated: false,
        worktrees: [
          {
            worktreeId: "a",
            displayName: "A",
            path: "/a",
            repo: "P",
            hostId: "local",
            status: "working",
            terminalVerdict: "live",
            agents: w.agents,
          },
        ],
      });
    if (args[1] === "list")
      return response({
        hostScope: scope,
        truncated: false,
        terminals: ["work", "done"].map((leafId) => ({
          handle: leafId,
          worktreeId: "a",
          tabId: "tab",
          leafId,
          connected: true,
          executionHostId: "local",
        })),
      });
    return response({ focus: { navigated: true } });
  });
  await client.focusWorkspace("a", () => true, target);
  assert.equal(calls.at(-1)[3], "done");
});
test("押下後に待ちが消えたら新しい候補やペインへ代替移動しない", async () => {
  let calls = 0;
  const client = new OrcaClient(async () => {
    calls++;
    return response({
      hostScope: scope,
      truncated: false,
      worktrees: [
        {
          worktreeId: "a",
          path: "/a",
          hostId: "local",
          status: "working",
          terminalVerdict: "live",
          agents: [{ paneKey: "tab:work", state: "working" }],
        },
      ],
    });
  });
  await assert.rejects(
    client.focusWorkspace("a", () => true, target),
    /候補.*変わりました/,
  );
  assert.equal(calls, 1);
});

test("子の返答候補は進行中の親ターミナルまで正しく戻れる", async () => {
  const child = {
    paneKey: "child:1",
    parentPaneKey: "tab:work",
    state: "done",
    stateStartedAt: 42,
  };
  const agents = [w.agents[0], child];
  const queue = new AttentionQueue();
  queue.update({
    snapshot: {
      runtimeId: "r1",
      truncated: false,
      workspaces: [{ ...w, agents }],
    },
    error: null,
  });
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    if (args[0] === "worktree")
      return response({
        hostScope: scope,
        truncated: false,
        worktrees: [
          {
            worktreeId: "a",
            path: "/a",
            hostId: "local",
            status: "working",
            terminalVerdict: "live",
            agents,
          },
        ],
      });
    if (args[1] === "list")
      return response({
        hostScope: scope,
        truncated: false,
        terminals: [
          {
            handle: "parent",
            worktreeId: "a",
            tabId: "tab",
            leafId: "work",
            connected: true,
            executionHostId: "local",
          },
        ],
      });
    return response({ focus: { navigated: true } });
  });
  assert.equal(
    await client.focusWorkspace("a", () => true, attentionTarget(queue.view)),
    true,
  );
  assert.equal(calls.at(-1)[3], "parent");
});
