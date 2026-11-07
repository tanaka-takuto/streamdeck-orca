import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runHook(message) {
  const directory = mkdtempSync(join(tmpdir(), "streamdeck-orca-commit-msg-"));

  try {
    // npm の依存をコピーせず、フック単体で実行できることも検証する。
    cpSync(
      new URL("../.githooks", import.meta.url),
      join(directory, ".githooks"),
      {
        recursive: true,
      },
    );
    const messagePath = join(directory, "COMMIT_EDITMSG");
    writeFileSync(messagePath, message);
    return spawnSync("sh", [".githooks/commit-msg", messagePath], {
      cwd: directory,
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const validMessages = [
  "feat: Orca の操作を追加\n",
  "fix(dial): 回転方向を修正\n",
  "feat(api)!: 接続方式を変更\n\nBREAKING CHANGE: 接続設定を更新する必要があります。\n",
  "refactor!: アクションを再構成\n",
  "docs: Update README\r\n",
  ...["build", "chore", "ci", "perf", "revert", "style", "test"].map(
    (type) => `${type}: 開発環境を更新\n`,
  ),
];

for (const message of validMessages) {
  test(`外部依存なしで受理する: ${message.split(/\r?\n/u)[0]}`, () => {
    const result = runHook(message);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

const invalidMessages = [
  "",
  "update readme\n",
  "feature: 操作を追加\n",
  "Feat: 操作を追加\n",
  "feat: \n",
  "feat:   \n",
  "feat:説明\n",
  "feat(): 操作を追加\n",
  "feat( ): 操作を追加\n",
  "feat(dial: 操作を追加\n",
  "\nfeat: 操作を追加\n",
];

for (const message of invalidMessages) {
  test(`不正な形式を拒否する: ${JSON.stringify(message)}`, () => {
    const result = runHook(message);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Conventional Commits/u);
  });
}
