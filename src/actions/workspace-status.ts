import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { logDiagnostic } from "../diagnostics";
import { workspaceService } from "../workspace-service";
import type { WorkspaceButtonSettings } from "../workspace-status-controller";

@action({ UUID: "com.tanaka-takuto.orca.workspace-status" })
export class WorkspaceStatusAction extends SingletonAction<WorkspaceButtonSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<WorkspaceButtonSettings>,
  ): Promise<void> {
    logDiagnostic("workspace.appeared", {
      actionId: ev.action.id,
      deviceId: ev.action.device.id,
    });
    if (ev.action.isKey())
      await workspaceService.status.bind(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<WorkspaceButtonSettings>,
  ): Promise<void> {
    logDiagnostic("workspace.settings-received", { actionId: ev.action.id });
    if (ev.action.isKey())
      await workspaceService.status.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(
    ev: WillDisappearEvent<WorkspaceButtonSettings>,
  ): void {
    logDiagnostic("workspace.disappeared", { actionId: ev.action.id });
    workspaceService.status.unbind(ev.action.id);
  }
  override onKeyDown(ev: KeyDownEvent<WorkspaceButtonSettings>): void {
    logDiagnostic("workspace.key.down", {
      actionId: ev.action.id,
      sdkConnected: ev.action.device.isConnected,
    });
    workspaceService.status.down(ev.action.id);
  }
  override onKeyUp(ev: KeyUpEvent<WorkspaceButtonSettings>): void {
    logDiagnostic("workspace.key.up", {
      actionId: ev.action.id,
      sdkConnected: ev.action.device.isConnected,
    });
    workspaceService.status.up(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<
      {
        type: string;
        requestId: string;
      },
      WorkspaceButtonSettings
    >,
  ): Promise<void> {
    const message = ev.payload;
    if (!message || typeof message.requestId !== "string") return;
    if (message.type !== "get-workspace-button") return;
    const view = await workspaceService.status.view(ev.action.id);
    if (view && streamDeck.ui.action?.id === ev.action.id)
      await streamDeck.ui.sendToPropertyInspector({
        type: "workspace-button-view",
        actionId: ev.action.id,
        requestId: message.requestId,
        ...view,
      });
  }
}
