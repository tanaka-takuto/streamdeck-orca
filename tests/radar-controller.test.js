import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { RadarController } = await loadModule("src/radar-controller.ts");
const tick = () => new Promise((r) => setImmediate(r));
const ws = (id) => ({
  id,
  name: id,
  project: "Repo",
  path: `/mock/${id}`,
  hostId: "local",
  agents: [],
  activity: "active",
  terminalVerdict: "live",
});
const a = ws("A"),
  b = ws("B");
function item(id = "one", extra = {}) {
  return {
    id,
    fingerprint: id,
    path: `${id}.ts`,
    kind: "lines",
    base: "a".repeat(40),
    self: { workspace: a, line: 5, open: "file" },
    peer: { workspace: b, line: 12, open: "file" },
    ranges: "共通基点5行",
    ...extra,
  };
}
async function fixture(t, rows = [item("one"), item("two")]) {
  let contacts = rows,
    visible,
    block = () => false;
  const releases = [],
    calls = [],
    listeners = new Set();
  let context = {
      view: { workspaceId: a.id, workspaceName: a.name, workspace: a },
      catalog: [a, b],
      runtimeId: "r",
      unavailable: false,
      partial: false,
    },
    nav = 0;
  const source = {
    observeControl(_id, fn) {
      listeners.add(fn);
      fn();
      return () => listeners.delete(fn);
    },
    controlContext: () => context,
    freshControlContext: async () => context,
    beginNavigation() {
      const v = ++nav;
      return () => v === nav;
    },
  };
  const scanner = {
    scan: async () => ({ contacts, compared: 1, skipped: [], at: Date.now() }),
    pair: async () => contacts,
  };
  const controller = new RadarController(
    source,
    scanner,
    async (args) => {
      calls.push(args);
      return { ok: true, _meta: { runtimeId: "r" }, result: { opened: true } };
    },
    {
      focusWorkspace: async (id) => {
        calls.push(["workspace", id]);
        return true;
      },
    },
    100000,
  );
  const dial = {
    id: "radar",
    async setFeedback(data) {
      if (block(data)) await new Promise((r) => releases.push(r));
      visible = data;
    },
    showAlert: async () => {},
  };
  controller.bind(dial, "main");
  await tick();
  t.after(() => {
    controller.unbind(dial.id);
    for (const r of releases) r();
  });
  return {
    controller,
    dial,
    source,
    scanner,
    calls,
    get visible() {
      return visible;
    },
    setContacts(x) {
      contacts = x;
    },
    setContext(x) {
      context = x;
      for (const f of listeners) f();
    },
    block(fn) {
      block = fn;
    },
    release() {
      block = () => false;
      for (const r of releases.splice(0)) r();
    },
  };
}
test("押下は自分、LCDtap相当は相手の明示WS/path/lineを開く", async (t) => {
  const f = await fixture(t);
  await f.controller.open("radar", "self");
  assert.deepEqual(f.calls[0], [
    "file",
    "open",
    "--path=one.ts",
    "--line",
    "5",
    "--worktree",
    "id:A",
    "--focus",
    "--json",
  ]);
  await tick();
  await f.controller.open("radar", "peer");
  assert.equal(f.calls[1][6], "id:B");
  assert.equal(f.calls[1][4], "12");
});
test("新接点のLCD送信待ちでは新しい相手を開かず、表示後の別押下だけ作用する", async (t) => {
  const f = await fixture(t);
  f.block((d) => d.file.includes("two.ts"));
  f.controller.rotate("radar", 1);
  await tick();
  assert.ok(f.visible.file.includes("one.ts"));
  await f.controller.open("radar", "peer");
  assert.equal(f.calls.length, 0);
  f.release();
  await tick();
  assert.equal(f.calls.length, 0);
  await f.controller.open("radar", "peer");
  assert.equal(f.calls[0][2], "--path=two.ts");
});
test("表示後にcode fingerprintが変わったら別の接点へ振り替えない", async (t) => {
  const f = await fixture(t);
  f.setContacts([item("one", { fingerprint: "changed" })]);
  await f.controller.open("radar", "self");
  assert.equal(f.calls.length, 0);
  assert.match(f.controller.view("radar").message, /変更内容が変わり/u);
});
test("取得待ちの追加回転やhiddenは旧押下を後の接点へ追従させない", async (t) => {
  for (const action of ["rotate", "hide"]) {
    const f = await fixture(t);
    let resolve;
    f.scanner.pair = async () =>
      new Promise((r) => {
        resolve = r;
      });
    const opening = f.controller.open("radar", "peer");
    await tick();
    if (action === "rotate") f.controller.rotate("radar", 1);
    else f.controller.unbind("radar");
    resolve([item("one"), item("two")]);
    await opening;
    assert.equal(f.calls.length, 0);
  }
});
test("indexだけの変更はstage差分へ、削除側はそのWSへ移動する", async (t) => {
  const f = await fixture(t, [
    item("one", {
      self: { workspace: a, line: 5, open: "staged" },
      peer: { workspace: b, line: 1, open: "workspace" },
    }),
  ]);
  await f.controller.open("radar", "self");
  assert.deepEqual(f.calls[0], [
    "file",
    "diff",
    "--path=one.ts",
    "--staged",
    "--worktree",
    "id:A",
    "--focus",
    "--json",
  ]);
  await tick();
  await f.controller.open("radar", "peer");
  assert.deepEqual(f.calls[1], ["workspace", "B"]);
});
test("同じLCD名と短タグになるpeerはfull IDを勝手に選んで開かない", async (t) => {
  const left = { ...b, id: "collision-11vsk8p-13317", name: "same" },
    right = { ...b, id: "collision-1c0e837-25368", name: "same" };
  const f = await fixture(t, [
    item("one", { peer: { workspace: left, line: 1, open: "file" } }),
  ]);
  f.setContext({ ...f.source.controlContext(), catalog: [a, left, right] });
  await tick();
  await f.controller.open("radar", "peer");
  assert.equal(f.calls.length, 0);
});

