import { readFileSync } from "node:fs";

const types = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];

if (process.argv.length !== 3) {
  console.error(
    "使い方: node .githooks/check-commit-message.mjs <メッセージファイル>",
  );
  process.exit(1);
}

let message;
try {
  message = readFileSync(process.argv[2], "utf8");
} catch (error) {
  console.error(`コミットメッセージを読み込めません: ${error.message}`);
  process.exit(1);
}

const header = message.split(/\r?\n/u)[0];
const match = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: (\S.*)$/u.exec(header);

if (
  !match ||
  !types.includes(match[1]) ||
  (match[2] !== undefined && match[2].trim().length === 0)
) {
  console.error(
    "コミットメッセージの先頭行を Conventional Commits 形式にしてください。\n" +
      "形式: type(scope)!: 説明（scope と ! は省略可）\n" +
      "例: feat: Orca の操作を追加\n" +
      `使用できる type: ${types.join(", ")}`,
  );
  process.exit(1);
}
