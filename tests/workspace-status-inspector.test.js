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
  references: [ref(1)],
  ...extra,
});
test("全件を選択欄なしで表示し、二秒の自動更新はブラウザー起動や保存をしない", () => {
  const f = fixture();
  f.deliver(view("A", { references: [ref(1), ref(2)] }));
  assert.equal(f.nodes.get("references").children.length, 2);
  assert.match(f.nodes.get("references").children[1].textContent, /pull\/2/u);
  assert.match(f.nodes.get("link-status").textContent, /2件/u);
  assert.doesNotMatch(
    readFileSync(`${base}.html`, "utf8"),
    /<select|id="save-reference"/u,
  );
  const before = f.sent.length;
  f.poll();
  assert.ok(f.sent.length > before);
  assert.ok(
    f.sent
      .filter((m) => m.event === "sendToPlugin")
      .every((m) => m.payload.type === "get-workspace-button"),
  );
  assert.ok(f.sent.every((m) => m.event !== "setSettings"));
});
test("関連先なしと取得失敗を区別し、再割当中は以前のWSの一覧を見せない", () => {
  const f = fixture();
  f.deliver(view("A"));
  f.settings(view("B").settings);
  assert.equal(f.nodes.get("references").children.length, 0);
  f.deliver(view("B", { references: [], linkError: "関連先なし" }));
  assert.match(f.nodes.get("link-status").textContent, /関連先なし/u);
  f.poll();
  f.deliver(
    view("B", { references: [], linkError: "取得失敗：応答を確認できません" }),
  );
  assert.match(f.nodes.get("link-status").textContent, /取得失敗/u);
});
test("古い応答から前のWS一覧を復活させず、切断時にも完全参照を消す", () => {
  const f = fixture(),
    old = f.request();
  f.settings(view("B").settings);
  f.deliver(view("A"), old);
  assert.ok(!f.nodes.get("workspace-identity").textContent.includes("/A"));
  f.deliver(view("B"));
  f.close();
  assert.equal(f.nodes.get("references").children.length, 0);
  assert.equal(f.nodes.get("refresh").disabled, true);
  assert.ok(!f.nodes.get("workspace-identity").textContent.includes("/B"));
});
test("ブラウザー要求済み・結果不明・中止で未送信をURL付きで区別する", () => {
  const f = fixture();
  f.deliver(
    view("A", {
      linkResult: {
        workspaceId: "A",
        workspaceName: "WS A",
        requested: [ref(1).url],
        unconfirmed: [{ url: ref(2).url, reason: "reply lost" }],
        notRequested: [ref(3).url],
      },
    }),
  );
  const text = f.nodes.get("link-result").textContent;
  assert.match(text, /要求済み.*1件/u);
  assert.match(text, /結果不明.*1件/u);
  assert.match(text, /未送信.*1件/u);
  for (const n of [1, 2, 3]) assert.ok(text.includes(ref(n).url));
  assert.doesNotMatch(text, /読込完了|表示完了/u);
});

test("進行中の起動要求を0件の完了結果と混同しない", () => {
  const f = fixture();
  f.deliver(
    view("A", {
      ready: false,
      linkResult: {
        workspaceId: "A",
        workspaceName: "WS A",
        total: 3,
        inProgress: true,
        requested: [],
        unconfirmed: [],
        notRequested: [],
      },
    }),
  );
  assert.match(f.nodes.get("link-result").textContent, /起動要求中.*0.*3/u);
});
