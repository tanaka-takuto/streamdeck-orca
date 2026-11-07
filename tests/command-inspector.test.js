import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function inspector(settings, name = "workspace-command") {
  const base = `com.tanaka-takuto.orca.sdPlugin/ui/${name}`;
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
    receiveSettings(value) {
      socket.listeners.message({
        data: JSON.stringify({
          event: "didReceiveSettings",
          payload: { settings: value },
        }),
      });
    },
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

test("アクティブ AI 入力は Enter オフが既定で、文字列と Enter 設定だけを保存しても入力しない", () => {
  const f = inspector({ body: "続けて" }, "active-ai-input");
  assert.equal(f.nodes.get("enter").checked, false);
  f.nodes.get("enter").checked = true;
  f.nodes.get("body").value = "変更を確認して";
  const saved = f.save();
  assert.equal(saved.enter, true);
  assert.equal(saved.body, "変更を確認して");
  assert.equal(Object.hasOwn(saved, "controlId"), false);
  assert.equal(
    f.sent.some((m) => m.event === "keyDown"),
    false,
  );
});

test("保存待ち中の遅い応答で編集中の文字列や Enter 設定を上書きしない", () => {
  const f = inspector({ body: "以前の文字列", enter: true }, "active-ai-input");
  f.nodes.get("body").value = "保存した文字列";
  const saved = f.save();
  f.nodes.get("body").value = "編集中の文字列";
  f.nodes.get("enter").checked = false;
  f.nodes.get("command-form").listeners.input();
  f.receiveSettings({ body: "古い応答", enter: true, revision: "old" });
  f.receiveSettings(saved);
  assert.equal(f.nodes.get("body").value, "編集中の文字列");
  assert.equal(f.nodes.get("enter").checked, false);
});

test("表示AIへの入力を明示確認して保存するまで、新しい宛先モードを有効にしない", () => {
  const f = inspector({ body: "keep", enter: true }, "active-ai-input");
  assert.equal(f.nodes.get("recipient-mode").checked, false);
  assert.equal(f.save().recipientMode, undefined);
  f.nodes.get("recipient-mode").checked = true;
  const s = f.save();
  assert.equal(s.recipientMode, "displayed-v1");
  assert.equal(s.body, "keep");
  assert.equal(s.enter, true);
});
