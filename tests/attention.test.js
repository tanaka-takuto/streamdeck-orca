import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { AttentionQueue, attentionTarget, matchesAttentionTarget } =
  await loadModule("src/attention.ts");
const ws = (id, states, extra = {}) => ({
  id,
  name: id,
  project: "Project",
  path: `/${id}`,
  hostId: "local",
  terminalVerdict: "live",
  activity: "working",
  agents: states.map((state, i) => ({
    paneKey: `tab:${id}-${i}`,
    state,
    stateStartedAt: i + 1,
  })),
  ...extra,
});
const snap = (workspaces, extra = {}) => ({
  runtimeId: "r1",
  truncated: false,
  workspaces,
  ...extra,
});
const state = (snapshot, extra = {}) => ({ snapshot, error: null, ...extra });

test("待ちと返答をWS単位で数え、進行中や不明に埋もれた返答も発見する", () => {
  const q = new AttentionQueue();
  q.update(
    state(
      snap([
        ws("a", ["waiting", "done"]),
        ws("b", ["working", "done"]),
        ws("c", ["unknown", "blocked"]),
        ws("d", ["working"]),
      ]),
    ),
  );
  assert.deepEqual(q.view.counts, {
    waiting: 1,
    review: 2,
    unknown: 1,
    working: 2,
    workspaces: 4,
    agents: 7,
  });
  assert.deepEqual(
    q.view.candidates.map((x) => x.workspace.id),
    ["a", "b", "c"],
  );
  assert.equal(q.view.coverage, "unknown");
});
test("成功後だけ巡回し、未解消の待ちが返答候補を塞がず、件数も減らない", () => {
  const q = new AttentionQueue();
  const s = state(
    snap([ws("a", ["waiting"]), ws("b", ["waiting"]), ws("c", ["done"])]),
  );
  q.update(s);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    seen.push(q.view.current.workspace.id);
    q.advance(attentionTarget(q.view));
    q.update(s);
  }
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(q.view.current.workspace.id, "a");
  assert.equal(q.view.candidates.length, 3);
});
test("押下対象はruntime・host・理由・ペインのエピソードに固定され、変化は一致しない", () => {
  const q = new AttentionQueue();
  const w = ws("a", ["waiting"]);
  q.update(state(snap([w])));
  const t = attentionTarget(q.view);
  assert.equal(matchesAttentionTarget(snap([w]), t), true);
  for (const s of [
    snap([w], { runtimeId: "r2" }),
    snap([{ ...w, hostId: "remote" }]),
    snap([ws("a", ["done"])]),
    snap([{ ...w, agents: [{ ...w.agents[0], stateStartedAt: 999 }] }]),
    snap([]),
  ])
    assert.equal(matchesAttentionTarget(s, t), false);
});
test("保持表示は新規候補を割り当てず、失敗と部分取得をゼロ件の安心にしない", () => {
  const q = new AttentionQueue();
  q.update(state(snap([ws("a", ["waiting"])]), { fromCache: true }));
  assert.equal(q.view.current, undefined);
  q.update(state(snap([ws("a", ["waiting"])])));
  q.update(state(snap([ws("b", ["waiting"])]), { fromCache: true }));
  assert.equal(q.view.current.workspace.id, "a");
  assert.equal(q.view.fromCache, true);
  q.update({ snapshot: null, error: "offline" });
  assert.equal(q.view.coverage, "offline");
  assert.equal(q.view.current, undefined);
  q.update(state(snap([], { truncated: true })));
  assert.equal(q.view.coverage, "partial");
});
test("新規候補は自動で追加し、表示対象は更新だけで無意味に先頭へ戻さない", () => {
  const q = new AttentionQueue();
  q.update(state(snap([ws("a", ["done"])])));
  q.update(state(snap([ws("a", ["done"]), ws("b", ["waiting"])])));
  assert.equal(q.view.current.workspace.id, "a");
  q.advance(attentionTarget(q.view));
  assert.equal(q.view.current.workspace.id, "b");
});

test("未取得ホストがあれば、見えている候補がゼロでも全体取得と呼ばない", () => {
  const q = new AttentionQueue();
  q.update(state(snap([], { omittedHosts: true })));
  assert.equal(q.view.coverage, "partial");
  assert.equal(q.view.candidates.length, 0);
});
