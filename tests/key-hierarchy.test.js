import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { keyImage } = await loadModule("src/workspace-buttons.ts");
const { attentionImage } = await loadModule("src/attention-image.ts");
const { activeInputImage } = await loadModule("src/active-input-image.ts");
const { oldestReviewImage } = await loadModule("src/oldest-pr-controller.ts");
const { workspaceIdentity, workspaceTag } = await loadModule(
  "src/workspace-identity.ts",
);
const decode = (image) =>
  decodeURIComponent(image.slice(image.indexOf(",") + 1));
const texts = (image) =>
  [...decode(image).matchAll(/<text\b([^>]*)>([^<]*)<\/text>/gu)].map(
    ([, attrs, text]) => ({
      text,
      size: Number(/font-size="([\d.]+)"/u.exec(attrs)?.[1]),
    }),
  );
const workspace = {
  id: "w",
  name: "決済修正",
  project: "sateto",
  hostId: "local",
  agents: [],
};
const context = workspaceIdentity(workspace.id, workspace, [workspace]);
const view = {
  current: { workspace, kind: "waiting" },
  candidates: [{ workspace, kind: "waiting" }],
  coverage: "complete",
  fromCache: false,
  counts: {
    waiting: 3,
    review: 2,
    unknown: 0,
    working: 4,
    workspaces: 9,
    agents: 12,
  },
};

test("WSキーは名前を大きくし、短タグと常時操作説明を省く", () => {
  const image = keyImage(workspace.name, "waiting", 0, context);
  assert.ok(texts(image).some((t) => t.text.includes("決済") && t.size >= 26));
  assert.ok(!decode(image).includes(workspaceTag(workspace.id)));
  assert.doesNotMatch(decode(image), /短押しで移動/u);
  assert.match(decode(image), /入力待ち/u);
});
test("確認先は名前を優先し、候補内訳と繰り返し操作説明を通常面に積まない", () => {
  const image = attentionImage(view);
  assert.ok(texts(image).some((t) => t.text.includes("決済") && t.size >= 26));
  assert.doesNotMatch(decode(image), /押して開く|入力 3|返答 2/u);
});
test("入力キーはaliasを主情報にし、宛先と完全な位置と送信有無を保つ", () => {
  const recipient = {
    workspace,
    context,
    target: { identity: "codex" },
    location: "T1 左",
  };
  for (const enter of [false, true]) {
    const image = activeInputImage(recipient, "レビュー", enter, "前回不明");
    assert.ok(
      texts(image).some((t) => t.text.includes("レビュー") && t.size >= 26),
    );
    assert.ok(
      texts(image).some((t) => t.text.includes("T1 左") && t.size >= 20),
    );
    assert.ok(
      texts(image).some(
        (t) => t.text.includes("sateto") || t.text.includes("決済"),
      ),
    );
    assert.ok(
      texts(image).some(
        (t) => t.text === (enter ? "送信" : "入力") && t.size >= 20,
      ),
    );
    assert.match(decode(image), /不明/u);
    assert.doesNotMatch(decode(image), /押して入力|codex/u);
  }
});
test("PRキーは件数を大きくし、repoと番号と起動効果を残してAI種別・hash・固定説明を省く", () => {
  const image = oldestReviewImage({
    count: 12,
    pr: { repo: "acme/app", number: 42 },
    handoff: "send",
    agent: "claude",
    phase: "押:AI起動/WS",
  });
  assert.ok(texts(image).some((t) => t.text === "12" && t.size >= 44));
  for (const word of ["acme", "app", "#42", "送信"])
    assert.match(decode(image), new RegExp(word, "u"));
  assert.doesNotMatch(decode(image), /Claude|押:|レビュー待ち/u);
  assert.ok(!decode(image).includes(workspaceTag("acme/app")));
});
test("削ったタグで見分けられないWSを、同じ描画投影で衝突として扱う", () => {
  const a = { ...workspace, id: "a" },
    b = { ...workspace, id: "b" };
  assert.equal(workspaceIdentity(a.id, a, [a, b]).ambiguous, true);
  const i = {
    id: "a",
    name: "aaaaaaaaaaaaaaa_shared_tail",
    project: "longproject-A",
  };
  const j = {
    id: "b",
    name: "aaaaaaaaaaaaaaa_shared_tail",
    project: "longproject-B",
  };
  const first = workspaceIdentity(i.id, i, [i, j], "input");
  const second = workspaceIdentity(j.id, j, [i, j], "input");
  // Input keys use a shorter combined WS caption; their own projection must be compared.
  assert.equal(first.ambiguous, true);
  assert.equal(second.ambiguous, true);
});

test("PR起動結果の不明と起動記録の取得失敗は区別する", () => {
  const base = {
    count: 1,
    pr: { repo: "acme/app", number: 1 },
    phase: "",
    handoff: "send",
  };
  const unknown = decodeURIComponent(
    oldestReviewImage({ ...base, recordStatus: "unknown" }),
  );
  const unavailable = decodeURIComponent(
    oldestReviewImage({ ...base, recordStatus: "unavailable" }),
  );
  assert.notEqual(unknown, unavailable);
  assert.match(unknown, />不明</u);
  assert.match(unavailable, />取得失敗</u);
  assert.doesNotMatch(unavailable, />送信</u);
});

test("起動済みPRでも直近の移動失敗はチェック済み受付に隠さない", () => {
  const image = decodeURIComponent(
    oldestReviewImage({
      count: 1,
      pr: { repo: "acme/app", number: 1 },
      phase: "起動失敗・設定で確認",
      handoff: "send",
      recordStatus: "accepted",
      error: true,
    }),
  );
  assert.match(image, />失敗</u);
  assert.match(image, /data-icon="warning"/u);
  assert.doesNotMatch(image, />受付<|>送信</u);
});
