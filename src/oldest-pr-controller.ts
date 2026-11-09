import type { GitHubReviews, ReviewList, ReviewPR } from "./github/reviews";
import { prKey } from "./github/reviews";
import { svgText, twoLines } from "./key-text";
import type {
  ReviewLauncher,
  ReviewLaunchResult,
} from "./orca/review-launcher";
import {
  normalizeOldestReviewSettings,
  type ReviewSettings,
} from "./pr-review-settings";
import type { WorkspaceKey } from "./workspace-buttons";
import { workspaceTag } from "./workspace-identity";

type Key = WorkspaceKey & { device?: { id: string; isConnected?: boolean } };
type Intent = { pr: ReviewPR; accountId: number; count: number };
type Binding = {
  key: Key;
  settings: ReturnType<typeof normalizeOldestReviewSettings>;
  version: number;
  busy: boolean;
  shown?: Intent;
  intent?: Intent;
  error?: string;
  message?: string;
  result?: ReviewLaunchResult;
  resultFor?: string;
};
const signature = (i: Intent) => `${i.accountId}:${prKey(i.pr)}`;
export const handoffLabel = (mode: string) =>
  mode === "send"
    ? "入力して送信"
    : mode === "draft"
      ? "下書きを入力"
      : "AI起動のみ";
