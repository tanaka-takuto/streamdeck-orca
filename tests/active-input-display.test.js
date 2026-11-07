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
  return new module.exports.ActiveAiInputAction();
}
test("設定変更の画像が未確定なら、新しい本文やEnterを入力しない", async () => {
  const action = await makeAction();
  const sent = [];
  action.input.send = async (settings, current) => {
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
