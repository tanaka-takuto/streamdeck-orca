import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function fixture() {
  const html = readFileSync(
    "com.tanaka-takuto.orca.sdPlugin/ui/pr-review.html",
    "utf8",
  );
  const nodes = new Map(
    [...html.matchAll(/id="([^"]+)"/gu)].map(([, id]) => [
      id,
      {
        value: "",
        checked: false,
        disabled: true,
        listeners: {},
        addEventListener(n, f) {
          this.listeners[n] = f;
        },
      },
    ]),
  );
  const sent = [],
    timers = new Map();
  let id = 0,
    socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    constructor() {
      socket = this;
    }
    addEventListener(n, f) {
      this.listeners[n] = f;
    }
    send(raw) {
      sent.push(JSON.parse(raw));
    }
  }
  const window = {};
  vm.runInNewContext(
    readFileSync("com.tanaka-takuto.orca.sdPlugin/ui/pr-review.js", "utf8"),
    {
      document: { getElementById: (id) => nodes.get(id) },
      window,
      WebSocket: Socket,
      setTimeout(fn, ms) {
        timers.set(++id, { fn, ms });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  window.connectElgatoStreamDeckSocket(
    1,
    "pi",
    "register",
    "{}",
    JSON.stringify({
      context: "dial",
      action: "review",
      payload: { settings: { body: "review", enter: false } },
    }),
  );
  socket.listeners.open();
  const receive = (event, payload) =>
    socket.listeners.message({ data: JSON.stringify({ event, payload }) });
  const candidate = {
    repo: "acme/app",
    number: 12,
    title: "PR",
    url: "https://github.com/acme/app/pull/12",
  };
  return {
    nodes,
    sent,
    timers,
    receive,
    view(extra = {}) {
      const request = sent.findLast((m) => m.event === "sendToPlugin").payload;
      receive("sendToPropertyInspector", {
        type: "pr-review-view",
        actionId: "dial",
        requestId: request.requestId,
        settings: { body: "review", enter: false },
        accountId: 7,
        account: "me",
        selected: candidate,
        candidate,
        count: 1,
        previous: {
          accountId: 7,
          pr: { ...candidate, sha: "a".repeat(40) },
          operationId: "old-operation",
          message: "前回の起動",
          status: "unknown",
        },
        ...extra,
      });
    },
    poll() {
      const timer = [...timers.values()].find((t) => t.ms === 2000);
      assert.ok(timer);
      timer.fn();
    },
    save() {
      nodes.get("review-form").listeners.submit({ preventDefault() {} });
      return sent.findLast((m) => m.event === "setSettings").payload;
    },
    confirm() {
      nodes.get("confirmed").checked = true;
      nodes.get("confirmed").listeners.change();
    },
    close() {
      socket.readyState = 3;
      socket.listeners.close();
    },
  };
}
test("保存はEnter設定を保持し、AIを起動しない", () => {
  const f = fixture();
  f.nodes.get("enter").checked = true;
  const saved = f.save();
  assert.equal(saved.enter, true);
  assert.ok(
    !f.sent.some((m) =>
      /launch|dialDown|terminal/.test(m.payload?.type ?? m.event),
    ),
  );
});
test("保存中の旧ACKや旧設定の表示で編集を巻き戻さない", () => {
  const f = fixture();
  f.nodes.get("body").value = "new";
  f.save();
  f.receive("didReceiveSettings", {
    settings: { body: "old", revision: "old" },
  });
  f.view();
  assert.equal(f.nodes.get("body").value, "new");
  assert.doesNotMatch(f.nodes.get("selected").textContent, /acme/);
});
test("同じPRでもアカウントが変われば記録解除の確認を取り消す", () => {
  const f = fixture();
  f.view();
  f.confirm();
  f.poll();
  f.view({ accountId: 8, account: "other" });
  assert.equal(f.nodes.get("confirmed").checked, false);
  assert.equal(f.nodes.get("forget").disabled, true);
});
test("同じPRでも起動記録が変われば確認を取り消す", () => {
  const f = fixture();
  f.view();
  f.confirm();
  f.poll();
  f.view({
    previous: {
      operationId: "new-operation",
      status: "unknown",
      pr: { repo: "acme/app", number: 12, sha: "b".repeat(40) },
    },
  });
  assert.equal(f.nodes.get("confirmed").checked, false);
});
test("記録解除は表示した一件のアカウントと操作IDを送る", () => {
  const f = fixture();
  f.view();
  f.confirm();
  f.nodes.get("forget").listeners.click();
  const request = f.sent.at(-1).payload;
  assert.equal(request.type, "forget-pr-review");
  assert.equal(request.accountId, 7);
  assert.equal(request.operationId, "old-operation");
});
test("切断時は編集を残して保存と記録解除を無効にする", () => {
  const f = fixture();
  f.nodes.get("body").value = "unsaved";
  f.close();
  assert.equal(f.nodes.get("body").value, "unsaved");
  assert.equal(f.nodes.get("save").disabled, true);
  assert.equal(f.nodes.get("forget").disabled, true);
});
