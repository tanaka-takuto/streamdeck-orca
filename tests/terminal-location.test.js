import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { terminalLocations } = await loadModule("src/orca/terminal-location.ts");
const { locationFitsKey } = await loadModule("src/recipient-label.ts");
const leaf = (h) => ({ type: "terminal", handle: h, tabId: "t", leafId: h });
const group = (panes, tabId = "t") => ({
  type: "group",
  tabs: [{ tabId, panes }],
});
test("Orcaの端末paneはverticalが左右、groupはhorizontalが左右になる", () => {
  const root = {
    type: "split",
    direction: "horizontal",
    first: group({
      type: "pane-split",
      direction: "vertical",
      first: leaf("a"),
      second: leaf("b"),
    }),
    second: group({ ...leaf("c"), tabId: "t2" }, "t2"),
  };
  const x = terminalLocations([{ worktreeId: "w", root }], "w");
  assert.match(x.get("a").location ?? x.get("a"), /左 T1 左/);
  assert.match(x.get("b").location ?? x.get("b"), /左 T1 右/);
  assert.match(x.get("c").location ?? x.get("c"), /右 T1/);
});
test("重複handleや位置を照合できないleafは拒否する", () => {
  for (const panes of [
    {
      type: "pane-split",
      direction: "vertical",
      first: leaf("a"),
      second: leaf("a"),
    },
    { type: "terminal", handle: "a" },
  ])
    assert.throws(() =>
      terminalLocations([{ worktreeId: "w", root: group(panes) }], "w"),
    );
});

test("キーに収まらない位置は省略して入力可能にしない", () => {
  for (const loc of ["T1 左左左左左左左左", "T1 左左左左左右左左"])
    assert.equal(locationFitsKey(loc), false);
  assert.equal(locationFitsKey("T1 左"), true);
});

test("別handleでも同じtab/leafを二つの位置として受け付けない", () => {
  const a = leaf("a"),
    b = { ...leaf("b"), leafId: "a" };
  assert.throws(() =>
    terminalLocations(
      [
        {
          worktreeId: "w",
          root: group({
            type: "pane-split",
            direction: "vertical",
            first: a,
            second: b,
          }),
        },
      ],
      "w",
    ),
  );
});

for (const change of ["missing", "contradiction", "duplicate"])
  test(`親tab識別子が${change}のレイアウトを位置として使わない`, () => {
    const tab = { tabId: "t", panes: leaf("a") };
    if (change === "missing") delete tab.tabId;
    if (change === "contradiction") tab.tabId = "other";
    const root = {
      type: "group",
      tabs:
        change === "duplicate"
          ? [tab, { tabId: "t", panes: { ...leaf("b") } }]
          : [tab],
    };
    assert.throws(() => terminalLocations([{ worktreeId: "w", root }], "w"));
  });
