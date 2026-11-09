import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const base = "com.tanaka-takuto.orca.sdPlugin/ui/oldest-pr-review";
function fixture(initial = {}) {
  const nodes = new Map(
    [...readFileSync(`${base}.html`, "utf8").matchAll(/id="([^"]+)"/gu)].map(
      ([, id]) => [
        id,
        {
          value: "",
          checked: false,
          disabled: true,
          listeners: {},
          addEventListener(name, fn) {
            this.listeners[name] = fn;
          },
        },
      ],
    ),
  );
  const sent = [],
    timers = new Map();
  let socket,
    n = 0;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    constructor() {
      socket = this;
    }
    send(raw) {
      sent.push(JSON.parse(raw));
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
  }
  const window = {};
  vm.runInNewContext(readFileSync(`${base}.js`, "utf8"), {
    document: { getElementById: (id) => nodes.get(id) },
    window,
    WebSocket: Socket,
    setTimeout(fn, ms) {
      const id = ++n;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  window.connectElgatoStreamDeckSocket(
    1,
    "pi",
    "register",
    "{}",
    JSON.stringify({
      context: "key",
      action: "com.tanaka-takuto.orca.oldest-pr-review",
      payload: { settings: initial },
    }),
  );
  socket.listeners.open();
  const receive = (event, payload) =>
    socket.listeners.message({ data: JSON.stringify({ event, payload }) });
  const request = () =>
    sent.findLast((m) => m.event === "sendToPlugin")?.payload;
  const candidate = {
    repo: "acme/app",
    number: 1,
    title: "PR",
    url: "https://github.com/acme/app/pull/1",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  return {
    nodes,
    sent,
    request,
    receive,
    view(extra = {}, id = request()?.requestId) {
      receive("sendToPropertyInspector", {
        type: "oldest-pr-view",
        actionId: "key",
        requestId: id,
        settings: initial,
        candidate,
        selected: candidate,
        count: 1,
        account: "me",
        accountId: 7,
        ...extra,
      });
    },
    save() {
      nodes.get("review-form").listeners.submit({ preventDefault() {} });
      return sent.findLast((m) => m.event === "setSettings")?.payload;
    },
    mode(value) {
      nodes.get("handoff").value = value;
      nodes.get("handoff").listeners.change();
    },
    poll() {
      const item = [...timers].find(([, v]) => v.ms === 2000);
      assert.ok(item);
      timers.delete(item[0]);
      item[1].fn();
    },
    close() {
      socket.readyState = 3;
      socket.listeners.close();
    },
  };
}
test("起動だけは空本文で保存でき、送信モードの空本文は保存しない", () => {
  const f = fixture({ custom: "keep", body: "" });
  assert.equal(f.nodes.get("body").disabled, true);
  const saved = f.save();
  assert.equal(saved.handoff, "none");
  assert.equal(saved.body, "");
  assert.equal(saved.custom, "keep");
  assert.equal(
    f.sent.some(
      (m) => m.event === "sendToPlugin" && m.payload.type.includes("launch"),
    ),
    false,
  );
  const g = fixture({ body: "" });
  g.mode("send");
  assert.equal(g.nodes.get("body").disabled, false);
  assert.equal(g.save(), undefined);
});
test("不完全・未取得・0件を混同せず、接続切断では確認済みPR情報を消す", () => {
  const f = fixture();
  f.view({
    selected: undefined,
    candidate: undefined,
    count: 0,
    partial: true,
  });
  assert.doesNotMatch(f.nodes.get("selected").textContent, /依頼はありません/u);
  assert.match(f.nodes.get("state").textContent, /未確定/u);
  f.poll();
  f.view({ selected: undefined, candidate: undefined, count: undefined });
  assert.doesNotMatch(f.nodes.get("selected").textContent, /依頼はありません/u);
  f.poll();
  f.view({ selected: undefined, candidate: undefined, count: 0 });
  assert.match(f.nodes.get("selected").textContent, /依頼はありません/u);
  f.poll();
  f.view();
  f.close();
  assert.equal(f.nodes.get("save").disabled, true);
  assert.doesNotMatch(f.nodes.get("selected").textContent, /https:\/\//u);
  assert.equal(f.nodes.get("forget").disabled, true);
});
test("設定保存中の古い応答を無視し、記録解除は同じaccount・PR・operationに束縛", () => {
  const f = fixture({ body: "review" });
  const old = f.request().requestId;
  const saved = f.save();
  f.view({}, old);
  assert.match(f.nodes.get("selected").textContent, /保存中/u);
  f.receive("didReceiveSettings", {
    settings: { ...saved, revision: "wrong" },
  });
  assert.equal(f.request().requestId, old);
  f.receive("didReceiveSettings", { settings: saved });
  const previous = {
    operationId: "op1",
    pr: { repo: "acme/app", number: 1, sha: "a".repeat(40) },
    message: "unknown",
  };
  f.view({ settings: saved, previous });
  f.nodes.get("confirmed").checked = true;
  f.nodes.get("confirmed").listeners.change();
  assert.equal(f.nodes.get("forget").disabled, false);
  f.poll();
  f.view({ settings: saved, previous: { ...previous, operationId: "op2" } });
  assert.equal(f.nodes.get("confirmed").checked, false);
  assert.equal(f.nodes.get("forget").disabled, true);
});
