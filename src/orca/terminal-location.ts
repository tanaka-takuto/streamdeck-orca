import { object } from "./model";
/** Locations are terminal-layout positions, not indices among file/browser tabs. */
export function terminalLocations(
  layouts: unknown,
  workspaceId: string,
): Map<string, { location: string; paneKey: string }> {
  if (!Array.isArray(layouts))
    throw new Error("端末レイアウトを取得できません。");
  const matching = layouts
    .map(object)
    .filter((x) => x.worktreeId === workspaceId);
  if (matching.length !== 1)
    throw new Error("端末レイアウトを一意に確認できません。");
  const found = new Map<string, { location: string; paneKey: string }>();
  const panes = new Set<string>();
  const tabs = new Set<string>();
  const branches = (direction: unknown): [string, string] => {
    if (direction === "horizontal") return ["左", "右"];
    if (direction === "vertical") return ["上", "下"];
    throw new Error("端末の分割方向を確認できません。");
  };
  const pane = (
    value: unknown,
    prefix: string,
    depth: number,
    tabId: string,
  ) => {
    if (depth > 8)
      throw new Error("端末レイアウトが複雑すぎます。Orcaで確認してください。");
    const n = object(value);
    if (n.type === "pane-split") {
      const [a, b] = branches(
        n.direction === "vertical"
          ? "horizontal"
          : n.direction === "horizontal"
            ? "vertical"
            : n.direction,
      );
      pane(n.first, `${prefix}${a}`, depth + 1, tabId);
      pane(n.second, `${prefix}${b}`, depth + 1, tabId);
      return;
    }
    if (
      n.type !== "terminal" ||
      typeof n.handle !== "string" ||
      !n.handle ||
      found.has(n.handle) ||
      typeof n.tabId !== "string" ||
      !n.tabId ||
      n.tabId !== tabId ||
      typeof n.leafId !== "string" ||
      !n.leafId
    )
      throw new Error("端末の位置が重複または不明です。");
    const paneKey = `${n.tabId}:${n.leafId}`;
    if (panes.has(paneKey))
      throw new Error("端末ペインの識別情報が重複しています。");
    panes.add(paneKey);
    found.set(n.handle, {
      location: prefix.trim(),
      paneKey,
    });
  };
  const group = (value: unknown, path: string, depth: number) => {
    if (depth > 6) throw new Error("端末グループを識別できません。");
    const n = object(value);
    if (n.type === "split") {
      const [a, b] = branches(n.direction);
      group(n.first, `${path}${a}`, depth + 1);
      group(n.second, `${path}${b}`, depth + 1);
      return;
    }
    if (n.type !== "group" || !Array.isArray(n.tabs))
      throw new Error("端末タブを取得できません。");
    n.tabs.forEach((v, i) => {
      const tab = object(v);
      if (typeof tab.tabId !== "string" || !tab.tabId || tabs.has(tab.tabId))
        throw new Error("端末タブの識別情報が不明または重複しています。");
      tabs.add(tab.tabId);
      pane(tab.panes, `${path ? `${path} ` : ""}T${i + 1} `, 0, tab.tabId);
    });
  };
  group(matching[0].root, "", 0);
  return found;
}
