import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

test("アクション一覧からWS選択・コマンド・レーダーを除き、残る4アクションを維持する", () => {
  const manifest = JSON.parse(
    readFileSync("com.tanaka-takuto.orca.sdPlugin/manifest.json", "utf8"),
  );
  const actions = manifest.Actions.map((row) => row.UUID);
  for (const removed of ["workspace-dial", "workspace-command", "change-radar"])
    assert.equal(actions.includes(`com.tanaka-takuto.orca.${removed}`), false);
  assert.deepEqual(
    actions.sort(),
    ["workspace-status", "active-ai-input", "attention", "pr-review"]
      .map((name) => `com.tanaka-takuto.orca.${name}`)
      .sort(),
  );
});

test("残る設定画面のローカルCSSとscriptの参照先を維持する", () => {
  const root = "com.tanaka-takuto.orca.sdPlugin";
  const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8"));
  for (const action of manifest.Actions) {
    const inspector = action.PropertyInspectorPath;
    if (!inspector) continue;
    const html = readFileSync(`${root}/${inspector}`, "utf8");
    for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/gu)) {
      if (/^(?:https?:|data:|#)/u.test(reference)) continue;
      assert.ok(
        existsSync(resolve(root, dirname(inspector), reference)),
        `${inspector} -> ${reference}`,
      );
    }
  }
});
