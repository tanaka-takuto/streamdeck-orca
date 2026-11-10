import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { executable, runCommand } from "../command";
import {
  type GitHubReviews,
  prKey,
  type ReviewDetail,
  type ReviewOrder,
  type ReviewPR,
} from "../github/reviews";
import {
  normalizeReviewSettings,
  type ReviewSettings,
  reviewHandoff,
  reviewPrompt,
} from "../pr-review-settings";
import type { CliRunner } from "./client";
import type { LocalRpc } from "./local-rpc";
import { object, readHostScope, readResponse } from "./model";

export type ReviewRecord = {
  status: "pending" | "accepted" | "unknown";
  operationId: string;
  pr: ReviewDetail;
  accountId: number;
  workspaceId?: string;
  handle?: string;
  message: string;
  at: number;
};
export type ReviewLaunchResult = {
  status: "accepted" | "opened" | "unknown" | "cancelled";
  message: string;
  record?: ReviewRecord;
};
export const reviewRecordFingerprint = (r?: ReviewRecord): string =>
  r ? JSON.stringify([r.status, r.operationId, r.workspaceId, r.at]) : "null";
/** The personal queue reuses the latest record across head commits; uncertainty wins ties. */
export function latestReviewRecord(
  records: Record<string, ReviewRecord>,
  accountId: number,
  pr: ReviewPR,
): ReviewRecord | undefined {
  return Object.values(records)
    .filter((r) => r && r.accountId === accountId && prKey(r.pr) === prKey(pr))
    .sort(
      (a, b) =>
        b.at - a.at ||
        Number(a.status === "accepted") - Number(b.status === "accepted"),
    )[0];
}
type Dependencies = {
  github: Pick<GitHubReviews, "detail">;
  run: CliRunner;
  rpc: LocalRpc;
  git?: (path: string, args: string[]) => Promise<string>;
  readRecords: () => Promise<Record<string, ReviewRecord>>;
  saveRecord: (key: string, value: ReviewRecord | undefined) => Promise<void>;
  focus: (id: string, isCurrent: () => boolean) => Promise<boolean>;
  cloneRoot?: string;
};
export const launchKey = (account: number, pr: ReviewDetail) =>
  `${account}:${prKey(pr)}:${pr.sha}`;
