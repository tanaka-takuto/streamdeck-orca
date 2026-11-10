import { object, readResponse } from "./model";
/** Legacy per-button choice; retained only to preserve old settings until reassignment. */
export type SavedReference = { workspaceId: string; key: string; url: string };
export type WorkspaceReference = {
  key: string;
  url: string;
  type: "pr" | "issue";
  label: string;
};
export type WorkspaceReferences = {
  workspaceId: string;
  references: WorkspaceReference[];
  instanceId?: string;
  hostId?: string;
};
/** Orca 1.4.254 reference list, including the exact workspace instance and host. */
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
    !Array.isArray(response.result.references) ||
    response.result.truncated === true ||
    response.result.incomplete === true
  )
    throw new Error("関連先の対象WS・実行環境を確認できません。");
  const references: WorkspaceReference[] = [];
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
      (row.type !== "pr" && row.type !== "issue")
    )
      continue;
    if (
      typeof row.key !== "string" ||
      !row.key ||
      !match ||
      match[2] !== (row.type === "pr" ? "pull" : "issues")
    )
      throw new Error("GitHub関連先のURLまたは識別子を確認できません。");
    const previous = references.find((ref) => ref.key === row.key);
    if (previous) {
      if (
        previous.type !== row.type ||
        previous.url.toLowerCase() !== (row.url as string).toLowerCase()
      )
        throw new Error("関連先の識別子が重複し、URLが一致しません。");
      continue;
    }
    references.push({
      key: row.key,
      url: row.url as string,
      type: row.type,
      label: `${row.type === "pr" ? "PR" : "Issue"} #${match[3]} · ${match[1]}`,
    });
  }
  const identity = object(worktree.identity ?? {});
  const instance = worktree.instanceId ?? identity.instanceId;
  const host = worktree.hostId ?? identity.executionHostId;
  return {
    workspaceId,
    references,
    instanceId: typeof instance === "string" ? instance : undefined,
    hostId: typeof host === "string" ? host : undefined,
  };
}
/** Every supported saved link is opened; selection and legacy per-key choices do not filter it. */
export function allReferences(data: WorkspaceReferences): WorkspaceReference[] {
  const urls = new Set<string>();
  return data.references.filter((ref) => {
    const url = ref.url.toLowerCase();
    if (urls.has(url)) return false;
    urls.add(url);
    return true;
  });
}
export const referenceSet = (refs: WorkspaceReference[]): string =>
  JSON.stringify(refs.map((ref) => ref.url.toLowerCase()).sort());
