import { displayText, shorten, twoLines, xml } from "./key-text";

/** 144px source icons are scaled to 120px keys on Stream Deck+. */
export const keyColors = {
  working: "#14558b",
  waiting: "#805000",
  review: "#075e56",
  idle: "#303b4c",
  unknown: "#55384f",
  error: "#7f2e42",
  input: "#49336d",
  reviewQueue: "#194f7c",
};
export type KeyIcon =
  | "folder"
  | "queue"
  | "input"
  | "pr"
  | "waiting"
  | "reply"
  | "spinner"
  | "pause"
  | "question"
  | "warning"
  | "check"
  | "cross"
  | "plus"
  | "link";
const paths: Record<KeyIcon, string> = {
  folder: '<path d="M2 6h7l3 3h10v12H2z"/>',
  queue: '<path d="M3 5h13M3 11h9M3 17h9m5-6 5 5-5 5m-4-5h9"/>',
  input: '<path d="M3 4h18v16H3zM7 8h10M7 12h6m2 3 3 2-3 2"/>',
  pr: '<circle cx="6" cy="5" r="3"/><circle cx="6" cy="20" r="3"/><circle cx="20" cy="20" r="3"/><path d="M6 8v9m7-13h3a4 4 0 0 1 4 4v9m-7-13 3-3m-3 3 3 3"/>',
  waiting:
    '<path d="M2 3h21v15H12l-7 5v-5H2zM12 7v4"/><circle cx="12" cy="14" r=".7"/>',
  reply: '<path d="M2 3h21v15H12l-7 5v-5H2zM7 10h10M7 14h7"/>',
  spinner:
    '<circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9"/>',
  pause: '<path d="M8 4v17M17 4v17"/>',
  question:
    '<circle cx="12" cy="12" r="10"/><path d="M8 8c0-5 10-5 8 1-1 2-4 2-4 5"/><circle cx="12" cy="18" r=".7"/>',
  warning: '<path d="m12 2 11 20H1zM12 8v6"/><circle cx="12" cy="18" r=".7"/>',
  check: '<path d="m3 12 6 7L22 4"/>',
  cross: '<path d="m4 4 16 16M20 4 4 20"/>',
  plus: '<path d="M12 3v18M3 12h18"/>',
  link: '<path d="m9 15 6-6m-7 9-2 2a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 0m4-1 2-2a5 5 0 0 1 7 7l-6 6a5 5 0 0 1-7 0" transform="translate(3 0) scale(.85)"/>',
};
export const keyIcon = (
  kind: KeyIcon,
  x: number,
  y: number,
  size = 24,
  frame?: number,
) =>
  `<g data-icon="${kind}" transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${frame === undefined ? paths[kind] : `<g transform="rotate(${(frame % 12) * 30} 12 12)">${paths[kind]}</g>`}</g>`;
export const keyText = (
  value: string,
  x: number,
  y: number,
  size = 20,
  strong = false,
) =>
  value
    ? `<text x="${x}" y="${y}" font-size="${size}"${strong ? ' font-weight="650"' : ""}>${xml(value)}</text>`
    : "";
export const keyFrame = (color: string, contents: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="${color}"/><g fill="#fff" color="#fff" font-family="-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif" text-anchor="middle">${contents}</g></svg>`)}`;
export const keyNameLines = (value: string) => twoLines(value, 9);
export const keyProjectText = (value?: string) => shorten(value ?? "", 9);
export function keyName(value: string, size = 28, y1 = 65, y2 = 98): string {
  const [a, b] = keyNameLines(value);
  return b
    ? keyText(a, 72, y1, size, true) + keyText(b, 72, y2, size, true)
    : keyText(a, 72, (y1 + y2) / 2, size, true);
}
export function inputWorkspaceText(w: {
  name: string;
  project?: string;
}): string {
  const project = displayText(w.project ?? "");
  if (!project) return shorten(w.name, 12);
  const parts = Array.from(
    new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(project),
    (row) => row.segment,
  );
  const prefix = /^[a-z\d]{2}$/iu.test(parts.slice(0, 2).join(""))
    ? parts.slice(0, 2).join("")
    : parts[0];
  return `${prefix}/${shorten(w.name, 8)}`;
}
export function keyHeader(
  label: string,
  icon: KeyIcon,
  mode?: "入力" | "送信",
): string {
  if (mode)
    return (
      keyIcon(icon, 10, 9, 18) +
      keyText(label, 55, 24, 20) +
      `<rect x="88" y="5" width="47" height="26" rx="5" fill="${mode === "送信" ? "#943b2b" : "none"}" stroke="#fff" stroke-width="1.4"/>` +
      keyText(mode, 111.5, 25, 20)
    );
  return label
    ? keyIcon(icon, 11, 7, 22) + keyText(label, 85, 25, 20)
    : keyIcon(icon, 61, 6, 22);
}
export const keyStatus = (label: string, icon: KeyIcon, frame?: number) =>
  keyIcon(icon, 15, 113, 23, frame) + keyText(label, 85, 134, 20);

export function keyPRText(pr: { repo: string; number: number }) {
  const [owner, repo] = pr.repo.split("/");
  const number = `#${pr.number}`;
  return {
    owner: shorten(owner, 12),
    repo: shorten(repo ?? "", 12),
    number: shorten(number, 12),
    fits: shorten(number, 12) === number,
  };
}
export const keyPRSignature = (pr: { repo: string; number: number }) => {
  const { owner, repo, number } = keyPRText(pr);
  return JSON.stringify([owner, repo, number]);
};
