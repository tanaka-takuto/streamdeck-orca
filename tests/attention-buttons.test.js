import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { AttentionButtons } = await loadModule("src/attention-buttons.ts");
const w = (id = "a", since = 1) => ({
  id,
  name: id.toUpperCase(),
  project: "P",
  path: `/${id}`,
  hostId: "local",
  terminalVerdict: "live",
  activity: "permission",
  agents: [{ paneKey: `tab:${id}`, state: "waiting", stateStartedAt: since }],
});
const state = (workspaces = [w()], runtimeId = "r1") => ({
  snapshot: { runtimeId, workspaces, truncated: false },
  error: null,
});
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};
function fixture() {
  let listener;
  let next = state();
  const monitor = {
    subscribe(fn) {
      listener = fn;
      fn(next);
      return () => {
        listener = undefined;
      };
    },
    async refresh() {
      listener?.(next);
      return next;
    },
  };
  const images = [],
    opens = [],
    errors = [];
  let generation = 0;
  let alerts = 0;
  const client = {
    async focusWorkspace(id, current, target) {
      if (!current()) return false;
      opens.push({ id, target });
      return true;
    },
  };
  const buttons = new AttentionButtons(
    monitor,
    client,
    () => {
      const v = ++generation;
      return () => generation === v;
    },
    (_id, m) => errors.push(m),
  );
  buttons.bind({
    id: "key",
    async setImage(image) {
      images.push(image);
    },
    async showAlert() {
      alerts++;
    },
  });
  return {
    buttons,
    images,
    opens,
    errors,
    client,
    set(value) {
      next = value;
      listener?.(next);
    },
    invalidate() {
      generation++;
    },
    get alerts() {
      return alerts;
    },
  };
}

test("同じ見た目で新しい待ちが来ても、次の押下は最新エピソードを固定できる", async () => {
  const f = fixture();
  await flush();
  f.set(state([w("a", 2)]));
  await flush();
  await f.buttons.press("key");
  assert.equal(f.opens.length, 1);
  assert.ok(f.opens[0].target.signals.includes("2"));
});
test("連打を蓄積せず、失敗後の監視復旧でも自動移動しない", async () => {
  const f = fixture();
  await flush();
  let release;
  f.client.focusWorkspace = async () =>
    await new Promise((resolve) => {
      release = resolve;
    });
  const press = f.buttons.press("key");
  await flush();
  await f.buttons.press("key");
  release(false);
  await press;
  assert.equal(f.opens.length, 0);
  f.set({ snapshot: null, error: "offline" });
  await flush();
  await f.buttons.press("key");
  assert.equal(f.alerts, 1);
  f.set(state());
  await flush();
  assert.equal(f.opens.length, 0);
});

test("遅れた旧画像が見えている間に、その前の別対象を開かない（独立UXレビューの反例）", async () => {
  let listener,
    latest = state([w("a"), w("b")]);
  const monitor = {
    subscribe(fn) {
      listener = fn;
      fn(latest);
      return () => {};
    },
    async refresh() {
      listener(latest);
      return latest;
    },
  };
  let visible,
    slow = false;
  const pending = [],
    opens = [];
  const buttons = new AttentionButtons(
    monitor,
    {
      async focusWorkspace(id) {
        opens.push(id);
        return true;
      },
    },
    () => () => true,
    () => {},
  );
  buttons.bind({
    id: "key",
    async setImage(image) {
      if (slow) await new Promise((resolve) => pending.push(resolve));
      visible = decodeURIComponent(image).match(/y="69"[^>]*>([^<]*)</u)?.[1];
    },
    async showAlert() {},
  });
  await flush();
  assert.equal(visible, "A");
  slow = true;
  latest = state([w("b")]);
  listener(latest);
  await flush();
  latest = state([w("a"), w("c")]);
  listener(latest);
  await flush();
  pending.shift()();
  await flush();
  assert.equal(visible, "B");
  await buttons.press("key");
  assert.deepEqual(opens, []);
  buttons.unbind("key");
  for (const release of pending) release();
  await flush();
});
