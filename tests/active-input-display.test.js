import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function makeAction() {
  const built = await build({
    entryPoints: ["src/actions/active-ai-input.ts"],
    bundle: true,
    write: false,
    platform: "node",
    target: "node20",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "sdk-boundary",
        setup(b) {
          b.onResolve({ filter: /^@elgato\/streamdeck$/ }, () => ({
            path: "mock",
            namespace: "sdk",
          }));
          b.onLoad({ filter: /.*/, namespace: "sdk" }, () => ({
            contents:
              "export const action=()=>value=>value;export class SingletonAction{};export default {logger:{warn(){}},ui:{}};",
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(
    module,
    module.exports,
    createRequire(import.meta.url),
  );
  const action = new module.exports.ActiveAiInputAction();
  action.input.resolve = async () => ({
    selection: { runtimeId: "r", workspaceId: "w", paneKey: "tab:leaf" },
    workspace: {
      id: "w",
      name: "Workspace",
      project: "Repo",
      path: "/w",
      hostId: "local",
    },
    context: {
      id: "w",
      tag: "tag",
      project: "Repo",
      projectLabel: "Repo",
      ambiguous: false,
    },
    target: {
      handle: "term",
      runtimeId: "r",
      incarnationId: "inc",
      identity: "codex",
      name: "AI",
      paneKey: "tab:leaf",
    },
    location: "T1",
  });
  const appear = action.onWillAppear.bind(action),
    receive = action.onDidReceiveSettings.bind(action);
  action.onWillAppear = (e) =>
    appear({
      ...e,
      payload: {
        settings: { recipientMode: "displayed-v1", ...e.payload.settings },
      },
    });
  action.onDidReceiveSettings = (e) =>
    receive({
      ...e,
      payload: {
        settings: { recipientMode: "displayed-v1", ...e.payload.settings },
      },
    });
  return action;
}
test("設定変更の画像が未確定なら、新しい本文やEnterを入力しない", async () => {
  const action = await makeAction();
  const sent = [];
  action.input.send = async (settings, _recipient, current) => {
    if (current()) sent.push({ body: settings.body, enter: settings.enter });
    return { status: "accepted", message: "mock" };
  };
  let block = false,
    visible;
  const pending = [];
  const key = {
    id: "active",
    isKey: () => true,
    async setImage(image) {
      const s = decodeURIComponent(image);
      if (block && s.includes("新操作"))
        await new Promise((resolve) => pending.push(resolve));
      visible = s;
    },
    async showAlert() {},
    async showOk() {},
  };
  action.onWillAppear({
    action: key,
    payload: { settings: { body: "old", label: "旧操作", enter: false } },
  });
  await tick();
  block = true;
  action.onDidReceiveSettings({
    action: key,
    payload: { settings: { body: "new", label: "新操作", enter: true } },
  });
  await tick();
  assert.match(visible, /旧操作/u);
  await action.onKeyDown({ action: key });
  assert.deepEqual(sent, []);
  block = false;
  for (const resolve of pending) resolve();
  await tick();
  await action.onKeyDown({ action: key });
  assert.deepEqual(sent, [{ body: "new", enter: true }]);
  action.onWillDisappear({ action: key });
});

test("ページ再配置後に遅い旧画像が届いても、新設定の表示と押下を食い違わせない", async () => {
  const action = await makeAction();
  const sent = [];
  action.input.send = async (settings) => {
    sent.push(settings.body);
    return { status: "accepted", message: "mock" };
  };
  let visible, release;
  const key = {
    id: "active",
    isKey: () => true,
    async setImage(image) {
      const s = decodeURIComponent(image);
      if (s.includes("旧操作B"))
        await new Promise((resolve) => {
          release = resolve;
        });
      visible = s;
    },
    async showAlert() {},
    async showOk() {},
  };
  const appear = (body, label) =>
    action.onWillAppear({
      action: key,
      payload: { settings: { body, label } },
    });
  appear("A", "操作A");
  await tick();
  action.onDidReceiveSettings({
    action: key,
    payload: { settings: { body: "B", label: "旧操作B" } },
  });
  await tick();
  action.onWillDisappear({ action: key });
  appear("C", "新操作C");
  await tick();
  release();
  await tick();
  assert.match(visible, /新操作C/u);
  await action.onKeyDown({ action: key });
  assert.deepEqual(sent, ["C"]);
  action.onWillDisappear({ action: key });
});

test("送信中に設定変更しても、実際の入力を新ラベルで表示せず、新設定は表示後にだけ使う", async () => {
  const action = await makeAction();
  const sent = [];
  let finish,
    visible,
    blockNew = false;
  const pending = [];
  action.input.send = async (settings) => {
    sent.push({ body: settings.body, enter: settings.enter });
    if (settings.body === "old")
      return await new Promise((resolve) => {
        finish = resolve;
      });
    return { status: "accepted", message: "mock" };
  };
  const key = {
    id: "active",
    isKey: () => true,
    async setImage(image) {
      const s = decodeURIComponent(image);
      if (blockNew && s.includes("新操作"))
        await new Promise((resolve) => pending.push(resolve));
      visible = s;
    },
    async showAlert() {},
    async showOk() {},
  };
  action.onWillAppear({
    action: key,
    payload: { settings: { body: "old", label: "旧操作", enter: false } },
  });
  await tick();
  const sending = action.onKeyDown({ action: key });
  await tick();
  action.onDidReceiveSettings({
    action: key,
    payload: { settings: { body: "new", label: "新操作", enter: true } },
  });
  await tick();
  assert.match(visible, /旧操作/u);
  assert.doesNotMatch(visible, /新操作/u);
  blockNew = true;
  finish({ status: "unknown", message: "mock unknown" });
  await sending;
  await tick();
  await action.onKeyDown({ action: key });
  assert.deepEqual(sent, [{ body: "old", enter: false }]);
  blockNew = false;
  for (const resolve of pending) resolve();
  await tick();
  await action.onKeyDown({ action: key });
  assert.deepEqual(sent, [
    { body: "old", enter: false },
    { body: "new", enter: true },
  ]);
  action.onWillDisappear({ action: key });
});

test("既存設定は確認保存前に入力せず、本文とEnterを保持する", async () => {
  const a = await makeAction();
  let count = 0;
  a.input.send = async () => {
    count++;
    return { status: "accepted", message: "mock" };
  };
  const key = {
    id: "legacy",
    isKey: () => true,
    setImage: async () => {},
    showAlert: async () => {},
  };
  a.onWillAppear({
    action: key,
    payload: {
      settings: { body: "keep", enter: true, recipientMode: undefined },
    },
  });
  await tick();
  await a.onKeyDown({ action: key });
  assert.equal(count, 0);
  assert.equal(a.bindings.get(key.id).settings.body, "keep");
  assert.equal(a.bindings.get(key.id).settings.enter, true);
  a.onWillDisappear({ action: key });
});
test("直近の結果はページ再表示や設定変更で消えず、元の宛先と作用を保持する", async () => {
  const a = await makeAction();
  a.input.send = async () => ({ status: "unknown", message: "未確認" });
  const key = {
    id: "receipt",
    isKey: () => true,
    setImage: async () => {},
    showAlert: async () => {},
  };
  const appear = (settings) =>
    a.onWillAppear({ action: key, payload: { settings } });
  appear({ body: "secret body", label: "旧操作", enter: true });
  await tick();
  await a.onKeyDown({ action: key });
  const r = a.results.get(key.id);
  assert.equal(r.label, "旧操作");
  assert.equal(r.enter, true);
  assert.equal(r.recipient.workspace.id, "w");
  assert.equal(JSON.stringify(r).includes("secret body"), false);
  a.onWillDisappear({ action: key });
  appear({ body: "new", label: "新操作", enter: false });
  await tick();
  assert.deepEqual(a.results.get(key.id), r);
  a.onWillDisappear({ action: key });
});
test("表示候補AからBへの画像待ち中は入力0、表示更新だけでも0、次の押下でBへ一回", async () => {
  const a = await makeAction(),
    resolveA = a.input.resolve;
  let visible,
    release,
    block = false;
  const sent = [];
  a.input.send = async (_s, r, current) => {
    if (current()) sent.push(r.target.handle);
    return { status: "accepted", message: "mock" };
  };
  const key = {
    id: "recipient",
    isKey: () => true,
    async setImage(image) {
      const s = decodeURIComponent(image);
      if (block && s.includes("TargetB"))
        await new Promise((r) => {
          release = r;
        });
      visible = s;
    },
    showAlert: async () => {},
  };
  a.onWillAppear({ action: key, payload: { settings: { body: "raw" } } });
  await tick();
  a.input.resolve = async () => {
    const r = await resolveA();
    return {
      ...r,
      workspace: { ...r.workspace, name: "TargetB" },
      target: { ...r.target, handle: "B" },
    };
  };
  block = true;
  void a.monitor.refresh();
  await tick();
  await a.onKeyDown({ action: key });
  assert.deepEqual(sent, []);
  assert.doesNotMatch(visible, /TargetB/);
  block = false;
  release();
  await tick();
  assert.deepEqual(sent, []);
  await a.onKeyDown({ action: key });
  assert.deepEqual(sent, ["B"]);
  a.onWillDisappear({ action: key });
});

test("A画像のままB更新待ちで拒否した結果は、未表示Bではなく表示済みAに帰属する", async () => {
  const a = await makeAction(),
    resolveA = a.input.resolve;
  let release;
  const key = {
    id: "receipt-target",
    isKey: () => true,
    async setImage(image) {
      if (decodeURIComponent(image).includes("TargetB"))
        await new Promise((r) => {
          release = r;
        });
    },
    showAlert: async () => {},
  };
  a.onWillAppear({
    action: key,
    payload: { settings: { body: "raw", label: "操作A" } },
  });
  await tick();
  a.input.resolve = async () => {
    const r = await resolveA();
    return {
      ...r,
      workspace: { ...r.workspace, id: "B", name: "TargetB" },
      target: { ...r.target, handle: "B" },
    };
  };
  void a.monitor.refresh();
  await tick();
  await a.onKeyDown({ action: key });
  assert.equal(a.results.get(key.id).recipient.workspace.id, "w");
  a.onWillDisappear({ action: key });
  release();
  await tick();
});

test("直近記録の時刻は受付応答を待っても押下時のまま変わらない", async () => {
  const a = await makeAction();
  let finish;
  a.input.send = async () =>
    new Promise((r) => {
      finish = r;
    });
  const key = {
    id: "time",
    isKey: () => true,
    setImage: async () => {},
    showOk: async () => {},
  };
  a.onWillAppear({ action: key, payload: { settings: { body: "raw" } } });
  await tick();
  const pending = a.onKeyDown({ action: key });
  await tick();
  const at = a.results.get(key.id).at;
  await new Promise((r) => setTimeout(r, 20));
  finish({ status: "accepted", message: "mock" });
  await pending;
  assert.equal(a.results.get(key.id).at, at);
  a.onWillDisappear({ action: key });
});
