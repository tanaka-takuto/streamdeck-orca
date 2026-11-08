import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { object, readResponse } from "./model";
import { readLocalMetadata } from "./workspace-activation";

export type LocalRpc = (
  method: string,
  params: Record<string, unknown>,
  runtimeId: string,
) => Promise<unknown>;
/** CLIにないdraft起動を、CLIと同じ認証済みローカルagent.launch APIへ渡す。 */
export function createLocalRpc(
  readMetadata = readLocalMetadata,
  timeout = 90_000,
): LocalRpc {
  return async (method, params, runtimeId) => {
    const meta = object(readMetadata());
    if (meta.runtimeId !== runtimeId)
      throw new Error("Orcaの実行環境が変わりました。");
    const transport = (
      Array.isArray(meta.transports) ? meta.transports : [meta.transport]
    )
      .map(object)
      .find((t) => t.kind === "unix" || t.kind === "named-pipe");
    if (
      !transport ||
      typeof transport.endpoint !== "string" ||
      typeof meta.authToken !== "string" ||
      !meta.authToken
    )
      throw new Error("Orcaのローカル接続情報を確認できません。");
    const endpoint = transport.endpoint,
      authToken = meta.authToken;
    return new Promise((resolve, reject) => {
      const id = randomUUID(),
        socket = createConnection(endpoint);
      let buffer = "",
        done = false;
      const finish = (error?: Error, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Orcaの起動応答を確認できません。自動では再実行しません。",
            ),
          ),
        timeout,
      );
      socket.setEncoding("utf8");
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ id, authToken, method, params })}\n`),
      );
      socket.once("error", () =>
        finish(new Error("Orcaへの接続結果を確認できません。")),
      );
      socket.once("close", () =>
        finish(new Error("Orcaの応答前に接続が切れました。")),
      );
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024)
          return finish(new Error("Orcaの応答上限を超えました。"));
        while (!done && buffer.includes("\n")) {
          const at = buffer.indexOf("\n"),
            line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          try {
            const response = object(JSON.parse(line));
            if (response._keepalive === true) continue;
            if (response.id !== id) throw new Error();
            if (readResponse(response).runtimeId !== runtimeId)
              throw new Error();
            finish(undefined, response);
          } catch {
            finish(
              new Error(
                "Orcaの起動結果を確認できません。Orca側を確認してください。",
              ),
            );
          }
        }
      });
    });
  };
}
