import type { OrcaAgent, OrcaSnapshot, OrcaWorkspace } from "./orca/model";
import type { MonitorState } from "./orca/monitor";

export type AttentionKind = "waiting" | "review";
export type AttentionCandidate = {
  workspace: OrcaWorkspace;
  kind: AttentionKind;
  signals: OrcaAgent[];
};
export type AttentionTarget = {
  runtimeId: string;
  workspaceId: string;
  hostId: string;
  kind: AttentionKind;
  signals: string;
};
export type AttentionView = {
  runtimeId?: string;
  candidates: AttentionCandidate[];
  current?: AttentionCandidate;
  counts: {
    waiting: number;
    review: number;
    unknown: number;
    working: number;
    workspaces: number;
    agents: number;
  };
  coverage: "loading" | "offline" | "partial" | "unknown" | "complete";
  fromCache: boolean;
  error?: string;
};

function candidate(workspace: OrcaWorkspace): AttentionCandidate | undefined {
  const waiting = workspace.agents.filter((a) => a.state === "waiting");
  const review = workspace.agents.filter(
    (a) => a.state === "done" || a.state === "blocked",
  );
  if (waiting.length) return { workspace, kind: "waiting", signals: waiting };
  if (review.length) return { workspace, kind: "review", signals: review };
  // ペインの通知がない場合も、CLIが報告した活動だけを候補にする。
  if (workspace.activity === "permission")
    return { workspace, kind: "waiting", signals: [] };
  if (workspace.activity === "done")
    return { workspace, kind: "review", signals: [] };
  return undefined;
}
function signature(signals: OrcaAgent[]): string {
  return JSON.stringify(
    signals
      .map((a) => [
        a.paneKey,
        a.parentPaneKey ?? null,
        a.state,
        a.stateStartedAt ?? null,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}
export function attentionTarget(
  view: AttentionView,
): AttentionTarget | undefined {
  const c = view.current;
  return c && view.runtimeId
    ? {
        runtimeId: view.runtimeId,
        workspaceId: c.workspace.id,
        hostId: c.workspace.hostId,
        kind: c.kind,
        signals: signature(c.signals),
      }
    : undefined;
}
export function matchesAttentionTarget(
  snapshot: OrcaSnapshot,
  target: AttentionTarget,
): boolean {
  if (snapshot.runtimeId !== target.runtimeId) return false;
  const workspace = snapshot.workspaces.find(
    (w) => w.id === target.workspaceId && w.hostId === target.hostId,
  );
  const c = workspace && candidate(workspace);
  return (
    !!c && c.kind === target.kind && signature(c.signals) === target.signals
  );
}
/** 既存の状態集約を変えず、候補になったシグナルとその親の場所だけに移動を限定する。 */
export function attentionWorkspace(workspace: OrcaWorkspace): OrcaWorkspace {
  const c = candidate(workspace);
  if (!c?.signals.length) return { ...workspace, agents: [] };
  const selected = new Set(c.signals.map((a) => a.paneKey));
  const parents = new Set<string>();
  const agents = new Map(workspace.agents.map((a) => [a.paneKey, a]));
  for (const signal of c.signals) {
    let key = signal.parentPaneKey;
    while (key && !parents.has(key)) {
      parents.add(key);
      key = agents.get(key)?.parentPaneKey;
    }
  }
  return {
    ...workspace,
    agents: workspace.agents
      .filter((a) => selected.has(a.paneKey) || parents.has(a.paneKey))
      .map((a) => (selected.has(a.paneKey) ? a : { ...a, state: "unknown" })),
  };
}

export class AttentionQueue {
  view: AttentionView = {
    candidates: [],
    counts: {
      waiting: 0,
      review: 0,
      unknown: 0,
      working: 0,
      workspaces: 0,
      agents: 0,
    },
    coverage: "loading",
    fromCache: false,
  };
  update(state: MonitorState): void {
    if (state.fromCache) {
      this.view = { ...this.view, fromCache: true };
      return;
    }
    const snapshot = state.snapshot;
    if (!snapshot) {
      this.view = {
        candidates: [],
        counts: {
          waiting: 0,
          review: 0,
          unknown: 0,
          working: 0,
          workspaces: 0,
          agents: 0,
        },
        coverage: state.error ? "offline" : "loading",
        error: state.error ?? undefined,
        fromCache: false,
      };
      return;
    }
    const candidates = snapshot.workspaces
      .flatMap((w) => {
        const c = candidate(w);
        return c ? [c] : [];
      })
      .sort(
        (a, b) =>
          Number(a.kind === "review") - Number(b.kind === "review") ||
          a.workspace.project.localeCompare(b.workspace.project) ||
          a.workspace.name.localeCompare(b.workspace.name) ||
          a.workspace.id.localeCompare(b.workspace.id),
      );
    const counts = {
      waiting: candidates.filter((c) => c.kind === "waiting").length,
      review: candidates.filter((c) => c.kind === "review").length,
      unknown: snapshot.workspaces.filter(
        (w) =>
          w.terminalVerdict === "unverifiable" ||
          w.agents.some((a) => a.state === "unknown") ||
          w.activity === "unknown",
      ).length,
      working: snapshot.workspaces.filter(
        (w) =>
          w.agents.some((a) => a.state === "working") ||
          (!w.agents.length && w.activity === "working"),
      ).length,
      workspaces: snapshot.workspaces.length,
      agents: snapshot.workspaces.reduce((n, w) => n + w.agents.length, 0),
    };
    const previous =
      this.view.runtimeId === snapshot.runtimeId
        ? this.view.current?.workspace.id
        : undefined;
    this.view = {
      runtimeId: snapshot.runtimeId,
      candidates,
      current:
        candidates.find((c) => c.workspace.id === previous) ?? candidates[0],
      counts,
      coverage:
        snapshot.truncated || snapshot.omittedHosts
          ? "partial"
          : counts.unknown
            ? "unknown"
            : "complete",
      fromCache: false,
    };
  }
  advance(target?: AttentionTarget): void {
    if (!target || this.view.fromCache) return;
    const current = attentionTarget(this.view);
    if (JSON.stringify(current) !== JSON.stringify(target)) return;
    const index = this.view.candidates.findIndex(
      (c) => c.workspace.id === target.workspaceId,
    );
    this.view = {
      ...this.view,
      current: this.view.candidates[(index + 1) % this.view.candidates.length],
    };
  }
}
