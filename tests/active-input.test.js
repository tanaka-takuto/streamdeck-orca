import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { ActiveAiInput } = await loadModule("src/orca/active-input.ts");
const { parseActiveSelection, createActiveSelectionReader } = await loadModule(
  "src/orca/active-selection.ts",
);
const selected = {
  runtimeId: "r",
  workspaceId: "repo::/selected",
  paneKey: "tab:chosen",
};
const state = {
  activeWorktreeId: selected.workspaceId,
  activeWorkspaceKey: `worktree:${selected.workspaceId}`,
  activeWorkspaceExecutionHostId: null,
  activeTabId: "tab",
  activeTabTypeByWorktree: { [selected.workspaceId]: "terminal" },
  activeTabIdByWorktree: { [selected.workspaceId]: "tab" },
  tabsByWorktree: { [selected.workspaceId]: [{ id: "tab" }] },
  terminalLayoutsByTabId: { tab: { activeLeafId: "chosen" } },
};
const response = (result, runtimeId = "r") => ({
  ok: true,
  _meta: { runtimeId },
  result,
});
const agent = (id, extra = {}) => ({
  handle: `term_${id}`,
  incarnationId: `inc_${id}`,
  agentIdentity: "codex",
  worktreeId: selected.workspaceId,
  executionHostId: "local",
  tabId: "tab",
  leafId: id,
  connected: true,
  writable: true,
  orphaned: false,
  ...extra,
});
function fixture({
  rows = [agent("other"), agent("chosen")],
  selections = [selected, selected],
  receipt,
  duringList,
  desktopStatus = "available",
} = {}) {
  const calls = [];
  let readCount = 0;
  const raw = new ActiveAiInput(
    {
      snapshot: async () => ({
        runtimeId: "r",
        truncated: false,
        workspaces: [
          {
            id: selected.workspaceId,
            hostId: "local",
            name: "Selected",
            project: "Repo",
            path: "/selected",
          },
        ],
      }),
    },
    async (args) => {
      calls.push(args);
      if (args[0] === "status")
        return response({
          app: { running: true, desktopWindowStatus: desktopStatus },
        });
      if (args[1] === "list") {
        duringList?.();
        return response({
          hostScope: { hostIds: ["local"] },
          truncated: false,
          terminals: rows,
          topologyRevisions: { [selected.workspaceId]: 1 },
          visualLayouts: [
            {
              worktreeId: selected.workspaceId,
              root: {
                type: "group",
                tabs: [
                  {
                    tabId: "tab",
                    panes: rows
                      .map((row) => ({
                        type: "terminal",
                        handle: row.handle,
                        tabId: row.tabId,
                        leafId: row.leafId,
                      }))
                      .reduce(
                        (first, second) =>
                          first
                            ? {
                                type: "pane-split",
                                direction: "vertical",
                                first,
                                second,
                              }
                            : second,
                        undefined,
                      ),
                  },
                ],
              },
            },
          ],
        });
      }
      if (receipt instanceof Error) throw receipt;
      return (
        receipt ??
        response({
          send: {
            handle: "term_chosen",
            accepted: true,
            prompt: { requestId: "request", stages: ["input_accepted"] },
          },
        })
      );
    },
    async () => selections[Math.min(readCount++, selections.length - 1)],
  );
  const input = {
    send: async (settings, current) => {
      const displayed = await raw.resolve();
      return raw.send(settings, displayed, current);
    },
  };
  return { input, raw, calls };
}

test("ORCA の保存状態から選択中のワークスペースと分割ペインを取り出す", () => {
  assert.deepEqual(parseActiveSelection(state, "r"), selected);
});
for (const patch of [
  { activeWorkspaceKey: "folder:another" },
  { activeWorkspaceExecutionHostId: "remote" },
  { activeTabTypeByWorktree: { [selected.workspaceId]: "agent-session" } },
  { activeTabIdByWorktree: { [selected.workspaceId]: "old" } },
  { terminalLayoutsByTabId: {} },
])
  test(`曖昧な選択状態は入力先にしない: ${JSON.stringify(patch)}`, () => {
    assert.throws(() => parseActiveSelection({ ...state, ...patch }, "r"));
  });

