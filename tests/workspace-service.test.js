import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, initialIds = ["A", "B"]) {
  const built = await build({
    entryPoints: ["src/workspace-service.ts"],
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
            contents: "export default testSdk;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const sdk = { logger: { warn() {} }, ui: {}, settings: {} };
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    "require",
    "testSdk",
    built.outputFiles[0].text,
  )(module, module.exports, createRequire(import.meta.url), sdk);
  const service = module.exports.workspaceService;
  const rows = initialIds.map((id) => ({
    id,
    name: id,
    project: "P",
    path: `/${id}`,
    hostId: "local",
    agents: [],
    activity: "active",
    terminalVerdict: "none",
  }));
  service.client.snapshot = async () => ({
    runtimeId: "r",
    workspaces: rows,
    truncated: false,
  });
  let visible;
  const key = {
    id: "run",
    async setImage(image) {
      const text = decodeURIComponent(image);
      visible = text;
    },
    async showAlert() {},
    async showOk() {},
  };
  t.after(() => {
    service.unbind(key.id);
    service.status.unbind(key.id);
  });
  return {
    service,
    sdk,
    rows,
    key,
    get visible() {
      return visible;
    },
  };
}

test("旧global取得失敗ではボタンの移行フラグと旧IDを保存変更しない", async (t) => {
  const f = await fixture(t),
    initial = { controlId: "main", custom: "keep" },
    writes = [];
  f.sdk.settings.getGlobalSettings = async () => {
    throw Error("temporary offline");
  };
  f.key.getSettings = async () => initial;
  f.key.setSettings = async (value) => writes.push(value);
  await f.service.status.bind(f.key, initial);
  assert.deepEqual(writes, []);
});
test("旧割当を一度だけ引き継ぎ、PR起動記録を含むglobalを一切書き換えない", async (t) => {
  const f = await fixture(t);
  const global = {
    workspaceSelections: { main: { workspaceId: "A", workspaceName: "A" } },
    prReviewLaunches: { keep: { status: "unknown" } },
    custom: "keep",
  };
  const original = structuredClone(global),
    writes = [];
  let reads = 0;
  f.sdk.settings.getGlobalSettings = async () => {
    reads++;
    return global;
  };
  f.sdk.settings.setGlobalSettings = async (value) => writes.push(value);
  let settings = { controlId: "main", custom: "button" };
  f.key.getSettings = async () => structuredClone(settings);
  f.key.setSettings = async (value) => {
    settings = structuredClone(value);
  };
  await f.service.status.bind(f.key, settings);
  await tick();
  assert.equal(settings.workspace.workspaceId, "A");
  assert.equal(settings.controlId, undefined);
  assert.equal(settings.custom, "button");
  f.service.status.unbind(f.key.id);
  await f.service.status.bind(f.key, settings);
  assert.equal(reads, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(global, original);
});
test("新規ボタンはglobalを読まず、旧mainや先頭WSを自動割当しない", async (t) => {
  const f = await fixture(t);
  let settings = {};
  f.sdk.settings.getGlobalSettings = async () => {
    throw Error("must not read global");
  };
  f.key.getSettings = async () => settings;
  f.key.setSettings = async (value) => {
    settings = value;
  };
  await f.service.status.bind(f.key, settings);
  await tick();
  assert.equal(settings.workspace, undefined);
  assert.equal(settings.workspaceButtonVersion, 1);
  assert.match(f.visible, /長押しで登録/u);
});