const canonical = (url: string) => {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-z\d_.-]+\/[a-z\d_.-]+?)(?:\.git)?\/?$/iu.exec(
      url.trim(),
    );
  return match?.[1].toLowerCase();
};
export class ReviewLauncher {
  private readonly busy = new Set<string>();
  private readonly git: NonNullable<Dependencies["git"]>;
  constructor(private readonly deps: Dependencies) {
    this.git =
      deps.git ??
      ((path, args) => runCommand(executable("git"), ["-C", path, ...args]));
  }
  private response(value: unknown, runtimeId?: string) {
    const result = readResponse(value);
    if (runtimeId && result.runtimeId !== runtimeId)
      throw new Error("Orcaの実行環境が変わりました。起動していません。");
    return result;
  }
  private async defaultAgent(runtimeId: string): Promise<string> {
    let settings: Record<string, unknown>;
    try {
      settings = object(
        this.response(
          await this.deps.rpc("settings.getAgentLaunch", {}, runtimeId),
          runtimeId,
        ).result.settings,
      );
    } catch (error) {
      throw new Error(
        `OrcaのデフォルトAIを取得できません。${error instanceof Error ? error.message : "Orcaの接続を確認してください。"}`,
      );
    }
    const agent = settings.defaultTuiAgent;
    if (agent === null || agent === "blank")
      throw new Error(
        "OrcaのデフォルトAIが未設定、または通常ターミナルです。Orcaの設定でAIを選んでください。",
      );
    if (
      typeof agent !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(agent) ||
      !Array.isArray(settings.disabledTuiAgents) ||
      !settings.disabledTuiAgents.every((id) => typeof id === "string")
    )
      throw new Error("OrcaのデフォルトAIの設定を確認できません。");
    if (settings.disabledTuiAgents.includes(agent))
      throw new Error(
        "OrcaのデフォルトAIが無効です。Orcaの設定で有効なAIを選んでください。",
      );
    return agent;
  }
  private async repo(
    pr: ReviewPR,
    runtimeId: string,
    isCurrent: () => boolean,
  ) {
    const get = async () => {
      const response = this.response(
        await this.deps.run(["repo", "list", "--json"]),
        runtimeId,
      );
      if (!Array.isArray(response.result.repos))
        throw new Error("Orcaのリポジトリ一覧を確認できません。");
      return response.result.repos
        .map(object)
        .filter(
          (r) =>
            r.kind === "git" &&
            r.gitRemoteIdentity &&
            object(r.gitRemoteIdentity).canonicalKey ===
              `github.com/${pr.repo.toLowerCase()}`,
        );
    };
    let repos = await get();
    if (repos.length > 1)
      throw new Error(
        "同じリポジトリがOrcaに複数あります。使用するリポジトリを一つにしてください。",
      );
    if (!repos.length) {
      const path = join(
        this.deps.cloneRoot ?? join(homedir(), "orca", "review-repositories"),
        ...pr.repo.split("/"),
      );
      if (!isCurrent())
        throw new Error("選択や設定が変わったため中止しました。");
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        await runCommand(
          executable("gh"),
          ["repo", "clone", `https://github.com/${pr.repo}.git`, path],
          120_000,
        );
      }
      const remote = await this.git(path, ["remote", "get-url", "origin"]);
      if (canonical(remote) !== pr.repo.toLowerCase())
        throw new Error(
          "保存先に別のリポジトリがあります。Orcaへ対象リポジトリを追加してください。",
        );
      if (!isCurrent())
        throw new Error("選択や設定が変わったため中止しました。");
      this.response(
        await this.deps.run(["repo", "add", "--path", path, "--json"]),
        runtimeId,
      );
      repos = await get();
    }
    const repo = repos[0];
    if (
      repos.length !== 1 ||
      typeof repo.id !== "string" ||
      typeof repo.path !== "string"
    )
      throw new Error("Orcaの対象リポジトリを確認できません。");
    return {
      id: repo.id,
      path: repo.path,
      remote: object(repo.gitRemoteIdentity),
    };
  }
  async launch(
    pr: ReviewPR,
    accountId: number,
    raw: ReviewSettings,
    isCurrent = () => true,
    order: ReviewOrder = "desc",
    expectedRecord?: string,
  ): Promise<ReviewLaunchResult> {
    const lock = `${accountId}:${prKey(pr)}`;
    if (this.busy.has(lock))
      return {
        status: "cancelled",
        message: "このPRの起動処理中です。完了までお待ちください。",
      };
    this.busy.add(lock);
    let key: string | undefined,
      record: ReviewRecord | undefined,
      uncertain = false;
    try {
      const handoff = reviewHandoff(raw);
      const settings = {
        ...normalizeReviewSettings(raw),
        enter: handoff === "send",
      };
      const detail = await this.deps.github.detail(
        pr,
        settings.reviewMode,
        accountId,
        order,
      );
      const text =
        handoff === "none" ? undefined : reviewPrompt(settings.body, detail);
      key = launchKey(accountId, detail);
      const records = await this.deps.readRecords();
      const previous =
        order === "asc"
          ? latestReviewRecord(records, accountId, pr)
          : records[key];
      if (
        !isCurrent() ||
        (expectedRecord !== undefined &&
          expectedRecord !== reviewRecordFingerprint(previous))
      )
        return {
          status: "cancelled",
          message:
            "選択・設定・起動記録が変わったため操作していません。表示を更新して押し直してください。",
        };
      if (previous) {
        if (previous.status === "accepted" && previous.workspaceId) {
          const current = this.response(
            await this.deps.run([
              "worktree",
              "show",
              "--worktree",
              `id:${previous.workspaceId}`,
              "--json",
            ]),
          );
          const workspace = object(current.result.worktree);
          const expectedBranch =
            detail.headRepo.toLowerCase() === detail.repo.toLowerCase()
              ? detail.branch
              : `streamdeck-review/pr-${pr.number}`;
          if (
            workspace.id !== previous.workspaceId ||
            workspace.hostId !== "local" ||
            workspace.isArchived === true ||
            typeof workspace.path !== "string"
          )
            throw new Error(
              "起動済みワークスペースを確認できません。Orcaで確認してください。",
            );
          const sha = (
            await this.git(workspace.path, ["rev-parse", "--verify", "HEAD"])
          ).trim();
          const branch = (
            await this.git(workspace.path, ["symbolic-ref", "--short", "HEAD"])
          ).trim();
          if (sha !== detail.sha || branch !== expectedBranch)
            throw new Error(
              "起動済みWSのブランチ・HEADがPRと一致しません。Orcaで確認してください。",
            );
          if (!isCurrent())
            return {
              status: "cancelled",
              message: "選択や設定が変わったため開いていません。",
            };
          if (!(await this.deps.focus(previous.workspaceId, isCurrent)))
            throw new Error(
              "起動済みのワークスペースを開けません。Orcaで確認してください。",
            );
          return {
            status: "opened",
            message:
              "起動済みのワークスペースを開きました。AIへの再入力はしていません。",
            record: previous,
          };
        }
        return {
          status: "unknown",
          message:
            "前回の起動結果が未確認です。Orcaで確認し、設定画面で記録を解除するまで再実行しません。",
          record: previous,
        };
      }
      const status = this.response(await this.deps.run(["status", "--json"]));
      const runtimeId = status.runtimeId;
      const capabilities =
        status.result.capabilities ??
        (status.result.runtime
          ? object(status.result.runtime).capabilities
          : undefined);
      if (
        !Array.isArray(capabilities) ||
        ![
          "agent.launch.v2",
          ...(text === undefined ? [] : ["agent.launch.prompt-carry.v1"]),
          "agent.launch.replay-required.v1",
        ].every((c) => capabilities.includes(c))
      )
        throw new Error(
          "この機能にはAI起動・下書き対応のOrcaが必要です。Orcaを更新してください。",
        );
      const agent =
        settings.agent === "default"
          ? await this.defaultAgent(runtimeId)
          : settings.agent;
      if (
        !isCurrent() ||
        (expectedRecord !== undefined &&
          expectedRecord !== reviewRecordFingerprint(previous))
      )
        return {
          status: "cancelled",
          message:
            "選択・設定・起動記録が変わったため操作していません。表示を更新して押し直してください。",
        };
      record = {
        status: "pending",
        operationId: `${Date.now()}-${randomUUID().replaceAll("-", "")}`,
        pr: detail,
        accountId,
        message: "ワークスペースを準備しています。",
        at: Date.now(),
      };
      await this.deps.saveRecord(key, record);
      const repo = await this.repo(pr, runtimeId, isCurrent);
      const remoteName = repo.remote.remoteName;
      if (typeof remoteName !== "string")
        throw new Error("GitHubのリモートを確認できません。");
      const url = (
        await this.git(repo.path, ["remote", "get-url", remoteName])
      ).trim();
      if (canonical(url) !== pr.repo.toLowerCase())
        throw new Error("GitHubとOrcaのリポジトリが一致しません。");
      const branch =
        detail.headRepo.toLowerCase() === detail.repo.toLowerCase()
          ? detail.branch
          : `streamdeck-review/pr-${pr.number}`;
      await this.git(repo.path, ["check-ref-format", "--branch", branch]);
      const list = async () => {
        const r = this.response(
          await this.deps.run([
            "worktree",
            "list",
            "--repo",
            `id:${repo.id}`,
            "--json",
          ]),
          runtimeId,
        );
        if (
          r.result.truncated !== false ||
          !readHostScope(r.result).includes("local") ||
          !Array.isArray(r.result.worktrees)
        )
          throw new Error("ワークスペース一覧を完全に取得できません。");
        return r.result.worktrees
          .map(object)
          .filter(
            (w) =>
              w.isArchived !== true &&
              w.hostId === "local" &&
              (w.branch === `refs/heads/${branch}` || w.branch === branch),
          );
      };
      let candidates = await list();
      if (candidates.length > 1)
        throw new Error(
          "対象ブランチのワークスペースが複数あります。Orcaで確認してください。",
        );
      if (!candidates.length) {
        const ref = `refs/streamdeck-orca/pr-${pr.number}-${detail.sha}`;
        if (!isCurrent())
          throw new Error("選択や設定が変わったため中止しました。");
        await this.git(repo.path, [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "--",
          url,
          `refs/pull/${pr.number}/head:${ref}`,
        ]);
        if (
          (await this.git(repo.path, ["rev-parse", "--verify", ref])).trim() !==
          detail.sha
        )
          throw new Error(
            "PRのコミットが変わりました。更新して選び直してください。",
          );
        if (!isCurrent())
          throw new Error("選択や設定が変わったため中止しました。");
        uncertain = true;
        this.response(
          await this.deps.rpc(
            "worktree.create",
            {
              repo: `id:${repo.id}`,
              name: `review-pr-${pr.number}`,
              branchNameOverride: branch,
              baseBranch: ref,
              linkedPR: pr.number,
              noParent: true,
              setupDecision: "skip",
              activate: false,
              clientMutationId: `${record.operationId}-workspace`,
            },
            runtimeId,
          ),
          runtimeId,
        );
        uncertain = false;
        candidates = await list();
      }
      const ws = candidates[0];
      if (
        candidates.length !== 1 ||
        typeof ws.id !== "string" ||
        typeof ws.path !== "string"
      )
        throw new Error(
          "作成したワークスペースを確認できません。Orcaで確認してください。",
        );
      record.workspaceId = ws.id;
      const workspacePath = ws.path;
      const verifyWorkspace = async () => {
        const sha = (
          await this.git(workspacePath, ["rev-parse", "--verify", "HEAD"])
        ).trim();
        const actualBranch = (
          await this.git(workspacePath, ["symbolic-ref", "--short", "HEAD"])
        ).trim();
        if (sha !== detail.sha || actualBranch !== branch)
          throw new Error(
            "既存WSのブランチ・HEADがPRと一致しません。Orcaで最新コミットを確認してください。自動更新はしません。",
          );
        if (
          (
            await this.git(workspacePath, [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ])
          ).trim()
        )
          throw new Error(
            "対象WSに未コミット変更があります。Orcaで確認してください。AIは起動していません。",
          );
      };
      await verifyWorkspace();
      const fresh = await this.deps.github.detail(
        pr,
        settings.reviewMode,
        accountId,
        order,
      );
      if (
        fresh.sha !== detail.sha ||
        fresh.headRepo !== detail.headRepo ||
        fresh.branch !== detail.branch
      )
        throw new Error(
          "PRのコミットが変わりました。更新して選び直してください。",
        );
      await verifyWorkspace();
      this.response(await this.deps.run(["status", "--json"]), runtimeId);
      if (!isCurrent())
        throw new Error(
          "選択や設定が変わったため中止しました。AIは起動していません。",
        );
      record.message = "AIの起動結果を待っています。";
      await this.deps.saveRecord(key, record);
      if (
        settings.agent === "default" &&
        (await this.defaultAgent(runtimeId)) !== agent
      )
        throw new Error(
          "OrcaのデフォルトAIが変わりました。起動していません。表示を確認して押し直してください。",
        );
      if (!isCurrent())
        throw new Error(
          "選択や設定が変わったため中止しました。AIは起動していません。",
        );
      uncertain = true;
      const launched = this.response(
        await this.deps.rpc(
          "agent.launchReplay",
          {
            operationId: record.operationId,
            agent,
            target: { kind: "existing", worktree: `id:${ws.id}` },
            ...(text === undefined
              ? {}
              : {
                  prompt: {
                    text,
                    delivery: settings.enter ? "submit" : "draft",
                  },
                }),
            launchSource: "cli",
            presentation: "focused",
          },
          runtimeId,
        ),
        runtimeId,
      ).result;
      const outcome = object(launched.outcome),
        prompt = text === undefined ? undefined : object(launched.prompt);
      if (
        launched.worktreeId !== ws.id ||
        !["terminal", "structured"].includes(String(outcome.kind)) ||
        typeof outcome.handle !== "string" ||
        !outcome.handle ||
        (text !== undefined &&
          (prompt?.delivery !== (settings.enter ? "submit" : "draft") ||
            !["handed-to-terminal", "journaled"].includes(
              String(prompt?.outcome),
            )))
      )
        throw new Error("AIへの入力結果を確認できません。");
      record.status = "accepted";
      record.handle = outcome.handle;
      record.message =
        text === undefined
          ? "AI起動を確認しました。本文は渡していません。"
          : settings.enter
            ? "AI起動と入力・Enterの引き渡しを確認しました。処理結果はOrcaで確認してください。"
            : "AI起動と下書きの引き渡しを確認しました。Enterは送っていません。";
      await this.deps.saveRecord(key, record);
      return { status: "accepted", message: record.message, record };
    } catch (error) {
      if (record && key && uncertain) {
        record.status = "unknown";
        record.message =
          "起動結果が未確認です。Orcaで確認してください。自動では再実行しません。";
        await this.deps.saveRecord(key, record);
        return { status: "unknown", message: record.message, record };
      }
      if (record && key) await this.deps.saveRecord(key, undefined);
      throw error;
    } finally {
      this.busy.delete(lock);
    }
  }
  async forget(
    accountId: number,
    pr: ReviewPR,
    operationId: string,
  ): Promise<void> {
    const prefix = `${accountId}:${prKey(pr)}:`;
    if (this.busy.has(`${accountId}:${prKey(pr)}`))
      throw new Error("起動処理中は記録を解除できません。");
    const lock = `${accountId}:${prKey(pr)}`;
    this.busy.add(lock);
    try {
      const entries = Object.entries(await this.deps.readRecords()).filter(
        ([key, record]) =>
          key.startsWith(prefix) && record?.operationId === operationId,
      );
      if (entries.length !== 1)
        throw new Error(
          "表示した起動記録が変わりました。更新して確認してください。",
        );
      await this.deps.saveRecord(entries[0][0], undefined);
    } finally {
      this.busy.delete(lock);
    }
  }
}
