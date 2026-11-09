import streamDeck from "@elgato/streamdeck";
import { AttentionButtons } from "./attention-buttons";
import { commandImage } from "./command-image";
import { createCliRunner, OrcaClient } from "./orca/client";
import {
  type AgentDirectory,
  type ExecutionResult,
  type ExecutionSettings,
  WorkspaceExecutor,
} from "./orca/execution";
import { WorkspaceMonitor } from "./orca/monitor";
import { type PluginSettings, updatePluginSettings } from "./plugin-settings";
import type { WorkspaceKey } from "./workspace-buttons";
import { ambiguousMessage, type WorkspaceIdentity } from "./workspace-identity";
import {
  type ControlView,
  normalizeControlId,
  type SavedSelection,
  WorkspaceSelections,
} from "./workspace-selections";
import { WorkspaceStatusController } from "./workspace-status-controller";

export type ControlSettings = { controlId?: string };
type GlobalSettings = { workspaceSelections?: Record<string, SavedSelection> };
type Binding = {
  controlId: string;
  key?: WorkspaceKey;
  command?: ExecutionSettings;
  stop?: () => void;
  lastSelection?: string;
  renderVersion: number;
  queue: Promise<void>;
  displayed?: { workspaceId: string | undefined; command: ExecutionSettings };
};
const labels = {
  working: "進行中",
  waiting: "入力待ち",
  review: "要確認",
  idle: "待機",
  unknown: "状態不明",
};
type ExecutionRecord = {
  busy: boolean;
  workspaceId?: string;
  workspaceName?: string;
  workspaceIdentity?: WorkspaceIdentity;
  controlId?: string;
  command?: ExecutionSettings;
  result?: ExecutionResult;
};

class WorkspaceService {
  beginNavigation(): () => boolean {
    const version = ++this.navigationVersion;
    return () => this.navigationVersion === version;
  }
  observeControl(controlId: string, listener: () => void): () => void {
    return this.selections.subscribe(controlId, listener);
  }
  controlContext(controlId: string) {
    return {
      view: this.selections.view(controlId),
      catalog: this.monitor.state.snapshot?.workspaces ?? [],
      runtimeId: this.monitor.state.snapshot?.runtimeId,
      unavailable:
        !this.monitor.state.snapshot ||
        !!this.monitor.state.error ||
        !!this.monitor.state.fromCache,
      partial:
        !!this.monitor.state.snapshot?.truncated ||
        !!this.monitor.state.snapshot?.omittedHosts,
    };
  }
  async freshControlContext(controlId: string) {
    await this.monitor.refresh();
    return this.controlContext(controlId);
  }
  private readonly runner = createCliRunner();
  private readonly client = new OrcaClient(this.runner);
  private readonly executor = new WorkspaceExecutor(this.client, this.runner);
  private readonly monitor = new WorkspaceMonitor(this.client);
  private resolveLegacy!: (settings: PluginSettings | Error) => void;
  private readonly legacySettings = new Promise<PluginSettings | Error>(
    (resolve) => {
      this.resolveLegacy = resolve;
    },
  );
  readonly status = new WorkspaceStatusController(
    this.monitor,
    this.client,
    async () => {
      const result = await this.legacySettings;
      if (result instanceof Error) throw result;
      return result;
    },
    (url) => streamDeck.system.openUrl(url),
    (id, message) => this.report(id, message),
    () => this.beginNavigation(),
  );
  private readonly selections = new WorkspaceSelections(
    this.monitor,
    (id, selection) => this.remember(id, selection),
  );
  private readonly bindings = new Map<string, Binding>();
  private readonly commandRenders = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, ExecutionRecord>();
  private navigationVersion = 0;
  private readonly attention = new AttentionButtons(
    this.monitor,
    this.client,
    () => {
      const version = ++this.navigationVersion;
      return () => this.navigationVersion === version;
    },
    (id, message) => this.report(id, message),
  );
  private pendingSelections: Record<string, SavedSelection> = {};
  private settingsReady = false;
  private saveTimer?: ReturnType<typeof setTimeout>;

