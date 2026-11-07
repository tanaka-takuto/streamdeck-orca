import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { ActiveAiInput } = await loadModule("src/orca/active-input.ts");
const r = (result) => ({ ok: true, _meta: { runtimeId: "r" }, result });
function fixture() {
  let selected = { runtimeId: "r", workspaceId: "w", paneKey: "tab:a" };
  let rows = ["a", "b"].map((id) => ({
    handle: `term_${id}`,
    incarnationId: `inc_${id}`,
    agentIdentity: "codex",
    title: "same",
    worktreeId: "w",
    executionHostId: "local",
    tabId: "tab",
    leafId: id,
    connected: true,
    writable: true,
  }));
  const calls = [];
  const input = new ActiveAiInput(
    {
      snapshot: async () => ({
        runtimeId: "r",
        truncated: false,
        workspaces: [
          {
            id: "w",
            name: "Workspace",
            project: "Repo",
            path: "/w",
            hostId: "local",
            agents: [],
            activity: "idle",
          },
        ],
      }),
    },
    async (args) => {
      calls.push(args);
      if (args[0] === "status")
        return r({ app: { running: true, desktopWindowStatus: "available" } });
      if (args[1] === "list")
        return r({
          hostScope: { hostIds: ["local"] },
          truncated: false,
          terminals: rows,
          topologyRevisions: { w: 1 },
          visualLayouts: [
            {
              worktreeId: "w",
              root: {
                type: "group",
                groupId: "g",
                tabs: [
                  {
                    tabId: "tab",
                    panes: {
                      type: "pane-split",
                      direction: "vertical",
                      first: {
                        type: "terminal",
                        handle: "term_a",
                        tabId: "tab",
                        leafId: "a",
                      },
                      second: {
                        type: "terminal",
                        handle: "term_b",
                        tabId: "tab",
                        leafId: "b",
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
      return r({ send: { handle: args[3], accepted: true } });
    },
    async () => selected,
  );
  return {
    input,
    calls,
    selectB() {
      selected = { ...selected, paneKey: "tab:b" };
    },
    mutateRows(fn) {
      rows = fn(rows);
    },
    change() {
      rows = rows.map((x) =>
        x.handle === "term_a" ? { ...x, incarnationId: "replacement" } : x,
      );
    },
  };
}
test("表示済みAを押すと保存選択がBでもAだけへ入力し、Bへ追従しない", async () => {
  const f = fixture();
  const displayed = await f.input.resolve();
  f.selectB();
  await f.input.send({ body: "raw" }, displayed);
  assert.equal(f.calls.find((x) => x[1] === "send")?.[3], "term_a");
});
test("表示済みAIのincarnation変更は拒否し、別AIへ振り替えない", async () => {
  const f = fixture();
  const displayed = await f.input.resolve();
  f.change();
  await assert.rejects(f.input.send({ body: "raw" }, displayed));
  assert.equal(f.calls.filter((x) => x[1] === "send").length, 0);
});
test("候補には同名AIを照合できる端末レイアウト位置と完全WSがある", async () => {
  const f = fixture();
  const x = await f.input.resolve();
  assert.equal(x.workspace.path, "/w");
  assert.match(x.location, /T1.*左/u);
});

test("レイアウトと端末一覧のペインが不一致なら入力候補にしない", async () => {
  const f = fixture();
  f.mutateRows((rows) =>
    rows.map((r) => (r.handle === "term_a" ? { ...r, leafId: "other" } : r)),
  );
  await assert.rejects(f.input.resolve());
});

for (const patch of [
  { incarnationId: "new" },
  { agentIdentity: "claude" },
  { tabId: "new" },
  { leafId: "new" },
  { executionHostId: "remote" },
  { worktreeId: "new" },
  { connected: false },
  { writable: false },
  { orphaned: true },
])
  test(`表示後のAI契約変更は送信0: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    const displayed = await f.input.resolve();
    f.mutateRows((rows) =>
      rows.map((r) => (r.handle === "term_a" ? { ...r, ...patch } : r)),
    );
    await assert.rejects(f.input.send({ body: "raw" }, displayed));
    assert.equal(f.calls.filter((x) => x[1] === "send").length, 0);
  });
test("同じhandleの一覧重複を先頭一致で入力許可しない", async () => {
  const f = fixture();
  const shown = await f.input.resolve();
  f.mutateRows((rows) => [...rows, { ...rows[0], leafId: "duplicate" }]);
  await assert.rejects(f.input.send({ body: "raw" }, shown));
  assert.equal(f.calls.filter((x) => x[1] === "send").length, 0);
});

for (const flag of ["connected", "writable", undefined])
  test(`深い位置は他AIの入力資格(${flag})に依存せず省略せず拒否`, async () => {
    const rows = [],
      paths = ["00000000", "00000100"];
    function tree(path = "") {
      const index = paths.indexOf(path);
      if (index >= 0 || !paths.some((p) => p.startsWith(path))) {
        const id =
            index >= 0
              ? String.fromCharCode(97 + index)
              : `filler${rows.length}`,
          handle = `mock-${id}`;
        rows.push({
          handle,
          incarnationId: `inc-${id}`,
          agentIdentity: "codex",
          title: "同名AI",
          worktreeId: "w",
          executionHostId: "local",
          tabId: "t",
          leafId: id,
          connected: !(flag === "connected" && id === "b"),
          writable: !(flag === "writable" && id === "b"),
        });
        return { type: "terminal", handle, tabId: "t", leafId: id };
      }
      return {
        type: "pane-split",
        direction: "vertical",
        first: tree(`${path}0`),
        second: tree(`${path}1`),
      };
    }
    const root = { type: "group", tabs: [{ tabId: "t", panes: tree() }] };
    let sends = 0;
    const input = new ActiveAiInput(
      {
        snapshot: async () => ({
          runtimeId: "r",
          truncated: false,
          workspaces: [
            {
              id: "w",
              name: "WS",
              path: "/w",
              project: "Repo",
              hostId: "local",
            },
          ],
        }),
      },
      async (args) => {
        if (args[0] === "status")
          return r({
            app: { running: true, desktopWindowStatus: "available" },
          });
        if (args[1] === "list")
          return r({
            hostScope: { hostIds: ["local"] },
            truncated: false,
            terminals: rows,
            visualLayouts: [{ worktreeId: "w", root }],
            topologyRevisions: { w: 1 },
          });
        sends++;
        return r({ send: { handle: "mock-a", accepted: true } });
      },
      async () => ({ runtimeId: "r", workspaceId: "w", paneKey: "t:a" }),
    );
    await assert.rejects(input.resolve(), /完全表示/);
    assert.equal(sends, 0);
  });
