export type WorkspaceStatus =
  | "working"
  | "waiting"
  | "review"
  | "idle"
  | "unknown";
export type AgentState = "working" | "waiting" | "blocked" | "done" | "unknown";

export type OrcaAgent = {
  paneKey: string;
  parentPaneKey?: string;
  state: AgentState;
  stateStartedAt?: number;
};

export type OrcaWorkspace = {
  id: string;
  name: string;
  project: string;
  path: string;
  hostId: string;
  agents: OrcaAgent[];
  activity: string;
  terminalVerdict: "live" | "exited" | "none" | "unverifiable";
};

export type OrcaSnapshot = {
  runtimeId: string;
  workspaces: OrcaWorkspace[];
  truncated: boolean;
};

export type OrcaTerminal = {
  handle: string;
  workspaceId: string;
  paneKey: string;
  connected: boolean;
  orphaned: boolean;
  hostId: string;
  agentIdentity?: string;
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Orca から不正な応答を受け取りました。");
  }
  return value as Record<string, unknown>;
}

export function readResponse(value: unknown): {
  runtimeId: string;
  result: Record<string, unknown>;
} {
  const envelope = object(value);
  if (envelope.ok !== true) {
    const error = envelope.error;
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message).slice(0, 300)
        : "Orca に接続できません。";
    throw new Error(message);
  }
  const runtimeId = object(envelope._meta).runtimeId;
  if (typeof runtimeId !== "string" || !runtimeId) {
    throw new Error(
      "Orca の実行環境を確認できません。Orca を更新してください。",
    );
  }
  return { runtimeId, result: object(envelope.result) };
}

export function readHostScope(result: Record<string, unknown>): string[] {
  const scope = object(result.hostScope);
  if (
    !Array.isArray(scope.hostIds) ||
    !scope.hostIds.every((id) => typeof id === "string")
  ) {
    throw new Error("Orca の取得対象ホストを確認できません。");
  }
  return scope.hostIds;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseAgent(value: unknown, index: number): OrcaAgent {
  const row = object(value);
  const state = ["working", "waiting", "blocked", "done"].includes(
    text(row.state),
  )
    ? (row.state as AgentState)
    : "unknown";
  return {
    paneKey: text(row.paneKey, `unknown:${index}`),
    parentPaneKey: text(row.parentPaneKey) || undefined,
    state,
    stateStartedAt:
      typeof row.stateStartedAt === "number" ? row.stateStartedAt : undefined,
  };
}

export function parseSnapshot(value: unknown): OrcaSnapshot {
  const { runtimeId, result } = readResponse(value);
  const hostIds = readHostScope(result);
  if (!Array.isArray(result.worktrees))
    throw new Error("ワークスペース一覧を取得できません。");
  const workspaces = result.worktrees
    .filter((value) => object(value).isArchived !== true)
    .map((value): OrcaWorkspace => {
      const row = object(value);
      if (
        typeof row.worktreeId !== "string" ||
        !row.worktreeId ||
        typeof row.path !== "string" ||
        !Array.isArray(row.agents)
      ) {
        throw new Error("ワークスペースの状態を確認できません。");
      }
      const hostId = text(row.hostId, "unknown");
      const covered = hostIds.includes(hostId);
      const agents = row.agents.map(parseAgent);
      return {
        id: row.worktreeId,
        name:
          text(row.displayName) ||
          row.path.split(/[\\/]/u).filter(Boolean).at(-1) ||
          row.worktreeId,
        project: text(row.repo),
        path: row.path,
        hostId,
        agents: covered
          ? agents
          : agents.map((agent) => ({ ...agent, state: "unknown" as const })),
        activity: covered ? text(row.status, "unknown") : "unknown",
        terminalVerdict:
          covered &&
          (row.terminalVerdict === "live" ||
            row.terminalVerdict === "exited" ||
            row.terminalVerdict === "none")
            ? row.terminalVerdict
            : ("unverifiable" as const),
      };
    });
  return { runtimeId, workspaces, truncated: result.truncated !== false };
}

export function getWorkspaceStatus(workspace?: OrcaWorkspace): WorkspaceStatus {
  if (!workspace) return "unknown";
  const states = workspace.agents.map((agent) => agent.state);
  if (states.includes("waiting")) return "waiting";
  if (states.includes("blocked")) return "review";
  if (states.includes("working")) return "working";
  if (
    states.includes("unknown") ||
    workspace.terminalVerdict === "unverifiable"
  )
    return "unknown";
  if (states.includes("done")) return "review";
  if (workspace.activity === "permission") return "waiting";
  if (workspace.activity === "working") return "working";
  if (workspace.activity === "done") return "review";
  return ["active", "inactive"].includes(workspace.activity)
    ? "idle"
    : "unknown";
}

const priorities: Record<AgentState, number> = {
  waiting: 0,
  blocked: 1,
  working: 2,
  done: 3,
  unknown: 4,
};

export function selectTerminal(
  workspace: OrcaWorkspace,
  terminals: OrcaTerminal[],
): OrcaTerminal | undefined {
  const ranks = new Map<string, { priority: number; since: number }>();
  const agents = new Map(
    workspace.agents.map((agent) => [agent.paneKey, agent]),
  );
  for (const agent of workspace.agents) {
    let paneKey: string | undefined = agent.paneKey;
    const seen = new Set<string>();
    while (paneKey && !seen.has(paneKey)) {
      seen.add(paneKey);
      const rank = {
        priority: priorities[agent.state],
        since: agent.stateStartedAt ?? Number.POSITIVE_INFINITY,
      };
      const existing = ranks.get(paneKey);
      if (
        !existing ||
        rank.priority < existing.priority ||
        (rank.priority === existing.priority && rank.since < existing.since)
      )
        ranks.set(paneKey, rank);
      paneKey = agents.get(paneKey)?.parentPaneKey;
    }
  }
  const candidates = terminals.filter(
    (terminal) =>
      terminal.workspaceId === workspace.id &&
      terminal.hostId === workspace.hostId &&
      terminal.connected &&
      !terminal.orphaned,
  );
  const mapped = candidates.filter((terminal) => ranks.has(terminal.paneKey));
  const needsInput = workspace.agents.some(
    (agent) => agent.state === "waiting",
  );
  if (
    needsInput &&
    !mapped.some((terminal) => ranks.get(terminal.paneKey)?.priority === 0)
  )
    return undefined;
  if (workspace.agents.length > 0 && mapped.length === 0) return undefined;
  const eligible = workspace.agents.length ? mapped : candidates;
  eligible.sort((left, right) => {
    const a = ranks.get(left.paneKey);
    const b = ranks.get(right.paneKey);
    return (
      (a?.priority ?? (left.agentIdentity ? 5 : 6)) -
        (b?.priority ?? (right.agentIdentity ? 5 : 6)) ||
      (a?.since ?? 0) - (b?.since ?? 0) ||
      left.handle.localeCompare(right.handle)
    );
  });
  return eligible[0];
}
