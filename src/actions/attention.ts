import {
  action,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { workspaceService } from "../workspace-service";

@action({ UUID: "com.tanaka-takuto.orca.attention" })
export class AttentionAction extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent): void {
    if (ev.action.isKey()) workspaceService.bindAttention(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    workspaceService.unbind(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await workspaceService.pressAttention(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<
      { type: string; requestId: string },
      Record<string, never>
    >,
  ): Promise<void> {
    if (
      ev.payload?.type === "get-attention" &&
      typeof ev.payload.requestId === "string"
    )
      await workspaceService.sendAttentionView(
        ev.action.id,
        ev.payload.requestId,
      );
  }
}
