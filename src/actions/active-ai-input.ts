import { createHash } from "node:crypto";
import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { activeInputImage } from "../active-input-image";
import {
  ActiveAiInput,
  type ActiveInputSettings,
  type ActiveRecipient,
  recipientSignature,
} from "../orca/active-input";
import { createCliRunner, OrcaClient } from "../orca/client";
import type { ExecutionResult } from "../orca/execution";
import { RecipientMonitor } from "../orca/recipient-monitor";
import type { WorkspaceKey } from "../workspace-buttons";

type Settings = ActiveInputSettings & { revision?: string };
type Intent = { settings: Settings; recipient?: ActiveRecipient };
type Receipt = {
  at: string;
  label: string;
  enter: boolean;
  fingerprint: string;
  recipient?: ActiveRecipient;
  result: ExecutionResult;
};
type Binding = {
  key: WorkspaceKey;
  settings: Settings;
  queue: Promise<void>;
  displayed?: Intent;
  desired?: string;
  unsubscribe?: () => void;
};
const fingerprint = (s: Settings) =>
  createHash("sha256")
    .update(JSON.stringify([s.label, s.body, s.enter === true]))
    .digest("hex");
const signature = (i: Intent) =>
  JSON.stringify([
    fingerprint(i.settings),
    i.recipient ? recipientSignature(i.recipient) : null,
  ]);
