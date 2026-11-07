import { displayText, shorten, twoLines } from "./key-text";
import type { OrcaWorkspace } from "./orca/model";
export type WorkspaceIdentity = {
  id: string;
  tag: string;
  project?: string;
  projectLabel: string;
  path?: string;
  ambiguous: boolean;
};
export type KeyContext = Partial<WorkspaceIdentity> & { controlId?: string };
export function workspaceTag(id: string): string {
  let hash = 2166136261;
  for (const char of id)
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return (hash >>> 0).toString(36).padStart(7, "0");
}
const visibleIdentity = (w: OrcaWorkspace) =>
  JSON.stringify([identityLine(w), twoLines(w.name)]);
export function workspaceIdentity(
  id: string | undefined,
  workspace: OrcaWorkspace | undefined,
  catalog: readonly OrcaWorkspace[] = [],
): WorkspaceIdentity | undefined {
  if (!id) return undefined;
  const w = workspace?.id === id ? workspace : undefined;
  const displayed = w ? visibleIdentity(w) : undefined;
  return {
    id,
    tag: workspaceTag(id),
    project: w?.project,
    projectLabel: projectLabel(w?.project),
    path: w?.path,
    ambiguous:
      !!w &&
      catalog.some(
        (other) => other.id !== id && visibleIdentity(other) === displayed,
      ),
  };
}
export function identityLine(context?: KeyContext): string {
  if (!context?.id) return "対象未選択";
  return `${shorten(projectLabel(context.project), 9)} · ${workspaceTag(context.id)}`;
}
/** Preserve the complete source label in details, with one common empty fallback. */
export function projectLabel(value?: string): string {
  return displayText(value ?? "").trim() ? (value ?? "") : "未取得";
}
export const ambiguousMessage =
  "キー上の対象表示が重複しています。詳細の完全IDとパスを確認し、Orca側で操作するかワークスペース名を見分けられる名前に変更してください。";
