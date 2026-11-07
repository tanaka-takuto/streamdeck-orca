import { randomBytes } from "node:crypto";
import type { CliRunner, OrcaClient } from "./client";
import {
  type OrcaSnapshot,
  type OrcaWorkspace,
  object,
  readHostScope,
  readResponse,
} from "./model";
import { ShellCompletion } from "./shell-completion";

export type AgentSelection = {
  handle: string;
  runtimeId: string;
  incarnationId: string;
  identity: string;
};
export type AgentTarget = AgentSelection & { name: string; identity: string };
export type ExecutionSettings = {
  mode?: "shell" | "ai";
  body?: string;
  label?: string;
  agentTargets?: Record<string, AgentSelection>;
  closeOnExit?: boolean;
  closeOnSuccess?: boolean;
};
export type ExecutionResult = {
  status: "accepted" | "refused" | "unknown" | "cancelled";
  message: string;
  handle?: string;
  requestId?: string;
};
export type AgentDirectory = {
  workspaceId: string;
  runtimeId: string;
  targets: AgentTarget[];
};

export class WorkspaceExecutor {
  private readonly completion: ShellCompletion;

  constructor(
    private readonly client: Pick<OrcaClient, "snapshot">,
    private readonly run: CliRunner,
  ) {
    this.completion = new ShellCompletion(run);
  }

  private async workspace(
    workspaceId: string,
  ): Promise<{ snapshot: OrcaSnapshot; workspace: OrcaWorkspace }> {
    const snapshot = await this.client.snapshot();
    const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
    if (!workspace)
      throw new Error(
        "対象のワークスペースを取得できません。ダイヤルで選び直してください。",
      );
    return { snapshot, workspace };
  }

  private async directory(
    snapshot: OrcaSnapshot,
    workspace: OrcaWorkspace,
  ): Promise<AgentDirectory> {
    const response = readResponse(
      await this.run([
        "terminal",
        "list",
        "--worktree",
        `id:${workspace.id}`,
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
        name:
          typeof row.title === "string" && row.title
            ? row.title
            : row.agentIdentity,
      });
    }
    return {
      workspaceId: workspace.id,
      runtimeId: response.runtimeId,
      targets,
    };
  }

  async agents(workspaceId: string): Promise<AgentDirectory> {
    const { snapshot, workspace } = await this.workspace(workspaceId);
    return await this.directory(snapshot, workspace);
  }

  async execute(
    workspaceId: string,
    settings: ExecutionSettings,
    isCurrent = () => true,
  ): Promise<ExecutionResult> {
    const cancelled: ExecutionResult = {
      status: "cancelled",
      message: "選択が変わったため実行していません。",
    };
    if (!isCurrent()) return cancelled;
    if (settings.mode !== "shell" && settings.mode !== "ai")
      throw new Error("実行モードを選んでください。");
    const body = settings.body;
    if (
      typeof body !== "string" ||
      !body.trim() ||
      body.length > 16_000 ||
      body.includes("\0")
    )
      throw new Error("実行内容を1〜16000文字で入力してください。");
    const { snapshot, workspace } = await this.workspace(workspaceId);
    const marker =
      settings.mode === "shell" &&
      (settings.closeOnExit === true || settings.closeOnSuccess === true)
        ? `__ORCA_COMMAND_${randomBytes(16).toString("hex")}`
        : undefined;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = marker
      ? `sh -c ${quote(`"\${SHELL:-/bin/sh}" -ic ${quote(body)}; orca_command_status=$?; printf '\\n${marker}:%s__\\n' "$orca_command_status"`)}`
      : body;
    let target: AgentTarget | undefined;
    let args: string[];
    if (settings.mode === "shell") {
      args = [
        "terminal",
        "create",
        "--worktree",
        `id:${workspace.id}`,
        "--title",
        settings.label?.trim() || "Stream Deck コマンド",
        "--command",
        command,
        "--focus",
        "--json",
      ];
    } else {
      const directory = await this.directory(snapshot, workspace);
      const selected = settings.agentTargets?.[workspace.id];
      if (selected) {
        target = directory.targets.find(
          (row) =>
            row.handle === selected.handle &&
            row.runtimeId === selected.runtimeId &&
            row.incarnationId === selected.incarnationId &&
            row.identity === selected.identity,
        );
        if (!target)
          throw new Error(
            "指定した AI セッションが変わりました。送信先を選び直してください。",
          );
      } else {
        if (directory.targets.length > 1)
          throw new Error(
            "AI が複数います。設定画面で送信先を選んでください。",
          );
        target = directory.targets[0];
        if (!target)
          throw new Error(
            "このワークスペースに送信可能な AI が見つかりません。",
          );
      }
      args = [
        "terminal",
        "send",
        "--terminal",
        target.handle,
        "--text",
        body,
        "--enter",
        "--json",
      ];
    }
    if (!isCurrent()) return cancelled;
    try {
      const response = readResponse(await this.run(args));
      if (response.runtimeId !== snapshot.runtimeId) throw new Error();
      if (settings.mode === "shell") {
        const terminal = object(response.result.terminal);
        if (
          terminal.worktreeId !== workspace.id ||
          typeof terminal.handle !== "string" ||
          !terminal.handle
        )
          throw new Error();
        const result: ExecutionResult = {
          status: "accepted",
          message:
            "コマンドの実行要求を受け付けました。結果は Orca で確認してください。",
          handle: terminal.handle,
        };
        if (marker) {
          if (
            typeof terminal.incarnationId !== "string" ||
            !terminal.incarnationId
          ) {
            result.message =
              "実行要求は受付済みですが、端末の識別情報を確認できないため自動では閉じません。";
          } else {
            result.message =
              "実行要求は受付済みです。終了コードに応じてターミナルを自動で閉じます。";
            void this.completion
              .watch({
                handle: terminal.handle,
                incarnationId: terminal.incarnationId,
                workspaceId: workspace.id,
                runtimeId: snapshot.runtimeId,
                hostId: workspace.hostId,
                marker,
                closeOnExit: settings.closeOnExit === true,
              })
              .then((message) => {
                result.message = message;
              });
          }
        }
        return result;
      }
      const send = object(response.result.send);
      if (send.accepted === false)
        return {
          status: "refused",
          message:
            "AI が入力を受け付けませんでした。Orca 側の状態を確認してください。",
        };
      const prompt = object(send.prompt);
      if (
        send.accepted !== true ||
        send.handle !== target?.handle ||
        typeof prompt.requestId !== "string" ||
        !Array.isArray(prompt.stages) ||
        !prompt.stages.includes("input_accepted")
      )
        throw new Error();
      return {
        status: "accepted",
        message: prompt.stages.includes("turn_started")
          ? "AI の処理開始を確認しました。"
          : "AI への入力受付を確認しました。処理開始はまだ確認していません。",
        handle: target?.handle,
        requestId: prompt.requestId,
      };
    } catch {
      return {
        status: "unknown",
        message:
          "実行・送信の結果を確認できません。Orca 側を確認してください。自動で再実行はしません。",
      };
    }
  }
}
