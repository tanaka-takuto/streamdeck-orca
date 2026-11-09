import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("アクション一覧からWS切り替えダイヤルを除き、状態ボタンとPR選択を維持する", () => {
  const manifest = JSON.parse(
    readFileSync("com.tanaka-takuto.orca.sdPlugin/manifest.json", "utf8"),
  );
  const actions = manifest.Actions.map((row) => row.UUID);
  assert.equal(
    actions.includes("com.tanaka-takuto.orca.workspace-dial"),
    false,
  );
  assert.ok(actions.includes("com.tanaka-takuto.orca.workspace-status"));
  assert.ok(actions.includes("com.tanaka-takuto.orca.pr-review"));
});
