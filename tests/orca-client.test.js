import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { OrcaClient } = await loadModule("src/orca/client.ts");
const response = (result, runtimeId = "runtime-a") => ({
  ok: true,
  _meta: { runtimeId },
  result,
});
const scope = { hostIds: ["local"], omittedHostIds: [] };
const snapshot = () =>
  response({
    hostScope: scope,
    truncated: false,
    worktrees: [
      {
        worktreeId: "repo::/a",
        path: "/a",
        displayName: "A",
        repo: "Project",
        hostId: "local",
        status: "working",
        terminalVerdict: "live",
        agents: [
          { paneKey: "tab:work", state: "working" },
          { paneKey: "tab:wait", state: "waiting" },
        ],
      },
    ],
  });
const terminals = (runtimeId = "runtime-a") =>
  response(
    {
      hostScope: scope,
      truncated: false,
      terminals: [
        {
          handle: "term_work",
          worktreeId: "repo::/a",
          tabId: "tab",
          leafId: "work",
          executionHostId: "local",
          connected: true,
        },
        {
          handle: "term_wait",
          worktreeId: "repo::/a",
          tabId: "tab",
          leafId: "wait",
          executionHostId: "local",
          connected: true,
        },
      ],
    },
    runtimeId,
  );

test("毎回最新の一覧から入力待ちのハンドルを解決して開く", async () => {
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    if (args[0] === "worktree") return snapshot();
    if (args[1] === "list") return terminals();
    return response({ focus: { navigated: true } });
  });
  assert.equal(await client.focusWorkspace("repo::/a"), true);
  assert.deepEqual(calls.at(-1), [
    "terminal",
    "switch",
    "--terminal",
    "term_wait",
    "--json",
  ]);
  assert.equal(
    calls.some((args) => args.includes("send") || args.includes("launch")),
    false,
  );
});

test("Orca の再起動でハンドルの所属ランタイムが変わったら操作しない", async () => {
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    return args[0] === "worktree" ? snapshot() : terminals("runtime-b");
  });
  await assert.rejects(client.focusWorkspace("repo::/a"), /再起動|実行環境/u);
  assert.equal(calls.length, 2);
});

test("設定変更やキーの消滅で操作対象が変わったら遅い応答を無視する", async () => {
  let current = true;
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    if (args[0] === "worktree") return snapshot();
    current = false;
    return terminals();
  });
  assert.equal(await client.focusWorkspace("repo::/a", () => current), false);
  assert.equal(calls.length, 2);
});

test("割り当てたワークスペースが消えても別の先頭項目へ切り替えない", async () => {
  let calls = 0;
  const client = new OrcaClient(async () => {
    calls++;
    return snapshot();
  });
  await assert.rejects(
    client.focusWorkspace("repo::/deleted"),
    /ワークスペース/u,
  );
  assert.equal(calls, 1);
});

test("画面切り替えの失敗を成功扱いせず、自動再実行しない", async () => {
  let switches = 0;
  const client = new OrcaClient(async (args) => {
    if (args[0] === "worktree") return snapshot();
    if (args[1] === "list") return terminals();
    switches++;
    return response({ focus: { navigated: false } });
  });
  await assert.rejects(client.focusWorkspace("repo::/a"), /表示|切り替え/u);
  assert.equal(switches, 1);
});

test("ターミナル不在・終了済みでもワークスペース自体を開く", async () => {
  for (const terminalVerdict of ["none", "exited"]) {
    const calls = [];
    const activated = [];
    const client = new OrcaClient(
      async (args) => {
        calls.push(args);
        const value = snapshot();
        value.result.worktrees[0] = {
          ...value.result.worktrees[0],
          status: "inactive",
          agents: [],
          terminalVerdict,
        };
        return value;
      },
      async (id, runtimeId, current) => {
        activated.push({ id, runtimeId });
        return current();
      },
    );
    assert.equal(await client.focusWorkspace("repo::/a"), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(activated, [{ id: "repo::/a", runtimeId: "runtime-a" }]);
  }
});
test("ボタンが確認したruntimeとWS実体から変化した場合は移動しない", async () => {
  const calls = [];
  const client = new OrcaClient(async (args) => {
    calls.push(args);
    return snapshot();
  });
  await assert.rejects(
    client.focusWorkspace("repo::/a", () => true, undefined, "old-runtime"),
    /実行環境/u,
  );
  await assert.rejects(
    client.focusWorkspace(
      "repo::/a",
      () => true,
      undefined,
      "runtime-a",
      "previous-instance",
    ),
    /再作成|実体/u,
  );
  assert.equal(
    calls.every((args) => args[0] === "worktree"),
    true,
  );
});
test("長押しの画面選択はdesktop windowと同じruntimeの応答だけを採用", async () => {
  const ps = snapshot();
  ps.result.worktrees[0].isActive = true;
  ps.result.worktrees[0].agents = [];
  ps.result.worktrees[0].terminalVerdict = "none";
  let available = false,
    statusRuntime = "runtime-a";
  const client = new OrcaClient(async (args) =>
    args[0] === "status"
      ? response(
          {
            app: {
              running: true,
              desktopWindowStatus: available ? "available" : "unavailable",
            },
          },
          statusRuntime,
        )
      : ps,
  );
  await assert.rejects(client.selectedWorkspace(), /画面|ウィンドウ/u);
  available = true;
  statusRuntime = "other";
  await assert.rejects(client.selectedWorkspace(), /実行環境/u);
  statusRuntime = "runtime-a";
  assert.equal((await client.selectedWorkspace()).workspace.id, "repo::/a");
});
