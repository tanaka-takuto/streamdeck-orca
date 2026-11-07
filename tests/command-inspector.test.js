import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function inspector(settings) {
  const base = "com.tanaka-takuto.orca.sdPlugin/ui/workspace-command";
  const html = readFileSync(`${base}.html`, "utf8");
  const nodes = new Map(
    [...html.matchAll(/id="([^"]+)"/gu)].map(([, id]) => [
      id,
      {
        value: "",
        checked: false,
        disabled: true,
        dataset: {},
        listeners: {},
        addEventListener(name, listener) {
          this.listeners[name] = listener;
        },
      },
    ]),
  );
  const sent = [];
  let socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    listeners = {};
    constructor() {
      socket = this;
    }
    addEventListener(name, listener) {
      this.listeners[name] = listener;
    }
    send(value) {
      sent.push(JSON.parse(value));
    }
  }
  const window = {};
  vm.runInNewContext(readFileSync(`${base}.js`, "utf8"), {
    document: { getElementById: (id) => nodes.get(id) },
    window,
    WebSocket: Socket,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  window.connectElgatoStreamDeckSocket(
    1234,
    "pi",
    "register",
    "{}",
    JSON.stringify({
      context: "key",
      action: "command",
      payload: { settings },
    }),
  );
  socket.listeners.open();
  return {
    nodes,
    sent,
    save() {
      nodes.get("command-form").listeners.submit({ preventDefault() {} });
      return sent.findLast((message) => message.event === "setSettings")
        .payload;
    },
  };
}

test("自動クローズの二つのチェック項目を復元し、変更内容を設定として保存する", () => {
  const f = inspector({
    mode: "shell",
    body: "npm test",
    closeOnExit: true,
    closeOnSuccess: false,
  });
  assert.equal(f.nodes.get("close-on-exit")?.checked, true);
  assert.equal(f.nodes.get("close-on-success")?.checked, false);
  assert.equal(f.nodes.get("shell-options")?.hidden, false);
  f.nodes.get("close-on-exit").checked = false;
  f.nodes.get("close-on-success").checked = true;
  const saved = f.save();
  assert.equal(saved.closeOnExit, false);
  assert.equal(saved.closeOnSuccess, true);
  assert.equal(saved.body, "npm test");
  assert.equal(
    f.sent.some((message) => message.event === "keyDown"),
    false,
  );
});

test("既定は両方オフで、AI モードでは自動クローズ項目を隠す", () => {
  const f = inspector({ mode: "ai", body: "レビューして" });
  assert.equal(f.nodes.get("close-on-exit")?.checked, false);
  assert.equal(f.nodes.get("close-on-success")?.checked, false);
  assert.equal(f.nodes.get("shell-options")?.hidden, true);
});
