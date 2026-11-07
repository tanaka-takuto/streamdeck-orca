import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { object, readResponse } from "./model";

export type WorkspaceActivator = (
  workspaceId: string,
  runtimeId: string,
  isCurrent?: () => boolean,
) => Promise<boolean>;

function readLocalMetadata(): unknown {
  let directory = process.env.ORCA_USER_DATA_PATH;
  if (!directory) {
    if (process.platform === "darwin")
      directory = join(homedir(), "Library/Application Support/orca");
    else if (process.platform === "win32" && process.env.APPDATA)
      directory = join(process.env.APPDATA, "orca");
    else if (process.platform === "linux")
      directory = join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "orca",
      );
  }
  try {
    if (!directory) throw new Error();
    return JSON.parse(
      readFileSync(join(directory, "orca-runtime.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "Orca の接続情報を読み込めません。Orca の起動状態を確認してください。",
    );
  }
}

/** Orca 1.4.229 の認証済みローカル RPC。CLI の worktree/terminal と同じ runtimeId に限定する。 */
export function createWorkspaceActivator(
  readMetadata: () => unknown = readLocalMetadata,
): WorkspaceActivator {
  return async (workspaceId, runtimeId, isCurrent = () => true) => {
    if (!isCurrent()) return false;
    const metadata = object(readMetadata());
    if (metadata.runtimeId !== runtimeId)
      throw new Error(
        "Orca の実行環境が変わりました。もう一度ボタンを押してください。",
      );
    const transports = Array.isArray(metadata.transports)
      ? metadata.transports
      : [metadata.transport];
    const transport = transports
      .map(object)
      .find((value) => value.kind === "unix" || value.kind === "named-pipe");
    if (
      !transport ||
      typeof transport.endpoint !== "string" ||
      !transport.endpoint ||
      typeof metadata.authToken !== "string" ||
      !metadata.authToken
    ) {
      throw new Error("Orca のローカル接続情報を確認できません。");
    }
    const endpoint = transport.endpoint;
    const authToken = metadata.authToken;
    return await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(endpoint);
      const id = randomUUID();
      let buffer = "";
      let settled = false;
      const timer = setTimeout(
        () =>
          finish(
            new Error("Orca のワークスペース切り替えがタイムアウトしました。"),
          ),
        5_000,
      );
      function finish(error: Error | null, activated = false) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(activated);
      }
      socket.setEncoding("utf8");
      socket.once("error", () =>
        finish(
          new Error("Orca のワークスペース切り替え API に接続できません。"),
        ),
      );
      socket.once("close", () =>
        finish(new Error("Orca の切り替え応答を確認できません。")),
      );
      socket.once("connect", () => {
        if (!isCurrent()) {
          finish(null);
          return;
        }
        socket.write(
          `${JSON.stringify({ id, authToken, method: "worktree.activate", params: { worktree: `id:${workspaceId}`, navigation: "host" } })}\n`,
        );
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 256 * 1024) {
          finish(new Error("Orca の切り替え応答が大きすぎます。"));
          return;
        }
        while (!settled) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const response = object(JSON.parse(line));
            if (response._keepalive === true) continue;
            const parsed = readResponse(response);
            if (
              response.id !== id ||
              parsed.runtimeId !== runtimeId ||
              parsed.result.worktreeId !== workspaceId ||
              parsed.result.activated !== true
            )
              throw new Error();
            finish(null, true);
          } catch {
            // 認証情報を含みうる応答やメタデータ全体はログへ出さない。
            finish(
              new Error("Orca のワークスペース切り替えを確認できません。"),
            );
          }
        }
      });
    });
  };
}
