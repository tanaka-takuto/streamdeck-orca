import type { AttentionView } from "./attention";
import {
  type KeyIcon,
  keyColors,
  keyFrame,
  keyHeader,
  keyName,
  keyProjectText,
  keyStatus,
} from "./key-layout";
import { workspaceIdentity } from "./workspace-identity";

export { shorten, xml } from "./key-text";
export { workspaceTag } from "./workspace-identity";
export function displayName(view: AttentionView): string {
  return view.current?.workspace.name ?? "";
}
export function attentionImage(view: AttentionView, busy = false): string {
  const c = view.current;
  const identity =
    c?.identity ??
    workspaceIdentity(
      c?.workspace.id,
      c?.workspace,
      view.candidates.map((row) => row.workspace),
    );
  const offline = view.coverage === "offline";
  const color =
    offline || identity?.ambiguous
      ? keyColors.error
      : c?.kind === "waiting"
        ? keyColors.waiting
        : c
          ? keyColors.review
          : keyColors.idle;
  if (!c) {
    const message = offline
      ? "取得失敗"
      : view.fromCache
        ? "更新待ち"
        : busy || view.coverage === "loading"
          ? "取得中"
          : view.coverage === "partial"
            ? "一部取得"
            : view.coverage === "unknown"
              ? "一部不明"
              : "候補なし";
    return keyFrame(color, keyHeader("確認先", "queue") + keyName(message));
  }
  const [label, icon]: [string, KeyIcon] = offline
    ? ["取得失敗", "warning"]
    : view.fromCache
      ? ["更新待ち", "pause"]
      : identity?.ambiguous
        ? ["要照合", "warning"]
        : busy
          ? ["移動中", "spinner"]
          : view.coverage === "partial"
            ? ["一部取得", "warning"]
            : view.coverage === "unknown"
              ? ["一部不明", "question"]
              : view.coverage === "loading"
                ? ["取得中", "spinner"]
                : c.kind === "waiting"
                  ? ["入力待ち", "waiting"]
                  : ["返答候補", "reply"];
  return keyFrame(
    color,
    keyHeader(keyProjectText(c.workspace.project), "queue") +
      keyName(displayName(view)) +
      keyStatus(label, icon),
  );
}
