import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { commandImage } from "../command-image";
import { ActiveAiInput, type ActiveInputSettings } from "../orca/active-input";
import { createCliRunner, OrcaClient } from "../orca/client";
import type { ExecutionResult } from "../orca/execution";
import type { WorkspaceKey } from "../workspace-buttons";

type Settings = ActiveInputSettings & { revision?: string };
type Binding = { key: WorkspaceKey; settings: Settings; queue: Promise<void> };
type ViewRequest = { type: string; requestId: string };

@action({ UUID: "com.tanaka-takuto.orca.active-ai-input" })
export class ActiveAiInputAction extends SingletonAction<Settings> {
  private readonly runner = createCliRunner();
  private readonly input = new ActiveAiInput(
    new OrcaClient(this.runner),
    this.runner,
  );
  private readonly bindings = new Map<string, Binding>();
  private readonly busy = new Set<string>();
  private readonly results = new Map<string, ExecutionResult>();

  private bind(key: WorkspaceKey, settings: Settings): void {
    const binding = {
      key,
      settings,
      queue: this.bindings.get(key.id)?.queue ?? Promise.resolve(),
    };
    this.bindings.set(key.id, binding);
    this.results.delete(key.id);
    this.render(binding);
  }
  private render(binding: Binding): void {
    const { key, settings } = binding;
    const result = this.results.get(key.id);
    let phase = settings.enter === true ? "入力＋Enter" : "入力のみ";
    if (!settings.body?.trim()) phase = "要設定";
    if (result)
      phase = {
        unknown: "結果未確認",
        refused: "受付拒否",
        accepted: "受付済み",
        cancelled: "入力中止",
      }[result.status];
    if (this.busy.has(key.id)) phase = "入力中";
    const image = commandImage(
      "アクティブAI",
      settings.label?.trim() || "定型文",
      "ai",
      phase,
    );
    binding.queue = binding.queue
      .catch(() => {})
      .then(async () => {
        if (this.bindings.get(key.id) === binding) await key.setImage(image);
      });
    void binding.queue.catch(() =>
      streamDeck.logger.warn("アクティブ AI 入力キーの表示を更新できません。"),
    );
  }
  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isKey()) this.bind(ev.action, ev.payload.settings);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isKey()) this.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.bindings.delete(ev.action.id);
    this.results.delete(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const id = ev.action.id;
    const binding = this.bindings.get(id);
    if (!binding || this.busy.has(id)) return;
    this.busy.add(id);
    this.results.delete(id);
    this.render(binding);
    const current = () => this.bindings.get(id) === binding;
    let result: ExecutionResult;
    try {
      result = await this.input.send(binding.settings, current);
    } catch (error) {
      result = {
        status: "refused",
        message:
          error instanceof Error ? error.message : "入力先を確認してください。",
      };
    }
    if (current()) {
      this.results.set(id, result);
      try {
        if (result.status === "accepted") await binding.key.showOk?.();
        else if (result.status !== "cancelled") await binding.key.showAlert();
      } catch {
        streamDeck.logger.warn(
          "AI 入力の結果表示を更新できません。入力は再試行しません。",
        );
      }
    }
    this.busy.delete(id);
    const latest = this.bindings.get(id);
    if (latest) this.render(latest);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<ViewRequest, Settings>,
  ): Promise<void> {
    if (
      ev.payload?.type !== "get-active-input-result" ||
      typeof ev.payload.requestId !== "string" ||
      streamDeck.ui.action?.id !== ev.action.id
    )
      return;
    await streamDeck.ui.sendToPropertyInspector({
      type: "active-input-result",
      actionId: ev.action.id,
      requestId: ev.payload.requestId,
      busy: this.busy.has(ev.action.id),
      result: this.results.get(ev.action.id),
    });
  }
}
