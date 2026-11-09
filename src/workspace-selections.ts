/** Legacy settings read only for one-time migration into individual status buttons. */
export type SavedSelection = { workspaceId: string; workspaceName: string };
export function normalizeControlId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "main";
}
