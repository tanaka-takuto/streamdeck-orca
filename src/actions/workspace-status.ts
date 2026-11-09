import streamDeck, {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { normalizeControlId } from "../workspace-selections";
import { type ControlSettings, workspaceService } from "../workspace-service";
import type { WorkspaceButtonSettings } from "../workspace-status-controller";

type ControlMessage = { type: string; requestId: string };
async function sendView(
  ev: SendToPluginEvent<ControlMessage, ControlSettings>,
): Promise<void> {
  if (
    ev.payload &&
    typeof ev.payload === "object" &&
    ev.payload.type === "get-control" &&
    typeof ev.payload.requestId === "string"
  ) {
    await workspaceService.sendView(ev.action.id, ev.payload.requestId);
  }
}

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

@action({ UUID: "com.tanaka-takuto.orca.workspace-dial" })
export class WorkspaceDialAction extends SingletonAction<ControlSettings> {
  override onWillAppear(ev: WillAppearEvent<ControlSettings>): void {
    if (ev.action.isDial())
      workspaceService.bindDial(
        ev.action,
        normalizeControlId(ev.payload.settings.controlId),
      );
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ControlSettings>,
  ): void {
    if (ev.action.isDial())
      workspaceService.bindDial(
        ev.action,
        normalizeControlId(ev.payload.settings.controlId),
      );
  }
  override onWillDisappear(ev: WillDisappearEvent<ControlSettings>): void {
    workspaceService.unbind(ev.action.id);
  }
  override async onDialRotate(
    ev: DialRotateEvent<ControlSettings>,
  ): Promise<void> {
    await workspaceService.rotate(ev.action.id, ev.payload.ticks);
  }
  override async onDialDown(ev: DialDownEvent<ControlSettings>): Promise<void> {
    await workspaceService.selectNextWaiting(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<ControlMessage, ControlSettings>,
  ): Promise<void> {
    await sendView(ev);
  }
}