test("複数 AI がいても選択中のペインだけへ文字列を入力し、既定では Enter を送らない", async () => {
  const f = fixture();
  const result = await f.input.send({ body: "次の変更を確認して" });
  assert.equal(result.status, "accepted");
  assert.deepEqual(f.calls.at(-1), [
    "terminal",
    "send",
    "--terminal",
    "term_chosen",
    "--text",
    "次の変更を確認して",
    "--json",
  ]);
});
test("Enter オンの場合だけ送信し、受付と処理開始を区別する", async () => {
  const f = fixture();
  const result = await f.input.send({ body: "レビューして", enter: true });
  assert.equal(result.status, "accepted");
  assert.equal(result.requestId, "request");
  assert.equal(f.calls.at(-1).includes("--enter"), true);
  assert.match(result.message, /開始.*確認していません/u);
});
test("Enter オフの複数行はペーストとして入力し、行末の改行を実行キーにしない", async () => {
  const f = fixture();
  await f.input.send({ body: "一行目\n二行目\n" });
  assert.equal(f.calls.at(-1)[5], "\x1b[200~一行目\n二行目\n\x1b[201~");
  assert.equal(f.calls.at(-1).includes("--enter"), false);
});

test("Enter オフではタブ文字もペーストとして入力し、補完キーとして送らない", async () => {
  const f = fixture();
  await f.input.send({ body: "項目\t説明" });
  assert.equal(f.calls.at(-1)[5], "\x1b[200~項目\t説明\x1b[201~");
});

test("デスクトップ画面がない場合は保存された最後の選択先へ入力しない", async () => {
  const f = fixture({ desktopStatus: "unavailable" });
  await assert.rejects(f.input.send({ body: "指示" }));
  assert.equal(
    f.calls.some((args) => args[1] === "send"),
    false,
  );
});
for (const rows of [
  [agent("other")],
  [agent("chosen", { agentIdentity: undefined })],
  [agent("chosen", { connected: false })],
  [agent("chosen", { writable: false })],
  [agent("chosen", { worktreeId: "another" })],
])
  test("選択先が AI でない・不在・別ワークスペースなら他の AI へ振り替えない", async () => {
    const f = fixture({ rows });
    await assert.rejects(f.input.send({ body: "指示" }));
    assert.equal(
      f.calls.some((args) => args[1] === "send"),
      false,
    );
  });
test("表示後の保存選択変更では表示相手を保ち、実行前の設定変更では入力しない", async () => {
  const f = fixture({
    selections: [selected, { ...selected, paneKey: "tab:other" }],
  });
  assert.equal((await f.input.send({ body: "指示" })).status, "accepted");
  let current = true;
  const g = fixture({
    duringList: () => {
      current = false;
    },
  });
  assert.equal(
    (await g.input.send({ body: "指示" }, () => current)).status,
    "cancelled",
  );
  assert.equal(
    g.calls.some((x) => x[1] === "send"),
    false,
  );
});
test("空文字・制御文字では入力せず、輸送の結果が不明でも再送しない", async () => {
  for (const body of [
    "",
    " ",
    "x\rcommand",
    "\x1b[201~command",
    "x".repeat(16001),
  ]) {
    const f = fixture();
    const displayed = await f.raw.resolve();
    f.calls.length = 0;
    await assert.rejects(f.raw.send({ body }, displayed));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ receipt: new Error("timeout") });
  assert.equal((await f.input.send({ body: "指示" })).status, "unknown");
  assert.equal(f.calls.filter((args) => args[1] === "send").length, 1);
});
test("入力拒否・別相手の応答・Enter 送信の証跡不足を成功にしない", async () => {
  for (const [send, status] of [
    [{ handle: "term_chosen", accepted: false }, "refused"],
    [{ handle: "other", accepted: true }, "unknown"],
    [{ handle: "term_chosen", accepted: true }, "unknown"],
  ]) {
    const f = fixture({ receipt: response({ send }) });
    assert.equal(
      (await f.input.send({ body: "指示", enter: true })).status,
      status,
    );
  }
});

test("アクティブなプロファイルだけを読み、読取中のプロファイルやランタイム変更を拒否する", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orca-active-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, value) =>
    writeFileSync(join(directory, name), JSON.stringify(value));
  for (const change of [undefined, "profile", "runtime", "traversal"]) {
    write("orca-runtime.json", { runtimeId: "r" });
    write("orca-profile-index.json", {
      activeProfileId: change === "traversal" ? "../other" : "current",
      profiles: [{ id: "current" }],
    });
    let reads = 0;
    const reader = createActiveSelectionReader({
      directory,
      query: async (database) => {
        reads++;
        assert.equal(
          database,
          join(directory, "profiles/current/profile-state.db"),
        );
        if (change === "profile")
          write("orca-profile-index.json", { activeProfileId: "other" });
        if (change === "runtime")
          write("orca-runtime.json", { runtimeId: "other" });
        return JSON.stringify([{ payload: JSON.stringify(state) }]);
      },
    });
    if (!change) assert.deepEqual(await reader(), selected);
    else await assert.rejects(reader());
    if (change === "traversal") assert.equal(reads, 0);
  }
});
