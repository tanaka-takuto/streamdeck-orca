import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type OrcaSnapshot,
  type OrcaTerminal,
  object,
  parseSnapshot,
  readHostScope,
  readResponse,
  selectTerminal,
} from "./model";

export type CliRunner = (args: string[]) => Promise<unknown>;

export function resolveOrcaCommand(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  const name = process.env.ORCA_DEV_REPO_ROOT
    ? "orca-dev"
    : process.platform === "linux"
      ? "orca-ide"
      : "orca";
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "darwin")
    directories.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const directory of directories) {
    const command = join(
      directory,
      process.platform === "win32" ? `${name}.exe` : name,
    );
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      // 実行前に一つ選ぶ。選んだ CLI の接続失敗で別ビルドへ切り替えない。
    }
  }
  return name;
}

export function createCliRunner(command = resolveOrcaCommand()): CliRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout) => {
          try {
            const result: unknown = JSON.parse(stdout);
            if (error && object(result).ok !== false) throw error;
            resolve(result);
          } catch {
            reject(
              new Error(
                error && "code" in error && error.code === "ENOENT"
                  ? "Orca CLI が見つかりません。Orca の設定で CLI を有効にしてください。"
                  : "Orca の応答を取得できません。Orca が起動しているか確認してください。",
              ),
            );
          }
        },
      );
    });
}

export class OrcaClient {
  constructor(private readonly run: CliRunner = createCliRunner()) {}

  async snapshot(): Promise<OrcaSnapshot> {
    return parseSnapshot(
      await this.run(["worktree", "ps", "--limit", "200", "--json"]),
    );
  }

  async focusWorkspace(
    workspaceId: string,
    isCurrent = () => true,
  ): Promise<boolean> {
    const snapshot = await this.snapshot();
    if (!isCurrent()) return false;
    const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
    if (!workspace)
      throw new Error(
        "割り当てたワークスペースを取得できません。設定を確認してください。",
      );
    const response = readResponse(
      await this.run([
        "terminal",
        "list",
        "--worktree",
        `id:${workspaceId}`,
        "--limit",
        "200",
        "--json",
      ]),
    );
    if (!isCurrent()) return false;
    if (response.runtimeId !== snapshot.runtimeId)
      throw new Error(
        "Orca の再起動で実行環境が変わりました。もう一度ボタンを押してください。",
      );
    const hostIds = readHostScope(response.result);
    if (
      !hostIds.includes(workspace.hostId) ||
      !Array.isArray(response.result.terminals) ||
      response.result.truncated !== false
    ) {
      throw new Error("対象ターミナルの一覧を確認できません。");
    }
    const terminals: OrcaTerminal[] = response.result.terminals.map((value) => {
      const row = object(value);
      return {
        handle: typeof row.handle === "string" ? row.handle : "",
        workspaceId: typeof row.worktreeId === "string" ? row.worktreeId : "",
        paneKey: `${row.tabId}:${row.leafId}`,
        hostId:
          typeof row.executionHostId === "string"
            ? row.executionHostId
            : "unknown",
        connected:
          row.connected === true &&
          typeof row.handle === "string" &&
          row.handle.length > 0,
        orphaned: row.orphaned === true,
        agentIdentity:
          typeof row.agentIdentity === "string" ? row.agentIdentity : undefined,
      };
    });
    const terminal = selectTerminal(workspace, terminals);
    if (!terminal)
      throw new Error(
        "表示できる対象ターミナルが見つかりません。Orca で状態を確認してください。",
      );
    if (!isCurrent()) return false;
    const switched = readResponse(
      await this.run([
        "terminal",
        "switch",
        "--terminal",
        terminal.handle,
        "--json",
      ]),
    );
    if (
      switched.runtimeId !== snapshot.runtimeId ||
      object(switched.result.focus).navigated !== true
    ) {
      throw new Error("対象ターミナルへの表示切り替えを確認できません。");
    }
    return true;
  }
}
