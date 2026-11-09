import { object, readResponse } from "./model";
export type SavedReference = { workspaceId: string; key: string; url: string };
export type WorkspaceReference = {
  key: string;
  url: string;
  type: "pr" | "issue";
  selected: boolean;
  label: string;
};
export type WorkspaceReferences = {
  workspaceId: string;
  references: WorkspaceReference[];
  unsupportedSelected: boolean;
};
/** Orca 1.4.254 reference list: key and selected are explicit host-owned fields. */
export function parseReferences(
  value: unknown,
  workspaceId: string,
  runtimeId: string,
): WorkspaceReferences {
  const response = readResponse(value);
  const worktree = object(response.result.worktree);
  if (
    response.runtimeId !== runtimeId ||
    worktree.id !== workspaceId ||
    !Array.isArray(response.result.references)
  )
    throw new Error("関連先の対象WS・実行環境を確認できません。");
  const references: WorkspaceReference[] = [];
  let unsupportedSelected = false;
  for (const value of response.result.references) {
    const row = object(value);
    const match =
      typeof row.url === "string"
        ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9][0-9]*)$/u.exec(
            row.url,
          )
        : null;
    if (
      row.provider !== "github" ||
      (row.type !== "pr" && row.type !== "issue") ||
      typeof row.key !== "string" ||
      !row.key ||
      !match ||
      match[2] !== (row.type === "pr" ? "pull" : "issues")
    ) {
      unsupportedSelected ||= row.selected === true;
      continue;
    }
    if (references.some((ref) => ref.key === row.key))
      throw new Error("関連先の識別子が重複しています。");
    references.push({
      key: row.key,
      url: row.url as string,
      type: row.type,
      selected: row.selected === true,
      label: `${row.type === "pr" ? "PR" : "Issue"} #${match[3]} · ${match[1]}`,
    });
  }
  return { workspaceId, references, unsupportedSelected };
}
export function referenceCandidates(
  data: WorkspaceReferences,
): WorkspaceReference[] {
  if (data.unsupportedSelected)
    throw new Error(
      "Orca の選択中参照は対応する GitHub Issue / PR ではありません。",
    );
  const selected = data.references.filter((ref) => ref.selected);
  if (selected.length) return selected;
  const prs = data.references.filter((ref) => ref.type === "pr");
  return prs.length
    ? prs
    : data.references.filter((ref) => ref.type === "issue");
}
export function chooseReference(
  data: WorkspaceReferences,
  saved?: SavedReference,
): WorkspaceReference {
  const existing =
    saved && saved.workspaceId === data.workspaceId
      ? data.references.find(
          (ref) => ref.key === saved.key && ref.url === saved.url,
        )
      : undefined;
  if (saved && !existing)
    throw new Error(
      "選択先消失：保存した関連先を確認できません。設定で選び直してください。",
    );
  const candidates = referenceCandidates(data);
  if (!candidates.length)
    throw new Error("関連先なし：このWSに GitHub Issue / PR がありません。");
  if (candidates.length === 1) return candidates[0];
  if (existing && candidates.some((ref) => ref.key === existing.key))
    return existing;
  throw new Error("関連先が複数：設定画面で対象を選んでください。");
}
