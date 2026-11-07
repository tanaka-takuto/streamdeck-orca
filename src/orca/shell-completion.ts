import type { CliRunner } from "./client";
import { object, readResponse } from "./model";

export type ShellJob = {
  handle: string;
  incarnationId: string;
  workspaceId: string;
  runtimeId: string;
  hostId: string;
  marker: string;
  closeOnExit: boolean;
};

export class ShellCompletion {
  constructor(
    private readonly run: CliRunner,
    private readonly pause: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 1_000).unref()),
  ) {}

  async watch(job: ShellJob): Promise<string> {
    let cursor: string | undefined;
    try {
      for (;;) {
        const response = readResponse(
          await this.run([
            "terminal",
            "read",
            "--terminal",
            job.handle,
            ...(cursor ? ["--cursor", cursor] : []),
            "--limit",
            "1000",
            "--json",
          ]),
        );
        const terminal = object(response.result.terminal);
        if (
          response.runtimeId !== job.runtimeId ||
          terminal.handle !== job.handle ||
          (terminal.source !== undefined && terminal.source !== "stream") ||
          !Array.isArray(terminal.tail)
        )
          throw new Error();
        for (const line of terminal.tail) {
          const match =
            typeof line === "string"
              ? /^(__ORCA_COMMAND_[a-f0-9]+):([0-9]{1,3})__$/u.exec(line.trim())
              : null;
          if (!match || match[1] !== job.marker) continue;
          const code = Number(match[2]);
          if (code > 255) continue;
          if (!job.closeOnExit && code !== 0)
            return `終了コード ${code}：ターミナルを残しました。`;
          const shown = readResponse(
            await this.run([
              "terminal",
              "show",
              "--terminal",
              job.handle,
              "--json",
            ]),
          );
          const current = object(shown.result.terminal);
          if (
            shown.runtimeId !== job.runtimeId ||
            current.handle !== job.handle ||
            current.incarnationId !== job.incarnationId ||
            current.worktreeId !== job.workspaceId ||
            current.executionHostId !== job.hostId ||
            current.agentIdentity ||
            current.orphaned === true
          )
            throw new Error();
          // この実行で作ったプロセスだけを閉じる。閉じる操作は再試行しない。
          try {
            const closed = readResponse(
              await this.run([
                "terminal",
                "close",
                "--terminal",
                job.handle,
                "--json",
              ]),
            );
            const receipt = object(closed.result.close);
            if (
              closed.runtimeId !== job.runtimeId ||
              receipt.handle !== job.handle ||
              receipt.ptyKilled !== true
            )
              throw new Error();
            return `終了コード ${code}：ターミナルを閉じました。`;
          } catch {
            return `終了コード ${code}：自動クローズの結果を確認できません。Orca で確認してください。`;
          }
        }
        if (terminal.status === "exited") throw new Error();
        if (typeof terminal.nextCursor !== "string" || !terminal.nextCursor)
          throw new Error();
        cursor = terminal.nextCursor;
        if (terminal.limited !== true || cursor === terminal.latestCursor)
          await this.pause();
      }
    } catch {
      return "終了を確認できないため自動では閉じません。Orca で確認してください。";
    }
  }
}
