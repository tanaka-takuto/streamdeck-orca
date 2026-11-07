import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { parseSnapshot, getWorkspaceStatus, selectTerminal } =
  await loadModule("src/orca/model.ts");

const agent = (state, paneKey = "tab:main", extra = {}) => ({
  state,
  paneKey,
  ...extra,
});
const workspace = (agents = [], extra = {}) => ({
  id: "repo::/workspace-a",
  name: "Workspace A",
  project: "Project",
  path: "/workspace-a",
  hostId: "local",
  activity: "active",
  terminalVerdict: "live",
  agents,
  ...extra,
});
const terminal = (paneKey, extra = {}) => ({
  handle: `term_${paneKey}`,
  workspaceId: "repo::/workspace-a",
  paneKey,
  connected: true,
  orphaned: false,
  hostId: "local",
  ...extra,
});

for (const [name, value, expected] of [
  [
    "入力待ちを実行中より優先",
    workspace([agent("working"), agent("waiting", "tab:child")]),
    "waiting",
  ],
  [
    "子が実行中なら親の返答後も実行中",
    workspace([agent("done"), agent("working", "tab:child")]),
    "working",
  ],
  [
    "Orca が集約した親の状態を利用",
    workspace([agent("working", "tab:main", { mainAgent: { state: "done" } })]),
    "working",
  ],
  [
    "中断やブロックは要確認",
    workspace([agent("working"), agent("blocked", "tab:child")]),
    "review",
  ],
  [
    "全員の返答終了は要確認",
    workspace([agent("done"), agent("done", "tab:child")]),
    "review",
  ],
  [
    "未知のエージェント状態を完了扱いしない",
    workspace([agent("done"), agent("unknown", "tab:child")]),
    "unknown",
  ],
  [
    "所在不明を待機扱いしない",
    workspace([], { terminalVerdict: "unverifiable" }),
    "unknown",
  ],
  ["エージェント不在は待機", workspace([]), "idle"],
  [
    "OSC の実行中を補助情報として利用",
    workspace([], { activity: "working" }),
    "working",
  ],
  ["ワークスペース未取得は不明", undefined, "unknown"],
]) {
  test(name, () => assert.equal(getWorkspaceStatus(value), expected));
}

test("ボタンの固定 ID で選べる情報だけを抽出する", () => {
  const snapshot = parseSnapshot({
    ok: true,
    _meta: { runtimeId: "runtime-a" },
    result: {
      hostScope: { hostIds: ["local"], omittedHostIds: [] },
      truncated: false,
      worktrees: [
        {
          worktreeId: "repo::/workspace-a",
          displayName: "Workspace A",
          repo: "Project",
          path: "/workspace-a",
          hostId: "local",
          status: "active",
          terminalVerdict: "live",
          workspaceStatus: "completed",
          agents: [{ state: "working", paneKey: "tab:main" }],
        },
      ],
    },
  });
  assert.equal(snapshot.runtimeId, "runtime-a");
  assert.equal(snapshot.workspaces[0].id, "repo::/workspace-a");
  assert.equal(getWorkspaceStatus(snapshot.workspaces[0]), "working");
  assert.equal("workspaceStatus" in snapshot.workspaces[0], false);
});

test("失敗・古い応答形式・不正なスコープを成功扱いしない", () => {
  for (const value of [
    { ok: false, error: { message: "Orca is not running" } },
    { ok: true, result: { worktrees: [] } },
    {
      ok: true,
      _meta: { runtimeId: "r" },
      result: { worktrees: [], hostScope: {} },
    },
  ])
    assert.throws(() => parseSnapshot(value));
});

test("入力待ちのターミナルを一覧順と無関係に選ぶ", () => {
  const selected = selectTerminal(
    workspace([agent("working", "tab:work"), agent("waiting", "tab:wait")]),
    [terminal("tab:work"), terminal("tab:wait")],
  );
  assert.equal(selected?.handle, "term_tab:wait");
});

test("同じワークスペースの子の入力待ちは親のターミナルを開く", () => {
  const selected = selectTerminal(
    workspace([
      agent("working"),
      agent("waiting", "child:1", { parentPaneKey: "tab:main" }),
    ]),
    [terminal("tab:main")],
  );
  assert.equal(selected?.handle, "term_tab:main");
});

test("入力待ちの相手が見つからない場合に別ターミナルへ飛ばない", () => {
  assert.equal(
    selectTerminal(workspace([agent("waiting", "missing:wait")]), [
      terminal("tab:other"),
    ]),
    undefined,
  );
});

test("別ワークスペース・別ホスト・切断済みのターミナルへ飛ばない", () => {
  const own = workspace([agent("waiting")]);
  for (const extra of [
    { workspaceId: "repo::/workspace-b" },
    { hostId: "remote-host" },
    { connected: false },
    { orphaned: true },
  ])
    assert.equal(selectTerminal(own, [terminal("tab:main", extra)]), undefined);
});

test("ターミナル不在の none は取得不能と区別して待機として扱う", () => {
  const snapshot = parseSnapshot({
    ok: true,
    _meta: { runtimeId: "r" },
    result: {
      hostScope: { hostIds: ["local"], omittedHostIds: [] },
      truncated: false,
      worktrees: [
        {
          worktreeId: "repo::/idle",
          path: "/idle",
          displayName: "Idle",
          hostId: "local",
          status: "inactive",
          terminalVerdict: "none",
          agents: [],
        },
      ],
    },
  });
  assert.equal(snapshot.workspaces[0].terminalVerdict, "none");
  assert.equal(getWorkspaceStatus(snapshot.workspaces[0]), "idle");
});