export function oldestReviewImage(data: {
  count?: number;
  incomplete?: boolean;
  pr?: ReviewPR;
  phase: string;
  handoff: string;
  agent?: string;
  error?: boolean;
}): string {
  const label =
    data.count === undefined
      ? "—"
      : data.incomplete
        ? "未確定"
        : `${data.count}件`;
  const lines = twoLines(data.pr?.repo ?? "", 18);
  const size = Math.min(
    34,
    Math.floor(124 / (Math.max(1, label.length - 1) * 0.62 + 1)),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="${data.error ? "#633449" : data.count === 0 ? "#374151" : "#145c9e"}"/><g fill="#fff" font-family="-apple-system,sans-serif" text-anchor="middle">${svgText("レビュー待ち", 20, 14)}${svgText(label, 59, size)}${svgText(lines[0], 79, 12)}${svgText(lines[1], 94, 12)}${svgText(data.pr ? `#${data.pr.number} · ${workspaceTag(data.pr.repo.toLowerCase())}` : "", 108, 12)}${svgText(`${data.agent === "claude" ? "Claude" : "Codex"} · ${handoffLabel(data.handoff)}`, 123, 11)}${svgText(data.phase, 139, 11)}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
/** One personal queue. A rendered target must survive a fresh oldest-first lookup. */
export class OldestPRController {
  private readonly bindings = new Map<string, Binding>();
  private readonly queues = new Map<string, Promise<void>>();
  private data?: ReviewList;
  private error?: string;
  private updating = false;
  private at?: number;
  private epoch = 0;
  private pending?: { epoch: number; promise: Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly github: Pick<GitHubReviews, "list">,
    private readonly launcher: Pick<ReviewLauncher, "launch" | "forget">,
    private readonly interval = 30000,
  ) {}
  bind(key: Key, raw: ReviewSettings): void {
    this.unbind(key.id);
    const first = this.bindings.size === 0;
    if (first) ++this.epoch;
    const b: Binding = {
      key,
      settings: normalizeOldestReviewSettings(raw),
      version: 0,
      busy: false,
    };
    this.bindings.set(key.id, b);
    this.render(b);
    void this.refresh(key.id);
  }
  unbind(id: string): void {
    const b = this.bindings.get(id);
    if (!b) return;
    this.bindings.delete(id);
    b.shown = undefined;
    ++b.version;
    if (!this.bindings.size) {
      ++this.epoch;
      clearTimeout(this.timer);
      this.data = undefined;
      this.error = undefined;
      this.updating = false;
    }
  }
  disconnect(deviceId: string): void {
    for (const [id, b] of this.bindings)
      if (b.key.device?.id === deviceId) this.unbind(id);
  }
  private current(b: Binding): boolean {
    return (
      this.bindings.get(b.key.id) === b && b.key.device?.isConnected !== false
    );
  }
  private publish(): void {
    for (const b of this.bindings.values()) this.render(b);
  }
  async refresh(id?: string): Promise<void> {
    if (id && !this.bindings.has(id)) return;
    const epoch = this.epoch;
    if (this.pending?.epoch === epoch) return this.pending.promise;
    clearTimeout(this.timer);
    this.updating = true;
    this.publish();
    const promise = (async () => {
      try {
        const data = await this.github.list("personal", undefined, "asc");
        if (epoch !== this.epoch) return;
        if (
          !Number.isSafeInteger(data.totalCount) ||
          data.totalCount < data.rows.length ||
          typeof data.incomplete !== "boolean" ||
          (!data.incomplete && data.totalCount > 0 && !data.rows.length) ||
          data.rows.some(
            (pr) => !pr.updatedAt || !Number.isFinite(Date.parse(pr.updatedAt)),
          )
        )
          throw new Error("レビュー件数・更新日時を確認できません。");
        this.data = data;
        this.error = undefined;
        this.at = Date.now();
      } catch (error) {
        if (epoch === this.epoch) {
          this.data = undefined;
          this.error =
            error instanceof Error
              ? error.message
              : "レビュー依頼を取得できません。";
        }
      } finally {
        if (epoch === this.epoch) {
          this.updating = false;
          this.publish();
          this.timer = setTimeout(() => void this.refresh(), this.interval);
          this.timer.unref?.();
        }
      }
    })();
    const entry = { epoch, promise };
    this.pending = entry;
    try {
      await promise;
    } finally {
      if (this.pending === entry) this.pending = undefined;
    }
  }
  private intent(): Intent | undefined {
    const pr = this.data?.rows[0];
    return pr && this.data
      ? { pr, accountId: this.data.accountId, count: this.data.totalCount }
      : undefined;
  }
  private render(b: Binding): void {
    if (!this.current(b)) return;
    const intent = b.busy ? b.intent : this.intent();
    const context = intent ? signature(intent) : undefined;
    if (b.resultFor && b.resultFor !== context) {
      b.resultFor = undefined;
      b.result = undefined;
      b.message = undefined;
      b.error = undefined;
    }
    const applicable = b.resultFor === context;
    const phase = b.busy
      ? "起動中・お待ちください"
      : this.error
        ? "取得失敗"
        : this.data?.incomplete
          ? "一部取得・起動不可"
          : this.updating
            ? "更新中"
            : b.error
              ? "起動失敗・設定で確認"
              : applicable && b.result?.status === "unknown"
                ? "結果不明・設定で確認"
                : applicable && b.result?.status === "opened"
                  ? "WSを開きました"
                  : applicable && b.result?.status === "accepted"
                    ? "起動受付済み"
                    : !intent
                      ? "レビュー依頼なし"
                      : "押:AI起動/WS";
    const version = ++b.version;
    b.shown = undefined;
    const image = oldestReviewImage({
      count: b.busy ? b.intent?.count : this.data?.totalCount,
      incomplete: this.data?.incomplete,
      pr: intent?.pr,
      phase,
      handoff: b.settings.handoff,
      agent: b.settings.agent,
      error: !!this.error || !!b.error || this.data?.incomplete,
    });
    const pending = (this.queues.get(b.key.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!this.current(b) || b.version !== version) return;
        await b.key.setImage(image);
        if (
          this.current(b) &&
          b.version === version &&
          !b.busy &&
          !this.updating &&
          !this.error &&
          !this.data?.incomplete &&
          intent
        )
          b.shown = { ...intent, pr: { ...intent.pr } };
      })
      .catch(() => {
        if (this.current(b) && b.version === version) {
          b.shown = undefined;
          b.error =
            "ボタン画像の送信を確認できません。更新して押し直してください。";
        }
      });
    this.queues.set(b.key.id, pending);
  }
  async press(id: string): Promise<void> {
    const b = this.bindings.get(id);
    if (!b || b.busy || !this.current(b)) return;
    const shown = b.shown;
    if (!shown) {
      await b.key.showAlert().catch(() => {});
      await this.refresh(id);
      return;
    }
    b.busy = true;
    b.intent = shown;
    b.error = undefined;
    b.message = undefined;
    b.result = undefined;
    b.resultFor = signature(shown);
    this.render(b);
    const current = () =>
      this.current(b) &&
      b.intent === shown &&
      !this.error &&
      !this.data?.incomplete &&
      !!this.intent() &&
      signature(this.intent() as Intent) === signature(shown);
    try {
      await this.refresh(id);
      if (!current()) {
        if (this.current(b)) {
          b.message =
            "レビュー依頼または取得状態が変わりました。新しい表示を確認して押し直してください。";
          await b.key.showAlert().catch(() => {});
        }
        return;
      }
      const result = await this.launcher.launch(
        shown.pr,
        shown.accountId,
        b.settings,
        current,
        "asc",
      );
      if (this.current(b)) {
        b.result = result;
        b.message = `${shown.pr.repo} #${shown.pr.number}: ${result.message}`;
        if (result.status === "accepted" || result.status === "opened")
          await b.key.showOk?.().catch(() => {});
        else await b.key.showAlert().catch(() => {});
      }
    } catch (error) {
      if (this.current(b)) {
        b.error =
          error instanceof Error ? error.message : "起動結果を確認できません。";
        b.message = `${shown.pr.repo} #${shown.pr.number}: ${b.error}`;
        await b.key.showAlert().catch(() => {});
      }
    } finally {
      b.busy = false;
      b.intent = undefined;
      this.render(b);
    }
  }
  async forget(
    id: string,
    expected: string,
    accountId: number,
    operationId: string,
  ): Promise<void> {
    const b = this.bindings.get(id),
      shown = b?.shown;
    if (
      !b ||
      !shown ||
      b.busy ||
      this.updating ||
      this.error ||
      this.data?.incomplete ||
      prKey(shown.pr) !== expected ||
      shown.accountId !== accountId
    )
      throw new Error("表示中のPRが変わりました。更新して確認してください。");
    await this.launcher.forget(accountId, shown.pr, operationId);
    if (this.current(b)) {
      b.result = undefined;
      b.error = undefined;
      b.message = `${shown.pr.repo} #${shown.pr.number}: 起動記録を解除しました。`;
      this.render(b);
    }
  }
  view(id: string) {
    const b = this.bindings.get(id);
    if (!b) return {};
    return {
      settings: b.settings,
      selected: b.busy ? b.intent?.pr : b.shown?.pr,
      candidate: b.busy ? b.intent?.pr : this.intent()?.pr,
      count: this.data?.totalCount,
      partial: this.data?.incomplete,
      account: this.data?.account,
      accountId: this.data?.accountId,
      updating: this.updating,
      busy: b.busy,
      at: this.at,
      error: b.error ?? this.error,
      message: b.message,
      record: b.result?.record,
    };
  }
}
