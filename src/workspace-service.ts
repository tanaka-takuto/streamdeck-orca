import streamDeck from "@elgato/streamdeck";
import { AttentionButtons } from "./attention-buttons";
import { createCliRunner, OrcaClient } from "./orca/client";
import { WorkspaceMonitor } from "./orca/monitor";
import { readPluginSettings } from "./plugin-settings";
import type { WorkspaceKey } from "./workspace-buttons";
import { WorkspaceStatusController } from "./workspace-status-controller";

class WorkspaceService {
  private readonly client = new OrcaClient(createCliRunner());
  private readonly monitor = new WorkspaceMonitor(this.client);
  private navigationVersion = 0;
  private beginNavigation(): () => boolean {
    const version = ++this.navigationVersion;
    return () => this.navigationVersion === version;
  }
  readonly status = new WorkspaceStatusController(
    this.monitor,
    this.client,
    readPluginSettings,
    (url) => streamDeck.system.openUrl(url),
    (id, message) => this.report(id, message),
    () => this.beginNavigation(),
  );
  private readonly attention = new AttentionButtons(
    this.monitor,
    this.client,
    () => this.beginNavigation(),
    (id, message) => this.report(id, message),
  );
  private report(actionId: string, message: string): void {
    streamDeck.logger.warn(message);
    if (streamDeck.ui.action?.id === actionId)
      void streamDeck.ui
        .sendToPropertyInspector({ type: "error", actionId, message })
        .catch((error: unknown) => streamDeck.logger.error(error));
  }
  unbind(actionId: string): void {
    this.attention.unbind(actionId);
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
}
export const workspaceService = new WorkspaceService();
