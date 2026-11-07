import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function fixture(kind) {
  const base = `com.tanaka-takuto.orca.sdPlugin/ui/workspace-${kind}`;
  const nodes = new Map(
    [...readFileSync(`${base}.html`, "utf8").matchAll(/id="([^"]+)"/gu)].map(
      ([, id]) => [
        id,
        {
          value: "",
          textContent: "",
          dataset: {},
          listeners: {},
          addEventListener(event, fn) {
            this.listeners[event] = fn;
          },
          replaceChildren() {},
          add() {},
        },
      ],
    ),
  );
  let socket;
  const sent = [];
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
    addEventListener(event, fn) {
      this.listeners[event] = fn;
    }
  }
  const window = {};
  vm.runInNewContext(readFileSync(`${base}.js`, "utf8"), {
    window,
    document: { getElementById: (id) => nodes.get(id) },
    WebSocket: Socket,
    Option: class {},
    setTimeout: () => 1,
    clearTimeout() {},
  });
  window.connectElgatoStreamDeckSocket(
    1,
    "pi",
    "register",
    "{}",
    JSON.stringify({
      context: "key",
      action: `orca.workspace-${kind}`,
      payload: { settings: { controlId: "main" } },
    }),
  );
  socket.listeners.open();
  return {
    nodes,
    get requestId() {
      return sent.findLast((m) => m.event === "sendToPlugin").payload.requestId;
    },
    save() {
      nodes
        .get(kind === "status" ? "control-form" : "command-form")
        .listeners.submit({ preventDefault() {} });
      return sent.findLast((m) => m.event === "setSettings").payload;
    },
    acknowledge(settings) {
      socket.listeners.message({
        data: JSON.stringify({
          event: "didReceiveSettings",
          payload: { settings },
        }),
      });
    },
    deliver(
      identity,
      requestId = sent.findLast((m) => m.event === "sendToPlugin").payload
        .requestId,
    ) {
      socket.listeners.message({
        data: JSON.stringify({
          event: "sendToPropertyInspector",
          payload: {
            type: kind === "command" ? "execution-view" : "control-view",
            actionId: "key",
            requestId,
            controlId: "main",
            workspaceId: identity?.id,
            workspaceName: "長い完全なワークスペース名",
            status: "待機",
            available: 2,
            workspaceIdentity: identity,
            targets: [],
          },
        }),
      });
    },
    close() {
      socket.listeners.close();
    },
  };
}

for (const kind of ["status", "command"]) {
  test(`${kind}で同じ操作IDの設定保存中にも、古い応答からパスを復活させない`, () => {
    const f = fixture(kind);
    const oldRequestId = f.requestId;
    const saved = f.save();
    f.deliver(
      { id: "A", tag: "a", project: "old", path: "/late/old/path" },
      oldRequestId,
    );
    assert.match(f.nodes.get("workspace-identity").textContent, /保存後/u);
    assert.ok(
      !f.nodes.get("workspace-identity").textContent.includes("/late/old/path"),
    );
    f.acknowledge(saved);
    f.deliver({ id: "A", tag: "a", project: "new", path: "/new/path" });
    assert.match(f.nodes.get("workspace-identity").textContent, /\/new\/path/u);
  });
  test(`${kind}の詳細は完全な照合情報を表示し、古い応答で変更せず、取得不能でパスを残さない`, () => {
    const f = fixture(kind);
    const identity = {
      id: "workspace-full-id",
      tag: "abcdefg",
      project: "とても長いプロジェクト名",
      path: "/workspace/とても長い作業パス",
    };
    f.deliver(identity);
    for (const value of Object.values(identity))
      assert.ok(
        f.nodes.get("workspace-identity")?.textContent.includes(value),
        value,
      );
    f.deliver({ ...identity, path: "/stale" }, "obsolete");
    assert.ok(
      f.nodes.get("workspace-identity").textContent.includes(identity.path),
    );
    f.deliver({ id: identity.id, tag: identity.tag });
    assert.ok(
      !f.nodes.get("workspace-identity").textContent.includes(identity.path),
    );
    assert.match(f.nodes.get("workspace-identity").textContent, /未取得/u);
    f.deliver({ ...identity, project: "" });
    assert.match(
      f.nodes.get("workspace-identity").textContent,
      /プロジェクト: 未取得/u,
    );
    f.deliver(identity);
    f.close();
    assert.ok(
      !f.nodes.get("workspace-identity").textContent.includes(identity.path),
    );
    assert.match(f.nodes.get("workspace-identity").textContent, /切断/u);
  });
}
