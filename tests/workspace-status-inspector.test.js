import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const base = "com.tanaka-takuto.orca.sdPlugin/ui/workspace-status";
function fixture() {
  const nodes = new Map(
    [...readFileSync(`${base}.html`, "utf8").matchAll(/id="([^"]+)"/gu)].map(
      ([, id]) => [
        id,
        {
          value: "",
          textContent: "",
          disabled: true,
          dataset: {},
          listeners: {},
          children: [],
          addEventListener(t, f) {
            this.listeners[t] = f;
          },
          replaceChildren() {
            this.children = [];
            this.value = "";
          },
          append(o) {
            this.children.push(o);
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
    addEventListener(t, f) {
      this.listeners[t] = f;
    }
  }
  const window = {};
  vm.runInNewContext(readFileSync(`${base}.js`, "utf8"), {
    window,
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: () => ({}),
    },
    WebSocket: Socket,
    setTimeout: (fn, ms) => {
      const id = ++n;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  window.connectElgatoStreamDeckSocket(
    1,
    "pi",
    "register",
    "{}",
    JSON.stringify({
      context: "key",
      action: "com.tanaka-takuto.orca.workspace-status",
      payload: { settings: { workspaceButtonVersion: 1 } },
    }),
  );
  socket.listeners.open();
  const request = () =>
    sent.filter((x) => x.event === "sendToPlugin").at(-1)?.payload.requestId;
  return {
    nodes,
    sent,
    request,
    deliver(p, requestId = request()) {
      socket.listeners.message({
        data: JSON.stringify({
          event: "sendToPropertyInspector",
          payload: {
            type: "workspace-button-view",
            actionId: "key",
            requestId,
            ...p,
          },
        }),
      });
    },
    settings(s) {
      socket.listeners.message({
        data: JSON.stringify({
          event: "didReceiveSettings",
          payload: { settings: s },
        }),
      });
    },
    poll() {
      const pair = [...timers].find(([, x]) => x.ms === 2000);
      if (pair) {
        timers.delete(pair[0]);
        pair[1].fn();
      }
    },
    close() {
      socket.listeners.close();
    },
    click(id) {
      nodes.get(id).listeners.click();
    },
    choose(key) {
      nodes.get("reference").value = key;
      nodes.get("reference").listeners.change();
    },
  };
}
const ref = (n, label = `PR #${n}`) => ({
  key: `p${n}`,
  label,
  url: `https://github.com/acme/app/pull/${n}`,
});
const view = (id = "A", extra = {}) => ({
  workspaceName: `WS ${id}`,
  workspace: { workspaceId: id, workspaceName: `WS ${id}` },
  workspaceIdentity: {
    id,
    project: "P",
    projectLabel: "P",
    path: `/${id}`,
    tag: "abcdefg",
  },
  status: "waiting",
  settings: {
    workspaceButtonVersion: 1,
    workspace: { workspaceId: id, workspaceName: `WS ${id}` },
  },
  revision: `rev-${id}`,
  ready: true,
  candidates: [ref(1)],
  chosen: ref(1),
  ...extra,
});
test("unique automatic reference does not stop advertised two-second refresh", () => {
  const f = fixture();
  f.deliver(view());
  const before = f.sent.length;
  f.poll();
  assert.ok(f.sent.length > before);
});
test("unsaved choice is preserved for same WS but reset across reassignment", () => {
  const f = fixture();
  f.deliver(view("A", { candidates: [ref(1), ref(2)] }));
  f.choose("p2");
  f.settings(view("A").settings);
  f.deliver(view("A", { candidates: [ref(1), ref(2)] }));
  assert.equal(f.nodes.get("reference").value, "p2");
  f.settings(view("B").settings);
  f.deliver(view("B", { candidates: [ref(1), ref(2, "Different B ref")] }));
  assert.equal(f.nodes.get("reference").value, "p1");
});
test("obsolete request cannot resurrect old path or reference", () => {
  const f = fixture(),
    old = f.request();
  f.settings(view("B").settings);
  f.deliver(view("A"), old);
  assert.ok(!f.nodes.get("workspace-identity").textContent.includes("/A"));
  f.deliver(view("B"));
  assert.match(f.nodes.get("workspace-identity").textContent, /\/B/);
});
test("close disables links and clears confirmed path/reference information", () => {
  const f = fixture();
  f.deliver(view());
  f.close();
  assert.equal(f.nodes.get("reference").disabled, true);
  assert.equal(f.nodes.get("save-reference").disabled, true);
  assert.ok(!f.nodes.get("workspace-identity").textContent.includes("/A"));
  assert.ok(
    !f.nodes.get("link-status").textContent.includes("https://github.com"),
  );
});
