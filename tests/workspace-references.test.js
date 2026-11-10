import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { parseWorkspaceSelection } = await loadModule(
  "src/orca/active-selection.ts",
);
const { parseReferences, allReferences } = await loadModule(
  "src/orca/workspace-references.ts",
);
const response = (refs) => ({
  ok: true,
  _meta: { runtimeId: "r" },
  result: { worktree: { id: "a", hostId: "local" }, references: refs },
});
const ref = (n, type = "pr", selected = false) => ({
  provider: "github",
  type,
  key: `k${n}`,
  number: n,
  url: `https://github.com/acme/app/${type === "pr" ? "pull" : "issues"}/${n}`,
  selected,
});
test("画面選択WSはタブ/AIに依存せずcwdの行を選ばない", () => {
  const raw = {
    ok: true,
    _meta: { runtimeId: "r" },
    result: {
      hostScope: { hostIds: ["local"], omittedHostIds: [] },
      truncated: false,
      worktrees: [
        { worktreeId: "cwd", path: "/cwd", agents: [], hostId: "local" },
        {
          worktreeId: "a",
          path: "/a",
          agents: [],
          displayName: "A",
          hostId: "local",
          isActive: true,
          terminalVerdict: "none",
        },
      ],
    },
  };
  assert.equal(parseWorkspaceSelection(raw).workspace.id, "a");
  raw.result.worktrees[0].isActive = true;
  assert.throws(() => parseWorkspaceSelection(raw), /選択/);
  raw.result.worktrees[0].isActive = false;
  raw.result.truncated = true;
  assert.throws(() => parseWorkspaceSelection(raw));
});
test("Orca選択中参照によらずPRとIssueを全件、同一URLは一件にまとめる", () => {
  const read = (refs) => parseReferences(response(refs), "a", "r");
  const refs = allReferences(
    read([
      ref(1, "issue", true),
      ref(2),
      ref(3),
      {
        ...ref(2),
        key: "duplicate",
        url: "https://github.com/ACME/APP/pull/2",
      },
      {
        provider: "linear",
        type: "issue",
        key: "other",
        url: "https://linear.app/acme/issue/A-1",
        selected: true,
      },
    ]),
  );
  assert.deepEqual(
    refs.map((r) => r.url),
    [ref(1, "issue").url, ref(2).url, ref(3).url],
  );
  assert.deepEqual(allReferences(read([])), []);
});
test("不正なGitHub対象や不完全な取得では、正常な関連先だけに黙って減らさない", () => {
  for (const bad of [
    { ...ref(2), url: "https://evil.example/x" },
    { ...ref(2), key: "" },
    { ...ref(2), url: ref(2, "issue").url },
  ]) {
    assert.throws(
      () => parseReferences(response([ref(1), bad]), "a", "r"),
      /関連先/u,
    );
  }
  assert.throws(
    () =>
      parseReferences(
        {
          ...response([ref(1)]),
          result: { ...response([ref(1)]).result, truncated: true },
        },
        "a",
        "r",
      ),
    /関連先/u,
  );
  assert.throws(() => parseReferences(response([ref(2)]), "b", "r"));
  assert.throws(() => parseReferences(response([ref(2)]), "a", "different"));
  assert.equal(
    allReferences(parseReferences(response([ref(2), ref(2)]), "a", "r")).length,
    1,
  );
  assert.throws(
    () =>
      parseReferences(
        response([ref(2), { ...ref(3), key: ref(2).key }]),
        "a",
        "r",
      ),
    /重複/u,
  );
});
