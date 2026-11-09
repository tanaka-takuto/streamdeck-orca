import type { CliRunner, OrcaClient } from "./client";
import {
  type OrcaSnapshot,
  type OrcaWorkspace,
  object,
  readHostScope,
  readResponse,
} from "./model";
import { terminalLocations } from "./terminal-location";

export type AgentSelection = {
  handle: string;
  runtimeId: string;
  incarnationId: string;
  identity: string;
};
export type AgentTarget = AgentSelection & {
  name: string;
  identity: string;
  paneKey?: string;
  location?: string;
};
export type AgentDirectory = {
  workspaceId: string;
  runtimeId: string;
  targets: AgentTarget[];
  workspace: OrcaWorkspace;
  snapshot: OrcaSnapshot;
  topologyRevision?: number;
};

export class AgentDirectoryReader {
  constructor(
    private readonly client: Pick<OrcaClient, "snapshot">,
    private readonly run: CliRunner,
  ) {}

  private async workspace(
    workspaceId: string,
  ): Promise<{ snapshot: OrcaSnapshot; workspace: OrcaWorkspace }> {
    const snapshot = await this.client.snapshot();
    const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
    if (!workspace)
      throw new Error(
        "対象のワークスペースを取得できません。設定の対象を確認してください。",
      );
    return { snapshot, workspace };
  }

  private async directory(
    snapshot: OrcaSnapshot,
    workspace: OrcaWorkspace,
    includeLocations = false,
  ): Promise<AgentDirectory> {
    const response = readResponse(
      await this.run([
        "terminal",
        "list",
        "--worktree",
        `id:${workspace.id}`,
        ...(includeLocations ? ["--include-visual-layouts"] : []),
        "--limit",
        "200",
        "--json",
      ]),
    );
    if (response.runtimeId !== snapshot.runtimeId)
      throw new Error(
        "Orca の再起動を検出しました。AI の送信先を選び直してください。",
      );
    if (
      !readHostScope(response.result).includes(workspace.hostId) ||
      response.result.truncated !== false ||
      !Array.isArray(response.result.terminals)
    )
      throw new Error("AI の送信先一覧を確認できません。");
    const targets: AgentTarget[] = [];
    const locations = includeLocations
      ? terminalLocations(response.result.visualLayouts, workspace.id)
      : undefined;
    for (const value of response.result.terminals) {
      const row = object(value);
      if (
        row.worktreeId !== workspace.id ||
        row.executionHostId !== workspace.hostId ||
        row.connected !== true ||
        row.writable !== true ||
        row.orphaned === true ||
        typeof row.agentIdentity !== "string" ||
        !row.agentIdentity ||
        typeof row.handle !== "string" ||
        !row.handle ||
        typeof row.incarnationId !== "string" ||
        !row.incarnationId
      )
        continue;
      targets.push({
        handle: row.handle,
        runtimeId: response.runtimeId,
        incarnationId: row.incarnationId,
        identity: row.agentIdentity,
        paneKey:
          typeof row.tabId === "string" && typeof row.leafId === "string"
            ? `${row.tabId}:${row.leafId}`
            : undefined,
        name:
          typeof row.title === "string" && row.title
            ? row.title
            : row.agentIdentity,
        location:
          locations?.get(row.handle)?.paneKey === `${row.tabId}:${row.leafId}`
            ? locations?.get(row.handle)?.location
            : undefined,
      });
    }
    return {
      workspaceId: workspace.id,
      runtimeId: response.runtimeId,
      targets,
      workspace,
      snapshot,
      topologyRevision: includeLocations
        ? (object(response.result.topologyRevisions)[workspace.id] as number)
        : undefined,
    };
  }

  async agents(
    workspaceId: string,
    includeLocations = false,
  ): Promise<AgentDirectory> {
    const { snapshot, workspace } = await this.workspace(workspaceId);
    return await this.directory(snapshot, workspace, includeLocations);
  }
}
