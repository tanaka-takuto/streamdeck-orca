import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function fixture() {
  const html = readFileSync(
      "com.tanaka-takuto.orca.sdPlugin/ui/change-radar.html",
      "utf8",
    ),
    nodes = new Map(
      [...html.matchAll(/id="([^"]+)"/gu)].map(([, id]) => [
        id,
        {
          value: "",
          disabled: true,
          listeners: {},
          addEventListener(n, f) {
            this.listeners[n] = f;
          },
        },
      ]),
    ),
    sent = [],
    timers = new Map();
  let n = 0,
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
    readFileSync("com.tanaka-takuto.orca.sdPlugin/ui/change-radar.js", "utf8"),
    {
      document: { getElementById: (id) => nodes.get(id) },
      window,
      WebSocket: Socket,
      setTimeout(fn, ms) {
        timers.set(++n, { fn, ms });
        return n;
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
      action: "radar",
      payload: { settings: { controlId: "main" } },
    }),
  );
  socket.listeners.open();
  return {
    nodes,
    sent,
    timers,
    receive(event, payload) {
      socket.listeners.message({ data: JSON.stringify({ event, payload }) });
    },
    save(value) {
      nodes.get("control-id").value = value;
      nodes.get("radar-form").listeners.submit({ preventDefault() {} });
      return sent.findLast((m) => m.event === "setSettings").payload;
    },
    view(controlId) {
      const request = sent.findLast((m) => m.event === "sendToPlugin").payload;
      socket.listeners.message({
        data: JSON.stringify({
          event: "sendToPropertyInspector",
          payload: {
            type: "radar-view",
            actionId: "dial",
            requestId: request.requestId,
            controlId,
            contact: { path: "stale" },
            displayed: {
              path: "stale",
              kind: "file",
              ranges: "r",
              base: "base",
              fingerprint: "fp",
              self: { workspace: { name: "SELF", path: "/self", id: "A" } },
              peer: { workspace: { name: "PEER", path: "/peer", id: "B" } },
            },
          },
        }),
      });
    },
  };
}
test("保存後も旧controlIdの返答を新しい割当に表示しない", () => {
  const f = fixture(),
    saved = f.save("new");
  f.receive("didReceiveSettings", { settings: saved });
  f.view("main");
  assert.doesNotMatch(f.nodes.get("details").textContent ?? "", /\/peer/u);
});
test("保存timeout後の旧ACKは本文やIDを巻き戻さず、操作も送信しない", () => {
  const f = fixture();
  f.save("new");
  const timer = [...f.timers.values()].find((t) => t.ms === 8000);
  timer.fn();
  f.receive("didReceiveSettings", {
    settings: { controlId: "old", revision: "old" },
  });
  assert.equal(f.nodes.get("control-id").value, "new");
  assert.equal(
    f.sent.some((m) => ["dialDown", "touchTap", "keyDown"].includes(m.event)),
    false,
  );
});
