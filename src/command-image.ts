import { shorten, svgText, twoLines } from "./key-text";
import { identityLine, type KeyContext } from "./workspace-identity";

export function commandImage(
  name: string,
  label: string,
  mode: string,
  phase: string,
  context?: KeyContext,
): string {
  const [first, second] = twoLines(name);
  const [action, actionEnd] = twoLines(label);
  const kind = mode === "ai" ? "AI" : "SHELL";
  const header = context?.controlId
    ? `ID ${shorten(context.controlId, mode === "ai" ? 11 : 9)} · ${kind}`
    : kind;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="${mode === "ai" ? "#4d397b" : "#28564f"}"/><g fill="#fff" font-family="-apple-system, sans-serif" text-anchor="middle">${svgText(header, 19, 12)}${svgText(context ? identityLine(context) : "画面選択へ入力", 35, 12)}${svgText(first, 57, 16)}${svgText(second, 77, 16)}${svgText(action, 99, 16)}${svgText(actionEnd, 117, 16)}${svgText(context?.ambiguous ? "表示重複・要照合" : phase, 134, 14)}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
