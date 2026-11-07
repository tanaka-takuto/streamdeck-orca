import streamDeck, {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type SendToPluginEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { ChangeRadar } from "../change-radar";
import { createCliRunner, OrcaClient } from "../orca/client";
import { RadarController } from "../radar-controller";
import { normalizeControlId } from "../workspace-selections";
import { type ControlSettings, workspaceService } from "../workspace-service";

const run = createCliRunner();
@action({ UUID: "com.tanaka-takuto.orca.change-radar" })
export class ChangeRadarAction extends SingletonAction<ControlSettings> {
  private readonly controller = new RadarController(
    workspaceService,
    new ChangeRadar(),
    run,
    new OrcaClient(run),
  );
  override onWillAppear(ev: WillAppearEvent<ControlSettings>): void {
    if (ev.action.isDial())
      this.controller.bind(
        ev.action,
        normalizeControlId(ev.payload.settings.controlId),
      );
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ControlSettings>,
  ): void {
    if (ev.action.isDial())
      this.controller.bind(
        ev.action,
        normalizeControlId(ev.payload.settings.controlId),
      );
  }
  override onWillDisappear(ev: WillDisappearEvent<ControlSettings>): void {
    this.controller.unbind(ev.action.id);
  }
  override async onDialRotate(
    ev: DialRotateEvent<ControlSettings>,
  ): Promise<void> {
    this.controller.rotate(ev.action.id, ev.payload.ticks);
  }
  override async onDialDown(ev: DialDownEvent<ControlSettings>): Promise<void> {
    await this.controller.open(ev.action.id, "self");
  }
  override async onTouchTap(ev: TouchTapEvent<ControlSettings>): Promise<void> {
    await this.controller.open(ev.action.id, "peer");
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<{ type: string; requestId: string }, ControlSettings>,
  ): Promise<void> {
    if (
      ev.payload?.type !== "get-radar-view" ||
      typeof ev.payload.requestId !== "string" ||
      streamDeck.ui.action?.id !== ev.action.id
    )
      return;
    await streamDeck.ui.sendToPropertyInspector({
      type: "radar-view",
      actionId: ev.action.id,
      requestId: ev.payload.requestId,
      ...this.controller.view(ev.action.id),
    });
  }
}
