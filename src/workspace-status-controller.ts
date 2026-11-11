import type { OrcaClient } from "./orca/client";
import {
  getWorkspaceStatus,
  type OrcaSnapshot,
  type OrcaWorkspace,
} from "./orca/model";
import type { WorkspaceMonitor } from "./orca/monitor";
import {
  allReferences,
  referenceSet,
  type SavedReference,
  type WorkspaceReferences,
} from "./orca/workspace-references";
import type { PluginSettings } from "./plugin-settings";
import { WorkspaceButtons, type WorkspaceKey } from "./workspace-buttons";
import {
  WorkspaceGesture,
  type WorkspaceGestureKind,
} from "./workspace-gesture";
import { workspaceIdentity } from "./workspace-identity";
import { normalizeControlId } from "./workspace-selections";

export type ButtonWorkspace = {
  workspaceId: string;
  workspaceName: string;
  instanceId?: string;
  hostId?: string;
};
export type WorkspaceButtonSettings = {
  workspaceButtonVersion?: number;
  workspace?: ButtonWorkspace;
  reference?: SavedReference;
  controlId?: string;
};
type Key = WorkspaceKey & {
  device?: { id: string; isConnected?: boolean };
  getSettings(): Promise<WorkspaceButtonSettings>;
  setSettings(settings: WorkspaceButtonSettings): Promise<void>;
};
type LinkResult = {
  workspaceId: string;
  workspaceName: string;
  requested: string[];
  unconfirmed: { url: string; reason: string }[];
  notRequested: string[];
  cancelled: boolean;
  inProgress: boolean;
  total: number;
};
type Binding = {
  key: Key;
  settings: WorkspaceButtonSettings;
  gesture: WorkspaceGesture;
  ready: boolean;
  initializing?: boolean;
  retryInitialization?: boolean;
  runtimeId?: string;
  monitorFailed?: boolean;
  stop?: () => void;
  pending?: WorkspaceButtonSettings;
  feedbackTimer?: ReturnType<typeof setTimeout>;
  error?: string;
  notice?: string;
  operating?: WorkspaceGestureKind | "unassign";
  unassigning?: Promise<void>;
  pressReady?: boolean;
  linkResult?: LinkResult;
};
type Client = Pick<
  OrcaClient,
  "selectedWorkspace" | "snapshot" | "references" | "focusWorkspace"
>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const targetFields = (s: WorkspaceButtonSettings) => [
  s.workspaceButtonVersion,
  s.workspace,
  s.reference,
];
const savedWorkspace = (value: unknown): value is ButtonWorkspace =>
  !!value &&
  typeof value === "object" &&
  "workspaceId" in value &&
  typeof value.workspaceId === "string" &&
  !!value.workspaceId &&
  "workspaceName" in value &&
  typeof value.workspaceName === "string";
const workspaceMissing = (
  assignment: ButtonWorkspace,
  snapshot: OrcaSnapshot | null,
): boolean => {
  const hostId = assignment.hostId ?? "local";
  if (
    snapshot?.truncated !== false ||
    snapshot.omittedHosts !== false ||
    !snapshot.hostIds?.includes(hostId)
  )
    return false;
  const rows = snapshot.workspaces.filter(
    (row) => row.id === assignment.workspaceId,
  );
  if (!rows.length) return true;
  const row = rows[0];
  return (
    rows.length === 1 &&
    row?.hostId === hostId &&
    !!assignment.instanceId &&
    !!row.instanceId &&
    row.instanceId !== assignment.instanceId
  );
};

export class WorkspaceStatusController {
  private readonly bindings = new Map<string, Binding>();
  private readonly buttons: WorkspaceButtons;
  private navigationVersion = 0;
  private readonly saves = new Map<string, Promise<void>>();
  constructor(
    private readonly monitor: WorkspaceMonitor,
    private readonly client: Client,
    private readonly readGlobal: () => Promise<PluginSettings>,
    private readonly openUrl: (url: string) => Promise<void>,
    private readonly report: (id: string, message: string) => void,
    private readonly beginNavigation: () => () => boolean = () => {
      const revision = ++this.navigationVersion;
      return () => revision === this.navigationVersion;
    },
  ) {
    this.buttons = new WorkspaceButtons(monitor, client, report);
  }

