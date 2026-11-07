import streamDeck, { type DialAction } from "@elgato/streamdeck";
import { OrcaClient } from "./orca/client";
import { WorkspaceMonitor } from "./orca/monitor";
import { WorkspaceButtons, type WorkspaceKey } from "./workspace-buttons";
import {
  type ControlView,
  normalizeControlId,
  type SavedSelection,
  WorkspaceSelections,
} from "./workspace-selections";

export type ControlSettings = { controlId?: string };
type GlobalSettings = { workspaceSelections?: Record<string, SavedSelection> };
type Binding = {
  controlId: string;
  key?: WorkspaceKey;
  stop?: () => void;
  lastSelection?: string;
  renderVersion: number;
  queue: Promise<void>;
};
const labels = {
  working: "進行中",
  waiting: "入力待ち",
  review: "要確認",
  idle: "待機",
  unknown: "状態不明",
};

class WorkspaceService {
  private readonly client = new OrcaClient();
  private readonly monitor = new WorkspaceMonitor(this.client);
  private readonly buttons = new WorkspaceButtons(
    this.monitor,
    this.client,
    (id, message) => this.report(id, message),
  );
  private readonly selections = new WorkspaceSelections(
    this.monitor,
    (id, selection) => this.remember(id, selection),
  );
  private readonly bindings = new Map<string, Binding>();
  private readonly selectionUpdates = new Map<string, Promise<boolean>>();
  private navigationVersion = 0;
  private globalSettings: GlobalSettings = {};
  private settingsReady = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saves: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.globalSettings = await Promise.race([
        streamDeck.settings.getGlobalSettings<GlobalSettings>(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("選択の保存先を読み込めません。")),
            5_000,
          );
        }),
      ]);
      this.settingsReady = true;
      const saved = this.globalSettings.workspaceSelections;
      this.selections.hydrate(
        saved && typeof saved === "object" && !Array.isArray(saved)
          ? saved
          : {},
      );
    } catch (error) {
      streamDeck.logger.warn(error);
      this.selections.hydrate({});
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(id: string, selection: SavedSelection): void {
    if (!this.settingsReady) return;
    this.globalSettings = {
      ...this.globalSettings,
      workspaceSelections: {
        ...this.globalSettings.workspaceSelections,
        [id]: selection,
      },
    };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const value = this.globalSettings;
      this.saves = this.saves
        .catch(() => {})
        .then(() => streamDeck.settings.setGlobalSettings(value));
      void this.saves.catch((error: unknown) => streamDeck.logger.warn(error));
    }, 250);
    this.saveTimer.unref();
  }

  private report(actionId: string, message: string): void {
    streamDeck.logger.warn(message);
    if (streamDeck.ui.action?.id === actionId) {
      void streamDeck.ui
        .sendToPropertyInspector({ type: "error", actionId, message })
        .catch((error: unknown) => streamDeck.logger.error(error));
    }
  }

  bindKey(key: WorkspaceKey, controlId: string): void {
    this.unbind(key.id);
    const binding: Binding = {
      controlId: normalizeControlId(controlId),
      key,
      renderVersion: 0,
      queue: Promise.resolve(),
    };
    this.bindings.set(key.id, binding);
    binding.stop = this.selections.subscribe(binding.controlId, (view) => {
      const selected = JSON.stringify([view.workspaceId, view.workspaceName]);
      if (
        this.bindings.get(key.id) !== binding ||
        binding.lastSelection === selected
      )
        return;
      binding.lastSelection = selected;
      this.buttons.bind(key, {
        workspaceId: view.workspaceId,
        workspaceName: view.workspaceName,
      });
    });
  }

  bindDial(dial: DialAction<ControlSettings>, controlId: string): void {
    this.unbind(dial.id);
    const binding: Binding = {
      controlId: normalizeControlId(controlId),
      renderVersion: 0,
      queue: Promise.resolve(),
    };
    this.bindings.set(dial.id, binding);
    binding.stop = this.selections.subscribe(binding.controlId, (view) => {
      const rendered = JSON.stringify([
        view.controlId,
        view.workspaceName,
        view.status,
        view.available,
        view.index,
      ]);
      if (binding.lastSelection === rendered) return;
      binding.lastSelection = rendered;
      const version = ++binding.renderVersion;
      binding.queue = binding.queue
        .catch(() => {})
        .then(async () => {
          if (
            this.bindings.get(dial.id) !== binding ||
            binding.renderVersion !== version
          )
            return;
          await dial.setFeedback({
            title: `${view.controlId} · ${labels[view.status]}`,
            workspace: view.workspaceName,
            position: view.available
              ? `${view.index >= 0 ? view.index + 1 : "—"} / ${view.available}`
              : "候補なし",
          });
        });
      void binding.queue.catch((error: unknown) =>
        this.report(
          dial.id,
          error instanceof Error
            ? error.message
            : "ダイヤル表示を更新できません。",
        ),
      );
    });
  }

  unbind(actionId: string): void {
    const binding = this.bindings.get(actionId);
    this.bindings.delete(actionId);
    this.buttons.unbind(actionId);
    binding?.stop?.();
  }

  async rotate(actionId: string, ticks: number): Promise<void> {
    if (!Number.isFinite(ticks) || !Math.trunc(ticks)) return;
    await this.updateSelection(actionId, (id) =>
      this.selections.rotate(id, ticks),
    );
  }
  async selectNextWaiting(actionId: string): Promise<void> {
    await this.updateSelection(actionId, (id) =>
      this.selections.selectNextWaiting(id),
    );
  }

  private updateSelection(
    actionId: string,
    change: (id: string) => void,
  ): Promise<boolean> {
    const binding = this.bindings.get(actionId);
    if (!binding) return Promise.resolve(false);
    const id = binding.controlId;
    // 取得中の通信は monitor が共有し、連続する操作は入力順に適用する。
    const previous = this.selectionUpdates.get(id) ?? Promise.resolve(true);
    const next = Promise.all([
      previous.catch(() => false),
      this.monitor.refresh(),
    ]).then(([, state]) => {
      if (!state.snapshot || this.bindings.get(actionId) !== binding)
        return false;
      change(id);
      return true;
    });
    this.selectionUpdates.set(id, next);
    const cleanup = () => {
      if (this.selectionUpdates.get(id) === next)
        this.selectionUpdates.delete(id);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
  async press(actionId: string): Promise<void> {
    const binding = this.bindings.get(actionId);
    if (!binding) return;
    const version = ++this.navigationVersion;
    const current = () =>
      this.bindings.get(actionId) === binding &&
      this.navigationVersion === version;
    try {
      let pending = this.selectionUpdates.get(binding.controlId);
      while (pending) {
        if (!(await pending))
          throw new Error(
            this.monitor.state.error ??
              "ワークスペース一覧を更新できません。もう一度ダイヤルを操作してください。",
          );
        if (!current()) return;
        pending = this.selectionUpdates.get(binding.controlId);
      }
      if (current()) await this.buttons.press(actionId, current);
    } catch (error) {
      if (current()) {
        this.report(
          actionId,
          error instanceof Error
            ? error.message
            : "ワークスペース一覧を更新できません。",
        );
        await binding.key?.showAlert();
      }
    }
  }

  async sendView(actionId: string, requestId: string): Promise<void> {
    const binding = this.bindings.get(actionId);
    if (!binding) return;
    await this.monitor.refresh();
    let pending = this.selectionUpdates.get(binding.controlId);
    while (pending) {
      await pending;
      pending = this.selectionUpdates.get(binding.controlId);
    }
    if (
      this.bindings.get(actionId) !== binding ||
      streamDeck.ui.action?.id !== actionId
    )
      return;
    const view: ControlView = this.selections.view(binding.controlId);
    await streamDeck.ui.sendToPropertyInspector({
      type: "control-view",
      actionId,
      requestId,
      controlId: view.controlId,
      workspaceName: view.workspaceName,
      status: labels[view.status],
      available: view.available,
      error: view.error,
    });
  }
}
export const workspaceService = new WorkspaceService();