test("削除WSのfocusがfalseなら開いたと表示しない", async (t) => {
  const f = await fixture(t, [
    item("one", { self: { workspace: a, line: 1, open: "workspace" } }),
  ]);
  f.controller.client.focusWorkspace = async () => false;
  await f.controller.open("radar", "self");
  assert.doesNotMatch(f.controller.view("radar").message, /開きました/u);
});
test("先頭--/改行/Unicode/等号のpathを一つの値で渡す", async (t) => {
  const path = "--a b\n🦫=e\u0301.ts",
    f = await fixture(t, [item("one", { path })]);
  await f.controller.open("radar", "self");
  assert.ok(f.calls[0].includes(`--path=${path}`));
  assert.equal(f.calls[0].includes("--path"), false);
});

test("遅いopen結果は新WSの自分側と混ぜず押下時の完全IDを残す", async (t) => {
  const f = await fixture(t);
  let release;
  f.controller.run = async () =>
    new Promise((r) => {
      release = r;
    });
  const pending = f.controller.open("radar", "self");
  await tick();
  const next = ws("NEW");
  f.setContacts([
    item("next", { self: { workspace: next, line: 1, open: "file" } }),
  ]);
  f.setContext({
    ...f.source.controlContext(),
    view: { workspaceId: next.id, workspaceName: next.name, workspace: next },
    catalog: [next, b],
  });
  await tick();
  release({ ok: true, _meta: { runtimeId: "r" }, result: { opened: true } });
  await pending;
  assert.match(f.controller.view("radar").message, /押下時.*\[A\]/u);
  assert.doesNotMatch(f.controller.view("radar").message, /\[NEW\]/u);
});

test("pair保留中にruntime/instanceが変わり同版が再表示されても旧押下は作用しない", async (t) => {
  for (const patch of ["runtime", "instance"]) {
    const f = await fixture(t);
    let release;
    f.scanner.pair = async () =>
      new Promise((r) => {
        release = r;
      });
    const pending = f.controller.open("radar", "self");
    await tick();
    const c = f.source.controlContext();
    f.setContext(
      patch === "runtime"
        ? { ...c, runtimeId: "new" }
        : {
            ...c,
            catalog: c.catalog.map((w) =>
              w.id === "A" ? { ...w, instanceId: "new" } : w,
            ),
          },
    );
    await tick();
    release([item("one"), item("two")]);
    await pending;
    assert.equal(f.calls.length, 0);
  }
});