  async bind(key: Key, settings: WorkspaceButtonSettings): Promise<void> {
    const previous = this.bindings.get(key.id);
    if (
      previous &&
      (same(previous.pending, settings) || same(previous.settings, settings))
    )
      return;
    this.unbind(key.id);
    const b: Binding = {
      key,
      settings: structuredClone(settings),
      ready: false,
      gesture: new WorkspaceGesture(
        (kind, current) => this.execute(b, kind, current),
        (message) => this.feedback(b, message),
      ),
    };
    this.bindings.set(key.id, b);
    this.draw(b);
    b.stop = this.monitor.subscribe((state) => {
      if (state.error) {
        b.gesture.cancel();
        b.monitorFailed = true;
        this.feedback(b, "取得失敗");
        return;
      }
      if (!state.snapshot) return;
      // 再起動後も保存済み割当を使う。環境変更の警告は中止した操作にだけ出す。
      if (b.runtimeId && b.runtimeId !== state.snapshot.runtimeId) {
        const interrupted = b.gesture.cancel();
        if (interrupted) this.feedback(b, "環境変更・再操作", true);
        else if (b.monitorFailed) this.feedback(b);
      } else if (b.monitorFailed) this.feedback(b);
      b.monitorFailed = false;
      b.runtimeId = state.snapshot.runtimeId;
      if (b.retryInitialization && !state.fromCache) void this.initialize(b);
      void this.unassignMissing(b);
    });
    await this.initialize(b);
  }
  private async initialize(b: Binding): Promise<void> {
    if (!this.current(b) || b.initializing) return;
    b.initializing = true;
    b.retryInitialization = false;
    const settings = b.settings;
    try {
      if (settings.workspaceButtonVersion !== 1) {
        const legacyId =
          typeof settings.controlId === "string" && settings.controlId.trim()
            ? normalizeControlId(settings.controlId)
            : undefined;
        let legacy: unknown;
        if (legacyId) {
          try {
            legacy = (await this.readGlobal()).workspaceSelections?.[legacyId];
          } catch (error) {
            // 未保存の読込失敗だけを再試行し、保存結果不明は自動再試行しない。
            b.retryInitialization = true;
            throw error;
          }
        }
        if (!this.current(b)) return;
        const next = { ...settings, workspaceButtonVersion: 1 };
        delete next.controlId;
        if (!savedWorkspace(next.workspace) && savedWorkspace(legacy))
          next.workspace = { ...legacy };
        await this.save(b, next, () => this.current(b));
      }
      if (this.current(b)) b.ready = true;
    } catch (error) {
      this.fail(b, error, "保存失敗");
    } finally {
      b.initializing = false;
      void this.unassignMissing(b);
    }
  }
  private unassignMissing(b: Binding): Promise<void> {
    if (b.unassigning) return b.unassigning;
    const assignment = b.settings.workspace;
    const state = this.monitor.state;
    if (
      !this.current(b) ||
      !b.ready ||
      b.initializing ||
      b.operating === "long" ||
      !savedWorkspace(assignment) ||
      state.error ||
      state.fromCache ||
      !workspaceMissing(assignment, state.snapshot)
    )
      return Promise.resolve();
    // 削除された対象への保留操作を中止する。別WSの長押し登録は優先する。
    b.gesture.cancel();
    if (b.operating) return Promise.resolve();
    b.operating = "unassign";
    this.feedback(b, "割当を解除中");
    const runtimeId = state.snapshot?.runtimeId;
    let verified = true;
    const current = () => {
      const latest = this.monitor.state;
      return (
        verified &&
        this.current(b) &&
        same(b.settings.workspace, assignment) &&
        !latest.error &&
        !latest.fromCache &&
        latest.snapshot?.runtimeId === runtimeId &&
        workspaceMissing(assignment, latest.snapshot)
      );
    };
    const next = { ...b.settings };
    delete next.workspace;
    delete next.reference;
    const pending = this.save(b, next, current, async () => {
      // 保存直前にも一覧を再取得し、一時的な欠落だけで割当を消さない。
      const check = await this.client.snapshot();
      verified =
        check.runtimeId === runtimeId && workspaceMissing(assignment, check);
    })
      .then(() => {
        if (!this.current(b)) return;
        if (!b.settings.workspace) {
          b.notice = undefined;
          b.pressReady = false;
          this.feedback(b);
        } else if (!b.monitorFailed) {
          this.feedback(b);
        }
      })
      .catch((error: unknown) => this.fail(b, error, "保存失敗"))
      .finally(() => {
        b.operating = undefined;
        b.unassigning = undefined;
      });
    b.unassigning = pending;
    return pending;
  }
  unbind(id: string): void {
    const b = this.bindings.get(id);
    this.bindings.delete(id);
    b?.gesture.cancel();
    b?.stop?.();
    clearTimeout(b?.feedbackTimer);
    this.buttons.unbind(id);
  }
  disconnect(deviceId: string): void {
    for (const [id, b] of this.bindings)
      if (b.key.device?.id === deviceId) this.unbind(id);
  }
  down(id: string): void {
    const b = this.bindings.get(id);
    if (!b?.ready || b.key.device?.isConnected === false || b.operating) return;
    try {
      this.buttons.assertReady(id);
      b.pressReady = true;
    } catch {
      b.pressReady = false;
    }
    b.gesture.down();
  }
  up(id: string): void {
    this.bindings.get(id)?.gesture.up();
  }
  private current(b: Binding): boolean {
    return (
      this.bindings.get(b.key.id) === b && b.key.device?.isConnected !== false
    );
  }
  private draw(b: Binding): void {
    this.buttons.bind(
      b.key,
      savedWorkspace(b.settings.workspace) ? b.settings.workspace : {},
    );
  }
  private feedback(b: Binding, message?: string, temporary = false): void {
    if (!this.current(b)) return;
    clearTimeout(b.feedbackTimer);
    this.buttons.feedback(b.key.id, message);
    if (temporary) {
      b.feedbackTimer = setTimeout(() => this.feedback(b), 1800);
      b.feedbackTimer.unref?.();
    }
  }
  private fail(b: Binding, error: unknown, category = "取得失敗"): void {
    if (!this.current(b)) return;
    const message =
      error instanceof Error ? error.message : "Orca の情報を取得できません。";
    b.error = message;
    this.report(b.key.id, message);
    this.feedback(
      b,
      /未割当/u.test(message)
        ? "長押しで登録"
        : (/保存結果不明|関連先なし|選択先消失|関連先が複数/u.exec(
            message,
          )?.[0] ?? category),
    );
    void b.key.showAlert();
  }
  private save(
    b: Binding,
    next: WorkspaceButtonSettings,
    current: () => boolean,
    validate?: () => Promise<void>,
  ): Promise<void> {
    const previous = this.saves.get(b.key.id) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => this.performSave(b, next, current, validate));
    this.saves.set(b.key.id, pending);
    const cleanup = () => {
      if (this.saves.get(b.key.id) === pending) this.saves.delete(b.key.id);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }
  private async performSave(
    b: Binding,
    next: WorkspaceButtonSettings,
    current: () => boolean,
    validate?: () => Promise<void>,
  ): Promise<void> {
    if (!current()) return;
    const latest = await b.key.getSettings();
    if (!current()) return;
    if (!same(targetFields(latest), targetFields(b.settings)))
      throw new Error("ボタン設定が変わりました。もう一度操作してください。");
    // Only owned fields are patched; unrelated fields always come from the last read.
    const value = {
      ...latest,
      workspaceButtonVersion: next.workspaceButtonVersion,
      workspace: next.workspace,
      reference: next.reference,
    };
    delete value.controlId;
    if (!next.workspace) delete value.workspace;
    if (!next.reference) delete value.reference;
    if (validate) await validate();
    if (!current()) return;
    b.pending = value;
    let wrote = false;
    try {
      await b.key.setSettings(value);
      wrote = true;
      const confirmed = await b.key.getSettings();
      if (!same(targetFields(confirmed), targetFields(value))) {
        // A concurrent explicit settings update wins; never roll it back.
        wrote = false;
        throw new Error(
          "割当の保存を確認できません。設定を更新して確認してください。",
        );
      }
      if (!current()) throw new Error("登録操作を中止しました。");
      if (!same(b.settings.workspace, confirmed.workspace))
        b.linkResult = undefined;
      b.settings = confirmed;
      b.error = undefined;
      this.draw(b);
    } catch (error) {
      if (wrote) {
        // A sent write is not success. Restore and read back the previous assignment.
        b.pending = latest;
        try {
          await b.key.setSettings(latest);
          const restored = await b.key.getSettings();
          if (!same(targetFields(restored), targetFields(latest)))
            throw new Error();
        } catch {
          b.ready = false;
          throw new Error(
            "保存結果不明：元の割当の復元を確認できません。設定画面を開き直してください。",
          );
        }
      }
      throw error;
    } finally {
      b.pending = undefined;
    }
  }
  private async execute(
    b: Binding,
    kind: WorkspaceGestureKind,
    gestureCurrent: () => boolean,
  ): Promise<void> {
    if (b.operating) return;
    b.operating = kind;
    b.notice = undefined;
    if (kind === "double") {
      b.linkResult = undefined;
      b.error = undefined;
    }
    const navigationCurrent =
      kind === "long" ? () => true : this.beginNavigation();
    let runtimeId = b.runtimeId;
    const current = () =>
      this.current(b) &&
      gestureCurrent() &&
      navigationCurrent() &&
      !this.monitor.state.error &&
      (!runtimeId ||
        !this.monitor.state.snapshot ||
        this.monitor.state.snapshot.runtimeId === runtimeId);
    try {
      if (!current()) return;
      if (kind === "long") {
        this.feedback(b, "選択WSを取得中");
        const selected = await this.client.selectedWorkspace();
        if (!current()) return;
        if (runtimeId && selected.runtimeId !== runtimeId)
          throw new Error(
            "Orca の実行環境が変わりました。元の割当を維持します。",
          );
        runtimeId = selected.runtimeId;
        if (!current()) return;
        const next = {
          ...b.settings,
          workspaceButtonVersion: 1,
          workspace: {
            workspaceId: selected.workspace.id,
            workspaceName: selected.workspace.name,
            instanceId: selected.workspace.instanceId,
            hostId: selected.workspace.hostId,
          },
        };
        delete next.reference;
        this.feedback(b, "登録を保存中");
        await this.save(b, next, current, async () => {
          const check = await this.client.selectedWorkspace();
          if (
            check.runtimeId !== selected.runtimeId ||
            check.workspace.id !== selected.workspace.id ||
            check.workspace.instanceId !== selected.workspace.instanceId ||
            check.workspace.hostId !== selected.workspace.hostId
          )
            throw new Error(
              "選択WSまたは実行環境が変わりました。元の割当を維持します。",
            );
        });
        if (current()) {
          this.feedback(b, "登録完了", true);
          await b.key.showOk?.();
        }
        return;
      }
      if (!b.pressReady)
        throw new Error(
          b.settings.workspace
            ? "押した時点のキー表示を確認できません。表示後に押し直してください。"
            : "未割当：長押しで登録してください。",
        );
      this.buttons.assertReady(b.key.id);
      const assignment = b.settings.workspace;
      if (!savedWorkspace(assignment))
        throw new Error("未割当：長押しで登録してください。");
      this.feedback(b, kind === "short" ? "移動中" : "関連先を取得中");
      const snapshot = await this.client.snapshot();
      if (!current()) return;
      if (runtimeId && runtimeId !== snapshot.runtimeId)
        throw new Error("Orca の実行環境が変わりました。");
      runtimeId = snapshot.runtimeId;
      if (!current()) return;
      const workspace = this.checkWorkspace(assignment, snapshot.workspaces);
      if (kind === "short") {
        await this.client.focusWorkspace(
          assignment.workspaceId,
          current,
          undefined,
          snapshot.runtimeId,
          assignment.instanceId,
        );
        if (current()) {
          b.error = undefined;
          this.feedback(b);
        }
      } else {
        const data = await this.client.references(
          assignment.workspaceId,
          snapshot.runtimeId,
        );
        if (!current()) return;
        this.checkReferences(data, workspace);
        const refs = allReferences(data);
        if (!refs.length)
          throw new Error(
            "関連先なし：このWSにGitHubのPR / Issueがありません。",
          );
        const finalData = await this.client.references(
          assignment.workspaceId,
          snapshot.runtimeId,
        );
        if (!current()) return;
        this.checkReferences(finalData, workspace);
        if (referenceSet(allReferences(finalData)) !== referenceSet(refs))
          throw new Error(
            "関連先が変わりました。更新後にもう一度操作してください。",
          );
        // Validate the WS after the last reference response, including a recreated instance.
        const check = await this.client.snapshot();
        if (!current()) return;
        if (check.runtimeId !== snapshot.runtimeId)
          throw new Error("Orca の実行環境が変わりました。");
        this.checkReferences(
          finalData,
          this.checkWorkspace(assignment, check.workspaces),
        );
        const result: LinkResult = {
          workspaceId: assignment.workspaceId,
          workspaceName: assignment.workspaceName,
          requested: [],
          unconfirmed: [],
          notRequested: [],
          cancelled: false,
          inProgress: true,
          total: refs.length,
        };
        b.linkResult = result;
        this.feedback(b, "関連先を送信中");
        for (const [index, ref] of refs.entries()) {
          if (!current()) {
            result.notRequested = refs.slice(index).map((row) => row.url);
            break;
          }
          try {
            await this.openUrl(ref.url);
            result.requested.push(ref.url);
          } catch (error) {
            result.unconfirmed.push({
              url: ref.url,
              reason:
                error instanceof Error
                  ? error.message
                  : "起動要求の結果を確認できません。",
            });
          }
        }
        result.inProgress = false;
        result.cancelled = !current();
        if (this.current(b)) {
          b.notice = `${assignment.workspaceName}：関連先${refs.length}件中${result.requested.length}件の起動要求をブラウザーへ送信しました。`;
          if (result.unconfirmed.length || result.cancelled) {
            b.error = [
              b.notice,
              result.unconfirmed.length
                ? `${result.unconfirmed.length}件は要求の結果を確認できません。自動再送はしません。`
                : "",
              result.cancelled
                ? `操作を中止しました。${result.notRequested.length}件は未送信です。送信済みの要求は取り消していません。`
                : "",
            ]
              .filter(Boolean)
              .join(" ");
            this.report(b.key.id, b.error);
            this.feedback(
              b,
              result.unconfirmed.length ? "リンク結果不明" : "リンク送信中止",
            );
            await b.key.showAlert().catch(() => {});
          } else {
            b.error = undefined;
            if (current()) this.feedback(b, "関連先を開いた", true);
          }
        }
      }
    } catch (error) {
      if (current())
        this.fail(b, error, kind === "long" ? "登録失敗" : "取得失敗");
    } finally {
      b.operating = undefined;
      void this.unassignMissing(b);
    }
  }
  private checkReferences(
    data: WorkspaceReferences,
    workspace: OrcaWorkspace,
  ): void {
    if (
      data.workspaceId !== workspace.id ||
      (workspace.instanceId && data.instanceId !== workspace.instanceId) ||
      (workspace.hostId && data.hostId !== workspace.hostId)
    )
      throw new Error("関連先の対象WS・実体・実行ホストを確認できません。");
  }
  private checkWorkspace(
    assignment: ButtonWorkspace,
    rows: OrcaWorkspace[],
  ): OrcaWorkspace {
    const found = rows.filter((row) => row.id === assignment.workspaceId);
    const ws = found[0];
    if (
      found.length !== 1 ||
      !ws ||
      (assignment.instanceId && ws.instanceId !== assignment.instanceId) ||
      (assignment.hostId && ws.hostId !== assignment.hostId)
    )
      throw new Error(
        "割当先WSが消失または再作成されました。長押しで登録し直してください。",
      );
    return ws;
  }
  async view(id: string) {
    const b = this.bindings.get(id);
    if (!b) return undefined;
    const state = await this.monitor.refresh();
    await this.unassignMissing(b);
    if (!this.current(b)) return undefined;
    const assignment = b.settings.workspace;
    const revision = JSON.stringify(targetFields(b.settings));
    const ws = state.snapshot?.workspaces.find(
      (row) => row.id === assignment?.workspaceId,
    );
    const base = () => ({
      revision,
      notice: b.notice,
      linkResult: b.linkResult,
      workspaceName: ws?.name ?? assignment?.workspaceName ?? "未割当",
      workspace: assignment,
      workspaceIdentity: workspaceIdentity(
        assignment?.workspaceId,
        ws,
        state.snapshot?.workspaces,
      ),
      status: assignment ? getWorkspaceStatus(ws) : "unassigned",
      error: b.error ?? state.error,
      settings: b.settings,
      ready: b.ready && !b.operating,
    });
    if (!assignment || !state.snapshot || state.error)
      return { ...base(), references: [] };
    try {
      this.checkWorkspace(assignment, state.snapshot.workspaces);
      const data = await this.client.references(
        assignment.workspaceId,
        state.snapshot.runtimeId,
      );
      if (
        !this.current(b) ||
        revision !== JSON.stringify(targetFields(b.settings))
      )
        return undefined;
      const latest = this.monitor.state;
      if (
        latest.error ||
        !latest.snapshot ||
        latest.snapshot.runtimeId !== state.snapshot.runtimeId
      )
        return {
          ...base(),
          ready: false,
          status: "unknown",
          references: [],
          error:
            latest.error ??
            "Orcaの実行環境が変わりました。関連先を更新してください。",
        };
      this.checkReferences(
        data,
        this.checkWorkspace(assignment, latest.snapshot.workspaces),
      );
      const references = allReferences(data);
      return {
        ...base(),
        references,
        linkError: references.length
          ? undefined
          : "関連先なし：このWSにGitHubのPR / Issueがありません。",
      };
    } catch (error) {
      if (
        !this.current(b) ||
        revision !== JSON.stringify(targetFields(b.settings))
      )
        return undefined;
      return { ...base(), references: [], linkError: (error as Error).message };
    }
  }
}
