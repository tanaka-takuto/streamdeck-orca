import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { activeInputImage } = await loadModule("src/active-input-image.ts");
for (const phase of [
  "受付済み",
  "入力拒否",
  "結果未確認",
  "入力中止",
  "受付確認中",
  "更新待ち",
  "設定で確認",
])
  test(`結果が${phase}でもEnter有無を失わない`, () => {
    const off = decodeURIComponent(
        activeInputImage(undefined, "label", false, phase),
      ),
      on = decodeURIComponent(
        activeInputImage(undefined, "label", true, phase),
      );
    assert.notEqual(off, on);
    assert.match(off, />入力のみ</);
    assert.match(on, />入力＋Enter</);
    assert.ok(off.includes(phase) && on.includes(phase));
  });
