import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceSelections, normalizeControlId } = await loadModule(
  "src/workspace-selections.ts",
);
const row = (id, name = id) => ({
  id,
  name,
  project: "Project",
  path: `/${id}`,
  hostId: "local",
  activity: "working",
  terminalVerdict: "live",
  agents: [{ paneKey: `tab:${id}`, state: "working" }],
});
const state = (rows) => ({
  snapshot: { runtimeId: "r", workspaces: rows, truncated: false },
  error: null,
});
function fixture(saved = {}) {
  let receive;
  let stopped = 0;
  const changes = [];
  const selections = new WorkspaceSelections(
    {
      subscribe(callback) {
        receive = callback;
        callback({ snapshot: null, error: null });
        return () => {
          stopped++;
        };
      },
    },
    (id, value) => changes.push({ id, ...value }),
  );
  selections.hydrate(saved);
  return {
    selections,
    changes,
    emit(value) {
      receive?.(value);
    },
    get stopped() {
      return stopped;
    },
  };
}

test("同じ操作 ID のキーとダイヤルだけが選択を共有する", () => {
  const f = fixture();
  const key = [],
    dial = [],
    other = [];
  f.selections.subscribe("main", (view) => key.push(view));
  f.selections.subscribe("main", (view) => dial.push(view));
  f.selections.subscribe("other", (view) => other.push(view));
  f.emit(state([row("a"), row("b"), row("c")]));
  f.selections.rotate("main", 1);
  assert.equal(key.at(-1).workspaceId, "b");
  assert.equal(dial.at(-1).workspaceId, "b");
  assert.equal(other.at(-1).workspaceId, "a");
});

test("新しいワークスペースは設定画面を開かず回転候補に追加される", () => {
  const f = fixture();
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a")]));
  f.emit(state([row("b"), row("a")]));
  assert.equal(f.selections.view("main").workspaceId, "a");
  f.selections.rotate("main", 1);
  assert.equal(f.selections.view("main").workspaceId, "b");
});

test("一覧の並びが変わっても選択した ID がずれない", () => {
  const f = fixture();
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), row("b")]));
  f.selections.rotate("main", 1);
  f.emit(state([row("b"), row("a")]));
  assert.equal(f.selections.view("main").workspaceId, "b");
});

test("回転の向き・複数 ticks・端での折り返しに対応する", () => {
  const f = fixture();
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), row("b"), row("c")]));
  f.selections.rotate("main", -1);
  assert.equal(f.selections.view("main").workspaceId, "c");
  f.selections.rotate("main", 2);
  assert.equal(f.selections.view("main").workspaceId, "b");
});

test("接続失敗中の回転で古い候補へ切り替えない", () => {
  const f = fixture();
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), row("b")]));
  f.emit({ snapshot: null, error: "offline" });
  f.selections.rotate("main", 1);
  assert.equal(f.selections.view("main").workspaceId, "a");
  assert.equal(f.selections.view("main").status, "unknown");
});

test("削除された割り当て先は不明を表示し、回転したときに有効な候補を選ぶ", () => {
  const f = fixture();
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), row("b")]));
  f.emit(state([row("b")]));
  assert.equal(f.selections.view("main").workspaceId, "a");
  assert.equal(f.selections.view("main").status, "unknown");
  f.selections.rotate("main", 1);
  assert.equal(f.selections.view("main").workspaceId, "b");
});

test("選択を操作 ID ごとに保存し、再起動後に復元する", () => {
  const f = fixture({ main: { workspaceId: "b", workspaceName: "B" } });
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), row("b")]));
  assert.equal(f.selections.view("main").workspaceId, "b");
  f.selections.rotate("main", 1);
  assert.deepEqual(f.changes.at(-1), {
    id: "main",
    workspaceId: "a",
    workspaceName: "a",
  });
});

test("全ての表示を外したら監視を止める", () => {
  const f = fixture();
  const a = f.selections.subscribe("main", () => {});
  const b = f.selections.subscribe("other", () => {});
  a();
  assert.equal(f.stopped, 0);
  b();
  assert.equal(f.stopped, 1);
});

test("空の ID は main、任意の文字列 ID はそのまま対応づける", () => {
  assert.equal(normalizeControlId(" "), "main");
  assert.equal(normalizeControlId(" 作業 A "), "作業 A");
  assert.equal(normalizeControlId("__proto__"), "__proto__");
});

const waitingRow = (id) => ({
  ...row(id),
  agents: [{ paneKey: `tab:${id}`, state: "waiting" }],
});

test("押し込みは現在位置の次から入力待ちだけを順送りし、同じ ID の表示に反映する", () => {
  const f = fixture({ main: { workspaceId: "c", workspaceName: "c" } });
  const key = [],
    mirror = [],
    other = [];
  f.selections.subscribe("main", (view) => key.push(view));
  f.selections.subscribe("main", (view) => mirror.push(view));
  f.selections.subscribe("other", (view) => other.push(view));
  f.emit(state([waitingRow("a"), row("b"), row("c"), waitingRow("d")]));
  assert.equal(f.selections.selectNextWaiting("main"), true);
  assert.equal(key.at(-1).workspaceId, "d");
  assert.equal(mirror.at(-1).workspaceId, "d");
  assert.equal(other.at(-1).workspaceId, "a");
  f.selections.selectNextWaiting("main");
  assert.equal(key.at(-1).workspaceId, "a", "末尾から先頭に戻る");
  assert.deepEqual(f.changes.at(-1), {
    id: "main",
    workspaceId: "a",
    workspaceName: "a",
  });
});

test("入力待ちがない・接続失敗・未取得の場合は選択を維持する", () => {
  const f = fixture({ main: { workspaceId: "a", workspaceName: "a" } });
  f.selections.subscribe("main", () => {});
  assert.equal(f.selections.selectNextWaiting("main"), false);
  f.emit(state([row("a"), row("b")]));
  assert.equal(f.selections.selectNextWaiting("main"), false);
  f.emit(state([row("a"), waitingRow("b")]));
  f.emit({ snapshot: null, error: "offline" });
  assert.equal(f.selections.selectNextWaiting("main"), false);
  assert.equal(f.selections.view("main").workspaceId, "a");
  assert.equal(f.changes.length, 0);
});

test("一つだけの入力待ちはそのまま維持し、状態が変わったら最新の候補を選ぶ", () => {
  const f = fixture({ main: { workspaceId: "b", workspaceName: "b" } });
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), waitingRow("b"), row("c")]));
  assert.equal(f.selections.selectNextWaiting("main"), true);
  assert.equal(f.selections.view("main").workspaceId, "b");
  assert.equal(f.changes.length, 0, "同じ選択を保存し直さない");
  f.emit(state([row("a"), row("b"), waitingRow("c")]));
  f.selections.selectNextWaiting("main");
  assert.equal(f.selections.view("main").workspaceId, "c");
});

test("選択先が消失している場合は最初の入力待ちを選ぶ", () => {
  const f = fixture({ main: { workspaceId: "missing", workspaceName: "old" } });
  f.selections.subscribe("main", () => {});
  f.emit(state([row("a"), waitingRow("b"), waitingRow("c")]));
  f.selections.selectNextWaiting("main");
  assert.equal(f.selections.view("main").workspaceId, "b");
});
