# streamdeck-orca

Stream Deck + から Orca を操作するプラグイン。

## 開発環境のセットアップ

Node.js 22.12.0 以上と npm、Git が必要です。リポジトリのルートで実行してください。

```sh
npm ci
git config --local core.hooksPath .githooks
```

`core.hooksPath` はクローンごとの設定です。新しくクローンした場合も上記のコマンドを実行してください。
設定は `git config --get core.hooksPath` で確認できます。

## Git フック

フックは `.githooks/` で管理します。

- `pre-commit`: `npm run lint` でプロジェクト全体の JavaScript・TypeScript・JSON などを Biome で lint・整形チェックします。エラーがある場合はコミットを拒否します。ステージしていない変更もチェック対象です。
- `commit-msg`: 自作の `.githooks/check-commit-message.mjs` で先頭行が [Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) 形式かを検証し、不正なメッセージを拒否します。検証スクリプトは Node.js の標準機能のみを使用し、commitlint などの追加ツールは使いません。

コミットメッセージの形式は `type(scope): 説明` です。`scope` は省略できます。破壊的変更は `feat(api)!: 説明` のように `!` を付けて示せます。

```text
feat: Orca のワークツリーを切り替えるアクションを追加
fix(dial): ダイヤルの回転方向を修正
chore: Git フックを設定
```

使用できる type は `build`、`chore`、`ci`、`docs`、`feat`、`fix`、`perf`、`refactor`、`revert`、`style`、`test` です。
type は小文字で指定し、コロンの後には半角スペースと空でない説明を書いてください。本文・フッターは検証対象外です。

## チェックと修正

```sh
npm run lint
npm run lint:fix
npm test
```

`lint:fix` は安全に自動修正できる lint エラーと整形を修正します。変更内容を確認し、`git add` してからコミットしてください。