@action({ UUID: "com.tanaka-takuto.orca.active-ai-input" })
export class ActiveAiInputAction extends SingletonAction<Settings> {
  private readonly runner = createCliRunner();
  private readonly input = new ActiveAiInput(
    new OrcaClient(this.runner),
    this.runner,
  );
  private readonly monitor = new RecipientMonitor(() => this.input.resolve());
  private readonly bindings = new Map<string, Binding>();
  private readonly renders = new Map<string, Promise<void>>();
  private readonly busy = new Map<string, Intent>();
  private readonly results = new Map<string, Receipt>();
  private readonly shown = new Map<string, Intent>();
  private bind(key: WorkspaceKey, settings: Settings): void {
    this.bindings.get(key.id)?.unsubscribe?.();
    const binding: Binding = {
      key,
      settings: { ...settings },
      queue: this.renders.get(key.id) ?? Promise.resolve(),
    };
    this.bindings.set(key.id, binding);
    if (settings.recipientMode === "displayed-v1")
      binding.unsubscribe = this.monitor.subscribe(() => this.render(binding));
    else this.render(binding);
  }
  private intent(binding: Binding): Intent {
    return (
      this.busy.get(binding.key.id) ?? {
        settings: binding.settings,
        recipient: this.monitor.state.recipient ?? undefined,
      }
    );
  }
  private render(binding: Binding): void {
    if (this.bindings.get(binding.key.id) !== binding) return;
    const { key } = binding,
      intent = this.intent(binding),
      settings = intent.settings;
    const sig = signature(intent);
    if (binding.desired !== sig) {
      binding.displayed = undefined;
      binding.desired = sig;
    }
    let phase = "押して入力";
    const receipt = this.results.get(key.id);
    if (
      receipt &&
      receipt.fingerprint === fingerprint(settings) &&
      receipt.recipient &&
      intent.recipient &&
      recipientSignature(receipt.recipient) ===
        recipientSignature(intent.recipient)
    )
      phase = {
        accepted: "前回受付",
        refused: "前回拒否",
        unknown: "前回不明",
        cancelled: "前回中止",
      }[receipt.result.status];
    if (!intent.recipient)
      phase = this.monitor.state.error ? "取得できません" : "取得中";
    if (this.monitor.state.fromCache) phase = "更新待ち";
    if (!settings.body?.trim()) phase = "要設定";
    if (settings.recipientMode !== "displayed-v1") phase = "設定で確認";
    if (this.busy.has(key.id)) phase = "受付確認中";
    const image = activeInputImage(
      intent.recipient,
      settings.label?.trim() || "定型文",
      settings.enter === true,
      phase,
    );
    binding.queue = binding.queue
      .catch(() => {})
      .then(async () => {
        if (this.bindings.get(key.id) !== binding || binding.desired !== sig)
          return;
        await key.setImage(image);
        this.shown.set(key.id, intent);
        if (this.bindings.get(key.id) === binding && binding.desired === sig)
          binding.displayed = intent;
      });
    const rendering = binding.queue;
    this.renders.set(key.id, rendering);
    const cleanup = () => {
      if (this.renders.get(key.id) === rendering) this.renders.delete(key.id);
    };
    void rendering.then(cleanup, () => {
      binding.displayed = undefined;
      cleanup();
      streamDeck.logger.warn("入力先の表示を更新できません。");
    });
  }
  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    if (ev.action.isKey()) this.bind(ev.action, ev.payload.settings);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
    if (ev.action.isKey()) this.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.bindings.get(ev.action.id)?.unsubscribe?.();
    this.bindings.delete(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const id = ev.action.id,
      b = this.bindings.get(id);
    if (!b || this.busy.has(id)) return;
    const at = new Date().toISOString();
    const intent = this.shown.get(id) ?? { settings: b.settings },
      settings = b.settings;
    const record = (result: ExecutionResult) =>
      this.results.set(id, {
        at,
        label: intent.settings.label || "定型文",
        enter: intent.settings.enter === true,
        fingerprint: fingerprint(intent.settings),
        recipient: intent.recipient,
        result,
      });
    if (
      settings.recipientMode !== "displayed-v1" ||
      !b.displayed ||
      b.displayed.settings !== settings ||
      !intent.recipient ||
      this.monitor.state.fromCache ||
      this.monitor.state.error
    ) {
      record({
        status: "refused",
        message:
          settings.recipientMode !== "displayed-v1"
            ? "設定画面で新しい入力先の動作を確認して保存してください。"
            : "入力先の表示を更新しています。表示を確認して押し直してください。入力していません。",
      });
      this.render(b);
      await b.key.showAlert();
      return;
    }
    const recipient = intent.recipient,
      expected = signature(intent);
    this.busy.set(id, intent);
    record({
      status: "cancelled",
      message: "入力要求の受付を確認しています。",
    });
    this.render(b);
    const current = () =>
      this.bindings.get(id) === b &&
      b.settings === settings &&
      !this.monitor.state.fromCache &&
      !this.monitor.state.error &&
      !!this.monitor.state.recipient &&
      recipientSignature(this.monitor.state.recipient) ===
        recipientSignature(recipient) &&
      b.displayed !== undefined &&
      signature(b.displayed) === expected;
    let result: ExecutionResult;
    try {
      result = await this.input.send(settings, recipient, current);
    } catch (error) {
      result = {
        status: "refused",
        message:
          error instanceof Error
            ? error.message
            : "表示した入力先を確認してください。",
      };
    }
    record(result);
    this.busy.delete(id);
    const latest = this.bindings.get(id);
    if (latest) this.render(latest);
    if (this.bindings.get(id) === b) {
      try {
        if (result.status === "accepted") await b.key.showOk?.();
        else if (result.status !== "cancelled") await b.key.showAlert();
      } catch {
        streamDeck.logger.warn(
          "結果の表示を更新できません。再入力はしません。",
        );
      }
    }
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<{ type: string; requestId: string }, Settings>,
  ): Promise<void> {
    if (
      ev.payload?.type !== "get-active-input-result" ||
      typeof ev.payload.requestId !== "string" ||
      streamDeck.ui.action?.id !== ev.action.id
    )
      return;
    const b = this.bindings.get(ev.action.id),
      displayed = b?.displayed;
    await streamDeck.ui.sendToPropertyInspector({
      type: "active-input-result",
      actionId: ev.action.id,
      requestId: ev.payload.requestId,
      busy: this.busy.has(ev.action.id),
      enabled: b?.settings.recipientMode === "displayed-v1",
      recipient: this.shown.get(ev.action.id)?.recipient,
      state:
        this.monitor.state.error ??
        (this.monitor.state.fromCache || !displayed
          ? "更新待ち"
          : !displayed?.recipient
            ? "表示待ち"
            : undefined),
      receipt: this.results.get(ev.action.id),
    });
  }
}
