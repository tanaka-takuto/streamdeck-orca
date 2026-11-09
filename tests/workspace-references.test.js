import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { parseWorkspaceSelection } = await loadModule(
  "src/orca/active-selection.ts",
);
const { parseReferences, chooseReference } = await loadModule(
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
test("Issue/PR優先・Orca選択・複数候補・消失・無関連を区別", () => {
  const read = (refs) => parseReferences(response(refs), "a", "r");
  assert.equal(chooseReference(read([ref(1, "issue")])).key, "k1");
  assert.equal(chooseReference(read([ref(2)])).key, "k2");
  assert.equal(chooseReference(read([ref(1, "issue"), ref(2)])).key, "k2");
  assert.equal(
    chooseReference(read([ref(1, "issue", true), ref(2)])).key,
    "k1",
  );
  assert.throws(() => chooseReference(read([ref(2), ref(3)])), /複数/);
  assert.equal(
    chooseReference(read([ref(2), ref(3)]), {
      workspaceId: "a",
      key: "k3",
      url: ref(3).url,
    }).key,
    "k3",
  );
  assert.throws(
    () =>
      chooseReference(read([ref(2)]), {
        workspaceId: "a",
        key: "k3",
        url: ref(3).url,
      }),
    /消失/,
  );
  assert.throws(() => chooseReference(read([])), /関連先なし/);
  assert.throws(() => parseReferences(response([ref(2)]), "b", "r"));
  assert.throws(() => parseReferences(response([ref(2)]), "a", "different"));
  assert.throws(() =>
    chooseReference(
      read([{ ...ref(2), url: "https://evil.example/x", selected: true }]),
    ),
  );
});
