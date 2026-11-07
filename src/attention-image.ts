import type { AttentionView } from "./attention";

import { twoLines, xml } from "./key-text";
import { identityLine, workspaceIdentity } from "./workspace-identity";

export { shorten, xml } from "./key-text";
export { workspaceTag } from "./workspace-identity";
export function displayName(view: AttentionView): string {
  return view.current?.workspace.name ?? "";
}
export function attentionImage(view: AttentionView, busy = false): string {
  const c = view.current;
  const offline = view.coverage === "offline";
  const warning = view.fromCache
    ? "保持表示 · 更新中"
    : view.coverage === "partial"
      ? "一部取得"
      : view.coverage === "unknown"
        ? "一部不明"
        : "";
  const title = offline
    ? "取得できません"
    : view.coverage === "loading"
      ? "取得中"
      : c?.kind === "waiting"
        ? "入力待ち"
        : c
          ? "返答候補"
          : warning || "候補なし";
  const color = offline
    ? "#55384f"
    : c?.kind === "waiting"
      ? "#794600"
      : c
        ? "#075950"
        : "#303842";
  const [first, second] = twoLines(displayName(view));
  const identity =
    c?.identity ??
    workspaceIdentity(
      c?.workspace.id,
      c?.workspace,
      view.candidates.map((row) => row.workspace),
    );
  const empty =
    view.counts.workspaces === 0
      ? "WSなし"
      : view.counts.agents === 0
        ? "対象AIなし"
        : view.counts.working
          ? "進行中あり"
          : "状態を確認";
  const text = (value: string, y: number, size: number) =>
    `<text x="72" y="${y}" font-size="${size}">${xml(value)}</text>`;
  const project = c ? identityLine(identity) : "確認先を開く";
  const heading = c && !offline ? `確認 · ${title}` : title;
  const action = offline
    ? "Orcaで確認"
    : identity?.ambiguous
      ? "表示重複・要照合"
      : busy
        ? c
          ? "開いています"
          : "更新しています"
        : c
          ? "押して開く"
          : "押して再取得";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="${color}"/><g fill="#fff" font-family="-apple-system, sans-serif" text-anchor="middle">${text(heading, 23, 16)}${text(project, 44, 12)}${text(c ? first : offline ? "Orcaを確認" : view.coverage === "loading" ? "しばらくお待ち" : empty, 69, 17)}${text(second, 90, 17)}${text(action, 113, 14)}${text(warning || (!offline && view.coverage !== "loading" ? `入力 ${view.counts.waiting} · 返答 ${view.counts.review}` : "接続を確認"), 132, 12)}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
