import {
  type ActiveSelectionReader,
  createActiveSelectionReader,
} from "./active-selection";
import type { CliRunner, OrcaClient } from "./client";
import { type ExecutionResult, WorkspaceExecutor } from "./execution";
import { object, readResponse } from "./model";

export type ActiveInputSettings = {
  body?: string;
  label?: string;
  enter?: boolean;
};

export class ActiveAiInput {
  private readonly executor: WorkspaceExecutor;
  constructor(
    client: Pick<OrcaClient, "snapshot">,
    private readonly run: CliRunner,
    private readonly readActive: ActiveSelectionReader = createActiveSelectionReader(),
  ) {
    this.executor = new WorkspaceExecutor(client, run);
  }

  async resolve() {
    const selection = await this.readActive();
    const status = readResponse(await this.run(["status", "--json"]));
    const app = object(status.result.app);
    if (
      status.runtimeId !== selection.runtimeId ||
      app.running !== true ||
      app.desktopWindowStatus !== "available"
    )
      throw new Error(
        "Orca のデスクトップ画面で入力先の AI ターミナルを選択してください。",
      );
    const directory = await this.executor.agents(selection.workspaceId);
    if (directory.runtimeId !== selection.runtimeId)
      throw new Error(
        "Orca の実行環境が変わりました。入力先を確認してください。",
      );
    const matches = directory.targets.filter(
      (row) => row.paneKey === selection.paneKey,
    );
    if (matches.length !== 1)
      throw new Error(
        "選択中のペインに入力可能な AI がいません。Orca で AI ターミナルを選択してください。",
      );
    return { selection, target: matches[0] };
  }

  async send(
    settings: ActiveInputSettings,
    isCurrent = () => true,
  ): Promise<ExecutionResult> {
    const cancelled: ExecutionResult = {
      status: "cancelled",
      message: "選択や設定が変わったため入力していません。",
    };
    if (!isCurrent()) return cancelled;
    const body =
      typeof settings.body === "string"
        ? settings.body.replaceAll("\r\n", "\n")
        : undefined;
    if (
      typeof body !== "string" ||
      !body.trim() ||
      body.length > 16_000 ||
      Array.from(body).some((character) => {
        const code = character.charCodeAt(0);
        return (
          (code < 32 && code !== 9 && code !== 10) ||
          (code >= 127 && code <= 159)
        );
      })
    )
      throw new Error(
        "入力する文字列を1〜16000文字で設定してください。制御文字は使用できません。",
      );
    const { selection, target } = await this.resolve();
    if (!isCurrent()) return cancelled;
    const current = await this.readActive();
    if (
      !isCurrent() ||
      current.runtimeId !== selection.runtimeId ||
      current.workspaceId !== selection.workspaceId ||
      current.paneKey !== selection.paneKey
    )
      return cancelled;
    const enter = settings.enter === true;
    // 生の改行が実行キーになるのを避け、入力のみの複数行は bracketed paste として渡す。
    const text =
      !enter && (body.includes("\n") || body.includes("\t"))
        ? `\x1b[200~${body}\x1b[201~`
        : body;
    try {
      const response = readResponse(
        await this.run([
          "terminal",
          "send",
          "--terminal",
          target.handle,
          "--text",
          text,
          ...(enter ? ["--enter"] : []),
          "--json",
        ]),
      );
      if (response.runtimeId !== selection.runtimeId) throw new Error();
      const send = object(response.result.send);
      if (send.handle !== target.handle) throw new Error();
      if (send.accepted === false)
        return {
          status: "refused",
          message: "AI が入力を受け付けませんでした。Orca で確認してください。",
        };
      if (send.accepted !== true) throw new Error();
      if (!enter)
        return {
          status: "accepted",
          handle: target.handle,
          message: "文字列の入力受付を確認しました。Enter は送っていません。",
        };
      const prompt = object(send.prompt);
      if (
        typeof prompt.requestId !== "string" ||
        !Array.isArray(prompt.stages) ||
        !prompt.stages.includes("input_accepted")
      )
        throw new Error();
      return {
        status: "accepted",
        handle: target.handle,
        requestId: prompt.requestId,
        message: prompt.stages.includes("turn_started")
          ? "AI の処理開始を確認しました。"
          : "入力と Enter の受付を確認しました。処理開始はまだ確認していません。",
      };
    } catch {
      return {
        status: "unknown",
        message:
          "入力結果を確認できません。Orca で確認してください。自動では再入力しません。",
      };
    }
  }
}
