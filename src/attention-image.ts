import type { AttentionView } from "./attention";

export function xml(value: string): string {
  return Array.from(value)
    .filter((c) => (c.codePointAt(0) ?? 0) >= 32)
    .join("")
    .replace(
      /[&<>"']/gu,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c] ?? c,
    );
}
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
const graphemes = (s: string) =>
  Array.from(segmenter.segment(s), (x) => x.segment);
const units = (s: string) =>
  graphemes(s).reduce(
    (n, c) => n + (/^[\x20-\x7e]$/u.test(c) && !/^[MWmw@]$/u.test(c) ? 1.6 : 2),
    0,
  );
export function shorten(value: string, budget: number): string {
  if (units(value) <= budget) return value;
  const parts = graphemes(value);
  let left = "",
    right = "",
    used = 2;
  while (parts.length) {
    const front = units(left) <= units(right);
    const part = front ? parts.shift() : parts.pop();
    if (part === undefined) break;
    if (used + units(part) > budget) break;
    used += units(part);
    if (front) left += part;
    else right = part + right;
  }
  return `${left}…${right}`;
}
export function displayName(view: AttentionView): string {
  const w = view.current?.workspace;
  if (!w) return "";
  const same = view.candidates
    .filter(
      (c) => c.workspace.name === w.name && c.workspace.project === w.project,
    )
    .sort((a, b) => a.workspace.id.localeCompare(b.workspace.id));
  return same.length > 1
    ? `${w.name} #${same.findIndex((c) => c.workspace.id === w.id) + 1}`
    : w.name;
}
export function workspaceTag(id: string): string {
  let hash = 2166136261;
  for (const char of id)
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return (hash >>> 0).toString(36).padStart(7, "0");
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
  const name = shorten(displayName(view), 26);
  const parts = graphemes(name);
  let first = "",
    second = "";
  for (const part of parts) {
    if (!second && units(first + part) <= 13) first += part;
    else second += part;
  }
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
  const project = c
    ? `${shorten(c.workspace.project || "Orca", 9)} · ${workspaceTag(c.workspace.id)}`
    : "確認先を開く";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="${color}"/><g fill="#fff" font-family="-apple-system, sans-serif" text-anchor="middle">${text(title, 23, 17)}${text(project, 44, 12)}${text(c ? first : offline ? "Orcaを確認" : view.coverage === "loading" ? "しばらくお待ち" : empty, 69, 17)}${text(second, 90, 17)}${text(busy ? (c ? "開いています" : "更新しています") : c ? "押して開く" : "押して再取得", 113, 14)}${text(warning || (!offline && view.coverage !== "loading" ? `入力 ${view.counts.waiting} · 返答 ${view.counts.review}` : "接続を確認"), 135, 12)}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
