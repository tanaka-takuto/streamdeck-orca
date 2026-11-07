import {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { normalizeControlId } from "../workspace-selections";
import { type ControlSettings, workspaceService } from "../workspace-service";

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
export class WorkspaceStatusAction extends SingletonAction<ControlSettings> {
  override onWillAppear(ev: WillAppearEvent<ControlSettings>): void {
    if (ev.action.isKey())
      workspaceService.bindKey(
        ev.action,
        normalizeControlId(ev.payload.settings.controlId),
      );
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ControlSettings>,
  ): void {
    if (ev.action.isKey())
      workspaceService.bindKey(
        ev.action,
        normalizeControlId(ev.payload.settings.controlId),
      );
  }
  override onWillDisappear(ev: WillDisappearEvent<ControlSettings>): void {
    workspaceService.unbind(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<ControlSettings>): Promise<void> {
    await workspaceService.press(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<ControlMessage, ControlSettings>,
  ): Promise<void> {
    await sendView(ev);
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
  override onDialRotate(ev: DialRotateEvent<ControlSettings>): void {
    workspaceService.rotate(ev.action.id, ev.payload.ticks);
  }
  override onDialDown(ev: DialDownEvent<ControlSettings>): void {
    workspaceService.selectNextWaiting(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<ControlMessage, ControlSettings>,
  ): Promise<void> {
    await sendView(ev);
  }
}
