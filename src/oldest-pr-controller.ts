import type { GitHubReviews, ReviewList, ReviewPR } from "./github/reviews";
import { prKey } from "./github/reviews";
import {
  type KeyIcon,
  keyColors,
  keyFrame,
  keyHeader,
  keyPRSignature,
  keyPRText,
  keyText,
} from "./key-layout";
import type {
  ReviewLauncher,
  ReviewLaunchResult,
  ReviewRecord,
} from "./orca/review-launcher";
import { reviewRecordFingerprint } from "./orca/review-launcher";
import {
  normalizeOldestReviewSettings,
  type ReviewSettings,
} from "./pr-review-settings";
import type { WorkspaceKey } from "./workspace-buttons";

type Key = WorkspaceKey & { device?: { id: string; isConnected?: boolean } };
type Intent = {
  pr: ReviewPR;
  accountId: number;
  count: number;
  recordState?: string;
  recordStatus?: ReviewRecord["status"];
};
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
  displayError?: string;
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
  recordStatus?: ReviewRecord["status"] | "unavailable";
}): string {
  const label =
    data.incomplete || data.count === undefined
      ? "—"
      : data.count > 999
        ? "999+"
        : String(data.count);
  const accepted =
    data.recordStatus === "accepted" ||
    /起動受付済み|WSを開きました/u.test(data.phase);
  const unknown =
    (data.recordStatus && data.recordStatus !== "accepted") ||
    /結果不明/u.test(data.phase);
  const mode =
    accepted ||
    unknown ||
    data.incomplete ||
    data.error ||
    /表示重複|要照合|番号/u.test(data.phase) ||
    /更新中/u.test(data.phase) ||
    !data.pr
      ? undefined
      : data.handoff === "send"
        ? ("送信" as const)
        : data.handoff === "draft"
          ? ("入力" as const)
          : undefined;
  const [heading, icon]: [string, KeyIcon] = /表示重複|要照合|番号/u.test(
    data.phase,
  )
    ? ["要照合", "warning"]
    : data.incomplete
      ? ["未確定", "warning"]
      : data.recordStatus === "unavailable"
        ? ["取得失敗", "warning"]
        : unknown
          ? ["不明", "question"]
          : /失敗/u.test(data.phase)
            ? [data.pr ? "失敗" : "取得失敗", "warning"]
            : /WSを開きました/u.test(data.phase)
              ? ["移動", "folder"]
              : accepted
                ? /起動中/u.test(data.phase)
                  ? ["移動", "spinner"]
                  : ["受付", "check"]
                : /起動中/u.test(data.phase)
                  ? ["処理", "spinner"]
                  : /更新中/u.test(data.phase)
                    ? ["更新", "spinner"]
                    : ["", "pr"];
  const color = data.error || unknown ? keyColors.error : keyColors.reviewQueue;
  const pr = data.pr ? keyPRText(data.pr) : undefined;
  return keyFrame(
    color,
    keyHeader(heading, icon, mode) +
      keyText(label, 72, 68, label.length > 3 ? 44 : 50, true) +
      (pr
        ? keyText(pr.owner, 72, 92) +
          keyText(pr.repo, 72, 114) +
          keyText(pr.fits ? pr.number : "番号要照合", 72, 136)
        : keyText(
            data.count === 0 && !data.incomplete
              ? "依頼なし"
              : data.incomplete
                ? "一部取得"
                : "未取得",
            72,
            110,
            24,
          )),
  );
}
/** One personal queue. A rendered target must survive a fresh oldest-first lookup. */
export class OldestPRController {
  private readonly bindings = new Map<string, Binding>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly lastDisplays = new Map<
    string,
    { signature: string; projection: string }
  >();
  private data?: ReviewList;
  private error?: string;
  private journal?: { target: string; record?: ReviewRecord; error?: string };
  private updating = false;
  private at?: number;
  private epoch = 0;
  private pending?: { epoch: number; promise: Promise<void> };
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly github: Pick<GitHubReviews, "list">,
    private readonly launcher: Pick<ReviewLauncher, "launch" | "forget">,
    private readonly interval = 30000,
    private readonly readRecord: (
      accountId: number,
      pr: ReviewPR,
    ) => Promise<ReviewRecord | undefined> = async () => undefined,
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
      this.journal = undefined;
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
        const intent = this.intent();
        this.journal = undefined;
        if (intent) {
          let record: ReviewRecord | undefined, error: string | undefined;
          try {
            record = await this.readRecord(intent.accountId, intent.pr);
          } catch (e) {
            error =
              e instanceof Error ? e.message : "起動記録を取得できません。";
          }
          if (epoch !== this.epoch) return;
          this.journal = { target: signature(intent), record, error };
        }
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
      ? {
          pr,
          accountId: this.data.accountId,
          count: this.data.totalCount,
          recordStatus:
            this.journal?.target === `${this.data.accountId}:${prKey(pr)}`
              ? this.journal.record?.status
              : undefined,
          recordState:
            this.journal?.target === `${this.data.accountId}:${prKey(pr)}`
              ? reviewRecordFingerprint(this.journal.record)
              : undefined,
        }
      : undefined;
  }
  private displayIssue(b: Binding, intent?: Intent): string | undefined {
    if (!intent) return;
    if (!keyPRText(intent.pr).fits)
      return "PR番号を液晶に完全表示できません。設定画面の完全な参照を確認してください。";
    const projection = keyPRSignature(intent.pr);
    if (
      this.data?.rows.some(
        (pr) =>
          prKey(pr) !== prKey(intent.pr) && keyPRSignature(pr) === projection,
      )
    )
      return "液晶のPR表示が重複しています。設定画面で完全な参照を確認してください。";
    const previous = this.lastDisplays.get(b.key.id);
    if (
      previous &&
      previous.signature !== signature(intent) &&
      previous.projection === projection
    )
      return "前のPRと同じ短縮表示になりました。設定画面で完全な参照を照合してください。";
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
    const version = ++b.version;
    b.shown = undefined;
    const pending = (this.queues.get(b.key.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!this.current(b) || b.version !== version) return;
        b.displayError = this.displayIssue(b, intent);
        const applicable = b.resultFor === context;
        const phase = b.displayError
          ? "表示重複・要照合"
          : b.busy
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
        const image = oldestReviewImage({
          count: b.busy ? b.intent?.count : this.data?.totalCount,
          incomplete: this.data?.incomplete,
          pr: intent?.pr,
          phase,
          handoff: b.settings.handoff,
          agent: b.settings.agent,
          recordStatus: b.busy
            ? intent?.recordStatus
            : this.journal?.error
              ? "unavailable"
              : intent?.recordStatus,
          error:
            !!this.error ||
            !!this.journal?.error ||
            !!b.error ||
            !!b.displayError ||
            this.data?.incomplete,
        });
        const deliveredIssue = b.displayError;
        // Even a rejected/obsolete write may reach the device. Reserve its projection before sending.
        if (intent && !deliveredIssue)
          this.lastDisplays.set(b.key.id, {
            signature: signature(intent),
            projection: keyPRSignature(intent.pr),
          });
        await b.key.setImage(image);
        if (
          this.current(b) &&
          b.version === version &&
          !b.busy &&
          !this.updating &&
          !this.error &&
          !this.journal?.error &&
          !b.displayError &&
          !this.data?.incomplete &&
          intent
        ) {
          b.shown = { ...intent, pr: { ...intent.pr } };
        }
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
      !this.journal?.error &&
      this.intent()?.recordState === shown.recordState &&
      !this.displayIssue(b, shown) &&
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
      if (this.journal?.record && this.journal.record.status !== "accepted") {
        b.result = {
          status: "unknown",
          message: this.journal.record.message,
          record: this.journal.record,
        };
        await b.key.showAlert().catch(() => {});
        return;
      }
      const result = await this.launcher.launch(
        shown.pr,
        shown.accountId,
        b.settings,
        current,
        "asc",
        shown.recordState,
      );
      if (this.current(b)) {
        b.result = result;
        if (result.record)
          this.journal = { target: signature(shown), record: result.record };
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
      await this.refresh(id);
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
      error: b.displayError ?? b.error ?? this.journal?.error ?? this.error,
      message: b.message,
      record: b.result?.record ?? this.journal?.record,
    };
  }
}