  async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const globalSettings = await Promise.race([
        streamDeck.settings.getGlobalSettings<GlobalSettings>(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("選択の保存先を読み込めません。")),
            5_000,
          );
        }),
      ]);
      this.resolveLegacy(structuredClone(globalSettings));
      this.settingsReady = true;
      const saved = globalSettings.workspaceSelections;
      this.selections.hydrate(
        saved && typeof saved === "object" && !Array.isArray(saved)
          ? saved
          : {},
      );
    } catch (error) {
      this.resolveLegacy(
        new Error(
          "旧割当の保存設定を取得できません。プラグインを再起動して移行をやり直してください。",
        ),
      );
      streamDeck.logger.warn(error);
      this.selections.hydrate({});
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(id: string, selection: SavedSelection): void {
    if (!this.settingsReady) return;
    this.pendingSelections[id] = selection;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const value = this.pendingSelections;
      this.pendingSelections = {};
      void updatePluginSettings((current) => ({
        ...current,
        workspaceSelections: { ...current.workspaceSelections, ...value },
      })).catch((error: unknown) => streamDeck.logger.warn(error));
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

  unbind(actionId: string): void {
    const binding = this.bindings.get(actionId);
    this.bindings.delete(actionId);
    this.attention.unbind(actionId);
    binding?.stop?.();
  }

  bindAttention(key: WorkspaceKey): void {
    this.unbind(key.id);
    this.attention.bind(key);
  }
  async pressAttention(id: string): Promise<void> {
    await this.attention.press(id);
  }
  async sendAttentionView(id: string, requestId: string): Promise<void> {
    const view = await this.attention.inspectorView(id);
    if (view && streamDeck.ui.action?.id === id)
      await streamDeck.ui.sendToPropertyInspector({
        type: "attention-view",
        actionId: id,
        requestId,
        view,
      });
  }

  bindCommand(
    key: WorkspaceKey,
    settings: ControlSettings & ExecutionSettings,
  ): void {
    this.unbind(key.id);
    const binding: Binding = {
      key,
      controlId: normalizeControlId(settings.controlId),
      command: { ...settings },
      renderVersion: 0,
      queue: Promise.resolve(),
    };
    this.bindings.set(key.id, binding);
    binding.stop = this.selections.subscribe(binding.controlId, (view) =>
      this.renderCommand(binding, view),
    );
  }

  private renderCommand(binding: Binding, view: ControlView): void {
    const key = binding.key;
    const command = binding.command;
    if (!key || !command || this.bindings.get(key.id) !== binding) return;
    const record = this.executions.get(key.id);
    const displayCommand = record?.busy ? (record.command ?? command) : command;
    const last =
      record?.command === command && record.workspaceId === view.workspaceId
        ? record.result
        : undefined;
    const phases = {
      accepted: "受付済み",
      refused: "受付拒否",
      unknown: "結果未確認",
      cancelled: "未実行",
    };
    const phase = record?.busy
      ? "要求中"
      : last
        ? phases[last.status]
        : command.body?.trim()
          ? "押して実行"
          : "要設定";
    const name = record?.busy
      ? (record.workspaceName ?? view.workspaceName)
      : view.workspaceName;
    const displayedWorkspaceId = record?.busy
      ? (record.workspaceId ?? view.workspaceId)
      : view.workspaceId;
    const image = commandImage(
      name,
      displayCommand.label?.trim() ||
        (displayCommand.mode === "ai" ? "AIへ指示" : "コマンド実行"),
      displayCommand.mode ?? "shell",
      phase,
      {
        ...(record?.busy
          ? (record.workspaceIdentity ?? view.identity)
          : view.identity),
        controlId: record?.busy
          ? (record.controlId ?? binding.controlId)
          : binding.controlId,
      },
    );
    const renderKey = JSON.stringify([image, displayedWorkspaceId]);
    if (binding.lastSelection === renderKey) return;
    binding.lastSelection = renderKey;
    const displayed = {
      workspaceId: displayedWorkspaceId,
      command: displayCommand,
    };
    const version = ++binding.renderVersion;
    binding.queue = (this.commandRenders.get(key.id) ?? binding.queue)
      .catch(() => {})
      .then(async () => {
        if (
          this.bindings.get(key.id) === binding &&
          binding.renderVersion === version
        ) {
          if (
            binding.displayed?.workspaceId !== displayed.workspaceId ||
            binding.displayed?.command !== displayCommand
          )
            binding.displayed = undefined;
          await key.setImage(image);
          if (this.bindings.get(key.id) === binding)
            binding.displayed = displayed;
        }
      });
    const rendering = binding.queue;
    this.commandRenders.set(key.id, rendering);
    const cleanup = () => {
      if (this.commandRenders.get(key.id) === rendering)
        this.commandRenders.delete(key.id);
    };
    void rendering.then(cleanup, cleanup);
    void binding.queue.catch(() => {
      if (
        this.bindings.get(key.id) !== binding ||
        binding.renderVersion !== version
      )
        return;
      binding.displayed = undefined;
      binding.lastSelection = undefined;
      this.report(key.id, "コマンドボタンの表示を更新できません。");
    });
  }

  async execute(actionId: string): Promise<void> {
    const binding = this.bindings.get(actionId);
    if (!binding?.command || !binding.key) return;
    const record = this.executions.get(actionId) ?? { busy: false };
    if (record.busy) return;
    const shown = binding.displayed;
    this.executions.set(actionId, record);
    record.busy = true;
    record.result = undefined;
    record.workspaceId = undefined;
    record.workspaceName = undefined;
    record.workspaceIdentity = undefined;
    record.controlId = binding.controlId;
    record.command = binding.command;
    this.renderCommand(binding, this.selections.view(binding.controlId));
    try {
      if (this.bindings.get(actionId) !== binding) return;
      const view = this.selections.view(binding.controlId);
      if (!view.workspaceId)
        throw new Error(
          "保存済みの対象ワークスペースを確認できません。設定を確認してください。",
        );
      if (view.identity?.ambiguous) throw new Error(ambiguousMessage);
      if (
        !shown ||
        shown.workspaceId !== view.workspaceId ||
        shown.command !== binding.command
      ) {
        throw new Error(
          "キーの表示を更新しています。表示を確認して、もう一度押してください。",
        );
      }
      record.workspaceId = view.workspaceId;
      record.workspaceName = view.workspaceName;
      record.workspaceIdentity = view.identity;
      const current = () =>
        this.bindings.get(actionId) === binding &&
        this.selections.view(binding.controlId).workspaceId ===
          view.workspaceId;
      this.renderCommand(binding, view);
      record.result = await this.executor.execute(
        view.workspaceId,
        binding.command,
        current,
      );
      if (current()) {
        if (record.result.status === "accepted")
          await binding.key
            .showOk?.()
            .catch(() =>
              this.report(
                actionId,
                "受付済みですが、キーの確認表示を更新できません。",
              ),
            );
        else if (record.result.status !== "cancelled")
          await binding.key
            .showAlert()
            .catch(() =>
              this.report(actionId, "キーの警告表示を更新できません。"),
            );
      }
    } catch (error) {
      record.result = {
        status: "refused",
        message:
          error instanceof Error
            ? error.message
            : "実行内容と送信先を確認してください。",
      };
      if (this.bindings.get(actionId) === binding) {
        this.report(actionId, record.result.message);
        await binding.key
          .showAlert()
          .catch(() =>
            this.report(actionId, "キーの警告表示を更新できません。"),
          );
      }
    } finally {
      record.busy = false;
      if (!record.result)
        record.result = {
          status: "cancelled",
          message: "対象または設定が変わったため実行していません。",
        };
      const latest = this.bindings.get(actionId);
      if (latest?.command)
        this.renderCommand(latest, this.selections.view(latest.controlId));
    }
  }

  async sendExecutionView(
    actionId: string,
    requestId: string,
    includeAgents: boolean,
  ): Promise<void> {
    const binding = this.bindings.get(actionId);
    if (!binding?.command) return;
    await this.monitor.refresh();
    const selected = this.selections.view(binding.controlId);
    let directory: AgentDirectory | undefined;
    let targetError: string | undefined;
    if (includeAgents && selected.workspaceId) {
      try {
        directory = await this.executor.agents(selected.workspaceId);
      } catch (error) {
        targetError =
          error instanceof Error
            ? error.message
            : "AI の送信先を取得できません。";
      }
    }
    if (
      this.bindings.get(actionId) !== binding ||
      streamDeck.ui.action?.id !== actionId
    )
      return;
    const view = this.selections.view(binding.controlId);
    if (directory?.workspaceId !== view.workspaceId) directory = undefined;
    const record = this.executions.get(actionId);
    await streamDeck.ui.sendToPropertyInspector({
      type: "execution-view",
      actionId,
      requestId,
      controlId: view.controlId,
      workspaceId: view.workspaceId,
      workspaceName: view.workspaceName,
      workspaceIdentity: view.identity,
      status: labels[view.status],
      available: view.available,
      targets: directory?.targets ?? [],
      error: view.error ?? targetError,
      busy: record?.busy ?? false,
      lastResult: record?.result
        ? { ...record.result, workspaceName: record.workspaceName ?? "未選択" }
        : undefined,
    });
  }
}
export const workspaceService = new WorkspaceService();
