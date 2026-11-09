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
import { workspaceService } from "../workspace-service";
import type { WorkspaceButtonSettings } from "../workspace-status-controller";

@action({ UUID: "com.tanaka-takuto.orca.workspace-status" })
export class WorkspaceStatusAction extends SingletonAction<WorkspaceButtonSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<WorkspaceButtonSettings>,
  ): Promise<void> {
    if (ev.action.isKey())
      await workspaceService.status.bind(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<WorkspaceButtonSettings>,
  ): Promise<void> {
    if (ev.action.isKey())
      await workspaceService.status.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(
    ev: WillDisappearEvent<WorkspaceButtonSettings>,
  ): void {
    workspaceService.status.unbind(ev.action.id);
  }
  override onKeyDown(ev: KeyDownEvent<WorkspaceButtonSettings>): void {
    workspaceService.status.down(ev.action.id);
  }
  override onKeyUp(ev: KeyUpEvent<WorkspaceButtonSettings>): void {
    workspaceService.status.up(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<
      {
        type: string;
        requestId: string;
        workspaceId?: string;
        key?: string;
        revision?: string;
      },
      WorkspaceButtonSettings
    >,
  ): Promise<void> {
    const message = ev.payload;
    if (!message || typeof message.requestId !== "string") return;
    if (
      message.type === "select-reference" &&
      typeof message.workspaceId === "string" &&
      typeof message.key === "string" &&
      typeof message.revision === "string"
    )
      await workspaceService.status.selectReference(
        ev.action.id,
        message.workspaceId,
        message.key,
        message.revision,
      );
    else if (message.type !== "get-workspace-button") return;
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
