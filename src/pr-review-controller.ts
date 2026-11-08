import {
  type GitHubReviews,
  prKey,
  type ReviewList,
  type ReviewMode,
  type ReviewPR,
} from "./github/reviews";
import { shorten, twoLines } from "./key-text";
import type {
  ReviewLauncher,
  ReviewLaunchResult,
} from "./orca/review-launcher";
import {
  normalizeReviewSettings,
  type ReviewSettings,
} from "./pr-review-settings";
import { workspaceTag } from "./workspace-identity";
export type ReviewDial = {
  id: string;
  setFeedback: (data: Record<string, string>) => Promise<void>;
  showAlert: () => Promise<void>;
};
type Feed = {
  mode: ReviewMode;
  data?: ReviewList;
  error?: string;
  updating: boolean;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  at?: number;
  bindings: Set<Binding>;
};
type Binding = {
  dial: ReviewDial;
  settings: ReturnType<typeof normalizeReviewSettings>;
  feed: Feed;
  selectedKey?: string;
  shown?: { pr: ReviewPR; accountId: number };
  version: number;
  busy: boolean;
  message?: string;
  result?: ReviewLaunchResult;
  resultFor?: string;
  error?: string;
};
export class PRReviewController {
  private readonly bindings = new Map<string, Binding>();
  private readonly feeds = new Map<ReviewMode, Feed>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(
    private readonly github: Pick<GitHubReviews, "list">,
    private readonly launcher: Pick<ReviewLauncher, "launch" | "forget">,
    private readonly interval = 30_000,
  ) {}
  bind(dial: ReviewDial, raw: ReviewSettings): void {
    this.unbind(dial.id);
    const settings = normalizeReviewSettings(raw);
    let feed = this.feeds.get(settings.reviewMode);
    if (!feed) {
      feed = {
        mode: settings.reviewMode,
        updating: false,
        bindings: new Set(),
      };
      this.feeds.set(settings.reviewMode, feed);
    }
    const b: Binding = { dial, settings, feed, version: 0, busy: false };
    this.bindings.set(dial.id, b);
    feed.bindings.add(b);
    this.render(b);
    if (!feed.at || Date.now() - feed.at > this.interval || feed.error)
      void this.update(feed);
    else this.schedule(feed);
  }
  unbind(id: string): void {
    const b = this.bindings.get(id);
    if (!b) return;
    this.bindings.delete(id);
    b.version++;
    b.shown = undefined;
    b.feed.bindings.delete(b);
    if (!b.feed.bindings.size) clearTimeout(b.feed.timer);
  }
  private schedule(f: Feed) {
    clearTimeout(f.timer);
    if (!f.bindings.size) return;
    f.timer = setTimeout(() => void this.update(f), this.interval);
    f.timer.unref();
  }
  private publish(f: Feed) {
    for (const b of f.bindings) this.render(b);
  }
  private async update(f: Feed): Promise<void> {
    if (f.pending) return f.pending;
    clearTimeout(f.timer);
    f.updating = true;
    this.publish(f);
    f.pending = (async () => {
      try {
        f.data = await this.github.list(f.mode);
        f.error = undefined;
        f.at = Date.now();
      } catch (error) {
        f.error =
          error instanceof Error ? error.message : "GitHubへ接続できません。";
        f.data = undefined;
      } finally {
        f.updating = false;
        f.pending = undefined;
        this.publish(f);
        this.schedule(f);
      }
    })();
    return f.pending;
  }
  private selected(b: Binding): ReviewPR | undefined {
    const rows = b.feed.data?.rows ?? [];
    return rows.find((p) => prKey(p) === b.selectedKey) ?? rows[0];
  }
  private render(b: Binding): void {
    if (this.bindings.get(b.dial.id) !== b) return;
    const f = b.feed,
      pr = this.selected(b),
      version = ++b.version;
    const context =
      pr && f.data ? `${f.data.accountId}:${prKey(pr)}` : undefined;
    if (b.resultFor && b.resultFor !== context) {
      b.result = undefined;
      b.message = undefined;
      b.error = undefined;
      b.resultFor = undefined;
    }
    b.shown = undefined;
    if (pr) b.selectedKey = prKey(pr);
    const rows = f.data?.rows ?? [],
      index = pr ? rows.indexOf(pr) + 1 : 0;
    const [title, title2] = twoLines(
      pr?.title ??
        (f.error
          ? "ghの認証・接続を確認"
          : f.updating
            ? "GitHubから取得しています"
            : "レビュー依頼はありません"),
      22,
    );
    const feedback = {
      status: b.busy
        ? "起動を準備中"
        : b.error
          ? "起動できません"
          : f.updating
            ? "更新中"
            : f.error
              ? "取得できません"
              : `${f.mode === "team" ? "チーム宛" : "個人宛"} ${index}/${rows.length}${f.data?.partial ? "+" : ""}`,
      repo: pr
        ? shorten(pr.repo, 28)
        : f.data
          ? `@${shorten(f.data.account, 24)}`
          : "GitHubレビュー",
      pr: pr ? `#${pr.number} · ${workspaceTag(pr.repo.toLowerCase())}` : "",
      title,
      title2,
      input: `${b.settings.agent === "claude" ? "Claude" : "Codex"} · ${b.settings.enter ? "入力＋Enter" : "入力のみ"}`,
      operation: b.busy
        ? "連打せずお待ちください"
        : b.result?.status === "unknown"
          ? "結果未確認・PIで確認"
          : b.error
            ? "詳細は設定画面へ"
            : b.result?.status === "cancelled"
              ? "起動を中止しました"
              : b.result
                ? "起動受付・押:WSを開く"
                : f.updating
                  ? "更新後に操作できます"
                  : pr
                    ? "押:起動/起動済WS　触:更新"
                    : "タップで更新",
    };
    const prior = this.queues.get(b.dial.id) ?? Promise.resolve();
    const pending = prior
      .catch(() => {})
      .then(async () => {
        if (this.bindings.get(b.dial.id) !== b || b.version !== version) return;
        await b.dial.setFeedback(feedback);
        if (
          this.bindings.get(b.dial.id) === b &&
          b.version === version &&
          pr &&
          f.data &&
          !f.error &&
          !f.updating &&
          !b.busy
        )
          b.shown = { pr: { ...pr }, accountId: f.data.accountId };
      })
      .catch(() => {
        b.shown = undefined;
      });
    this.queues.set(b.dial.id, pending);
  }
  rotate(id: string, ticks: number): void {
    const b = this.bindings.get(id),
      rows = b?.feed.data?.rows;
    if (
      !b ||
      b.busy ||
      b.feed.updating ||
      !rows?.length ||
      !Number.isFinite(ticks)
    )
      return;
    const index = rows.findIndex((p) => prKey(p) === b.selectedKey),
      step = Math.trunc(ticks) % rows.length;
    b.selectedKey = prKey(
      rows[
        (((Math.max(index, 0) + step) % rows.length) + rows.length) %
          rows.length
      ],
    );
    b.result = undefined;
    b.message = undefined;
    b.error = undefined;
    this.render(b);
  }
  async refresh(id: string): Promise<void> {
    const b = this.bindings.get(id);
    if (b && !b.busy) await this.update(b.feed);
  }
  async launch(id: string): Promise<void> {
    const b = this.bindings.get(id),
      shown = b?.shown;
    if (!b || b.busy || !shown) {
      if (b) await b.dial.showAlert();
      return;
    }
    const settings = { ...b.settings };
    const current = () =>
      this.bindings.get(id) === b &&
      b.selectedKey === prKey(shown.pr) &&
      b.feed.data?.accountId === shown.accountId &&
      !b.feed.error;
    b.busy = true;
    b.resultFor = `${shown.accountId}:${prKey(shown.pr)}`;
    b.error = undefined;
    b.message = undefined;
    this.render(b);
    try {
      const result = await this.launcher.launch(
        shown.pr,
        shown.accountId,
        settings,
        current,
      );
      if (current()) {
        b.result = result;
        b.message = `${shown.pr.repo} #${shown.pr.number}: ${result.message}`;
      }
      if (result.status === "unknown" || result.status === "cancelled")
        await b.dial.showAlert();
    } catch (error) {
      if (current()) {
        b.error =
          error instanceof Error
            ? error.message
            : "起動できません。Orcaで確認してください。";
        b.message = `${shown.pr.repo} #${shown.pr.number}: ${b.error}`;
      }
      await b.dial.showAlert();
    } finally {
      b.busy = false;
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
      pr = b && this.selected(b);
    if (
      !b ||
      b.busy ||
      b.feed.updating ||
      !b.feed.data ||
      !pr ||
      prKey(pr) !== expected ||
      b.feed.data.accountId !== accountId
    )
      throw new Error("表示中のPRが変わりました。更新して確認してください。");
    await this.launcher.forget(b.feed.data.accountId, pr, operationId);
    if (this.bindings.get(id) !== b || b.selectedKey !== expected) return;
    b.result = undefined;
    b.error = undefined;
    b.message = `${pr.repo} #${pr.number}: 起動記録を解除しました。次の押下で新しいAIを起動します。`;
    this.render(b);
  }
  view(id: string) {
    const b = this.bindings.get(id);
    if (!b) return {};
    return {
      settings: b.settings,
      selected: b.shown?.pr,
      candidate: this.selected(b),
      account: b.feed.data?.account,
      accountId: b.feed.data?.accountId,
      partial: b.feed.data?.partial,
      count: b.feed.data?.rows.length ?? 0,
      updating: b.feed.updating,
      at: b.feed.at,
      busy: b.busy,
      error: b.error ?? b.feed.error,
      message: b.message,
      record: b.result?.record,
    };
  }
}
