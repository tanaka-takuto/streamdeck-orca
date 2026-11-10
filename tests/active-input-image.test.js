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
    assert.match(off, />入力</);
    assert.match(on, />送信</);
    const visible = {
      受付済み: "受付",
      入力拒否: "拒否",
      結果未確認: "不明",
      入力中止: "中止",
      受付確認中: "処理",
      更新待ち: "更新",
      設定で確認: "設定",
    }[phase];
    assert.ok(off.includes(`>${visible}<`) && on.includes(`>${visible}<`));
  });
