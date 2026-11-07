import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { keyImage } = await loadModule("src/workspace-buttons.ts");
const { commandImage } = await loadModule("src/command-image.ts");
const { workspaceTag } = await loadModule("src/attention-image.ts");
const { displayName } = await loadModule("src/attention-image.ts");
const text = (image) =>
  [...decodeURIComponent(image).matchAll(/<text\b[^>]*>([^<]*)<\/text>/gu)]
    .map((m) => m[1])
    .join("");

test("正準同値とASCII空白は表示前に揃え、互換字とZWJは変えない", () => {
  assert.equal(keyImage("Cafe\u0301", "waiting"), keyImage("Café", "waiting"));
  assert.equal(keyImage(" a  b\t", "waiting"), keyImage("a b", "waiting"));
  assert.notEqual(keyImage("Ａ", "waiting"), keyImage("A", "waiting"));
  assert.ok(text(keyImage("👨‍👩‍👧‍👦", "waiting")).includes("👨‍👩‍👧‍👦"));
});

test("長い全角ワークスペース名は先頭と末尾を残して、末尾違いを見分けられる", () => {
  for (const render of [
    (name) => keyImage(name, "waiting"),
    (name) => commandImage(name, "テスト", "shell", "押して実行"),
  ]) {
    const a = render("個人事業主テックビーバー_改善123");
    const b = render("個人事業主テックビーバー_改善456");
    assert.notEqual(a, b);
    assert.match(text(a), /個人.*123/u);
    assert.match(text(b), /個人.*456/u);
  }
});

test("確認先の名前に候補数で変わる順位を付けず、同じ対象の名前を保つ", () => {
  const candidates = ["a", "b"].map((id) => ({
    workspace: { id, name: "main", project: "P" },
  }));
  assert.equal(displayName({ current: candidates[1], candidates }), "main");
  assert.equal(
    displayName({ current: candidates[1], candidates: [candidates[1]] }),
    "main",
  );
});

test("状態と実行のキーは、同名の別ワークスペースを同じプロジェクトと短タグで照合できる", () => {
  const a = { id: "workspace-a", project: "sateto" };
  const b = { id: "workspace-b", project: "sateto" };
  for (const render of [
    (identity) => keyImage("main", "review", 0, identity),
    (identity) => commandImage("main", "テスト", "shell", "要求中", identity),
  ]) {
    const first = render(a);
    const second = render(b);
    assert.notEqual(first, second);
    assert.ok(text(first).includes("sateto"));
    assert.ok(text(first).includes(workspaceTag(a.id)));
    assert.ok(text(second).includes(workspaceTag(b.id)));
  }
});

test("長い操作ラベルは末尾と絵文字の書記素を保持し、作用の種類も表示する", () => {
  const label = "現在の変更をすべて確認してから実行する👨‍👩‍👧‍👦";
  const ai = commandImage("アクティブAI", label, "ai", "入力＋Enter");
  const shell = commandImage("作業", label, "shell", "受付済み");
  for (const image of [ai, shell]) {
    assert.ok(text(image).includes("👨‍👩‍👧‍👦"));
    assert.match(text(image), /現在.*…/u);
  }
  assert.match(text(ai), /AI.*入力＋Enter/u);
  assert.match(text(shell), /SHELL.*受付済み/u);
});
