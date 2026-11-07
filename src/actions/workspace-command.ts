import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { ExecutionSettings } from "../orca/execution";
import { type ControlSettings, workspaceService } from "../workspace-service";
export type CommandSettings = ControlSettings &
  ExecutionSettings & { revision?: string };
type ViewRequest = { type: string; requestId: string; includeAgents?: boolean };

@action({ UUID: "com.tanaka-takuto.orca.workspace-command" })
export class WorkspaceCommandAction extends SingletonAction<CommandSettings> {
  override onWillAppear(ev: WillAppearEvent<CommandSettings>): void {
    if (ev.action.isKey())
      workspaceService.bindCommand(ev.action, ev.payload.settings);
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<CommandSettings>,
  ): void {
    if (ev.action.isKey())
      workspaceService.bindCommand(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<CommandSettings>): void {
    workspaceService.unbind(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<CommandSettings>): Promise<void> {
    await workspaceService.execute(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<ViewRequest, CommandSettings>,
  ): Promise<void> {
    if (
      ev.payload?.type === "get-execution" &&
      typeof ev.payload.requestId === "string"
    )
      await workspaceService.sendExecutionView(
        ev.action.id,
        ev.payload.requestId,
        ev.payload.includeAgents === true,
      );
  }
}
