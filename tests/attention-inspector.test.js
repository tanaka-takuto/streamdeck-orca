import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function fixture() {
  const base = "com.tanaka-takuto.orca.sdPlugin/ui/attention";
  const nodes = new Map(
    [...readFileSync(`${base}.html`, "utf8").matchAll(/id="([^"]+)"/gu)].map(
      ([, id]) => [
        id,
        {
          textContent: "",
          disabled: id === "refresh",
          dataset: {},
          listeners: {},
          addEventListener(e, f) {
            this.listeners[e] = f;
          },
          setAttribute(k, v) {
            this[k] = v;
          },
        },
      ],
    ),
  );
  let socket;
  const sent = [],
    timers = new Map();
  let sequence = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    constructor() {
      socket = this;
    }
    send(s) {
      sent.push(JSON.parse(s));
    }
    addEventListener(e, f) {
      this.listeners[e] = f;
    }
  }
  const window = {};
  vm.runInNewContext(readFileSync(`${base}.js`, "utf8"), {
    document: { getElementById: (id) => nodes.get(id) },
    window,
    WebSocket: Socket,
    setTimeout: (f, ms) => {
      const id = ++sequence;
      timers.set(id, { f, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  window.connectElgatoStreamDeckSocket(
    1234,
    "pi",
    "register",
    "{}",
    JSON.stringify({ context: "key", action: "attention", payload: {} }),
  );
  socket.listeners.open();
  const deliver = (view, requestId = sent.at(-1).payload.requestId) =>
    socket.listeners.message({
      data: JSON.stringify({
        event: "sendToPropertyInspector",
        payload: { type: "attention-view", actionId: "key", requestId, view },
      }),
    });
  return {
    nodes,
    sent,
    deliver,
    poll() {
      [...timers.values()].find((t) => t.ms === 2000).f();
    },
  };
}
const view = {
  coverage: "complete",
  counts: {
    waiting: 1,
    review: 1,
    unknown: 0,
    workspaces: 2,
    agents: 2,
    working: 0,
  },
  current: {
    name: "A",
    project: "P",
    path: "/a",
    tag: "abcdefg",
    kind: "waiting",
  },
};
test("自動更新で更新ボタンを無効化せず、通信中の追加更新要求を溜めない", () => {
  const f = fixture();
  f.deliver(view);
  assert.equal(f.nodes.get("refresh").disabled, false);
  f.poll();
  assert.equal(f.nodes.get("refresh").disabled, false);
  const count = f.sent.length;
  f.nodes.get("refresh").listeners.click();
  assert.equal(f.sent.length, count);
});
test("切断・部分取得を0件の確定表示とせず、古い要求の結果で対象を上書きしない", () => {
  const f = fixture();
  f.deliver(view);
  f.poll();
  f.deliver(
    { ...view, current: { ...view.current, name: "古い" } },
    "obsolete",
  );
  assert.equal(f.nodes.get("target-name").textContent, "A");
  f.deliver({
    ...view,
    coverage: "offline",
    error: "接続失敗",
    current: undefined,
  });
  assert.match(f.nodes.get("counts").textContent, /確認できません/u);
  assert.equal(f.nodes.get("target-name").textContent, "取得できません");
});

test("初回取得中をWSなしと断定しない", () => {
  const f = fixture();
  f.deliver({
    ...view,
    coverage: "loading",
    current: undefined,
    counts: {
      waiting: 0,
      review: 0,
      unknown: 0,
      workspaces: 0,
      agents: 0,
      working: 0,
    },
  });
  assert.equal(f.nodes.get("target-reason").textContent, "候補を確認中です");
});
