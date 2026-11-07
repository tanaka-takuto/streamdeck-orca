import { shorten, svgText, twoLines } from "./key-text";
import type { ActiveRecipient } from "./orca/active-input";
import { recipientLine } from "./recipient-label";
import { identityLine } from "./workspace-identity";
export function activeInputImage(
  recipient: ActiveRecipient | undefined,
  label: string,
  enter: boolean,
  phase: string,
): string {
  const [a, b] = twoLines(recipient?.workspace.name ?? "入力先未取得");
  const position = recipient
    ? recipientLine({
        identity: recipient.target.identity,
        location: recipient.location,
      })
    : "表示AIへ入力";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="#4d397b"/><g fill="#fff" font-family="-apple-system, sans-serif" text-anchor="middle">${svgText(enter ? "入力＋Enter" : "入力のみ", 19, 14)}${svgText(recipient ? identityLine(recipient.context) : "表示先を確認", 35, 12)}${svgText(a, 57, 16)}${svgText(b, 77, 16)}${svgText(position, 97, 12)}${svgText(shorten(label, 14), 116, 16)}${svgText(phase, 134, 14)}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
