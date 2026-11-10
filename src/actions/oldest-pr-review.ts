import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { OldestPRController } from "../oldest-pr-controller";
import { latestReviewRecord } from "../orca/review-launcher";
import {
  readReviewRecords,
  reviewGitHub,
  reviewLauncher,
} from "../pr-review-runtime";
import type { ReviewSettings } from "../pr-review-settings";

const controller = new OldestPRController(
  reviewGitHub,
  reviewLauncher,
  30000,
  async (accountId, pr) =>
    latestReviewRecord(await readReviewRecords(), accountId, pr),
);
streamDeck.devices.onDeviceDidDisconnect((ev) =>
  controller.disconnect(ev.device.id),
);
type Message = {
  type: string;
  requestId: string;
  prKey?: string;
  accountId?: number;
  operationId?: string;
  confirmed?: boolean;
};
@action({ UUID: "com.tanaka-takuto.orca.oldest-pr-review" })
export class OldestPRReviewAction extends SingletonAction<ReviewSettings> {
  override onWillAppear(ev: WillAppearEvent<ReviewSettings>): void {
    if (ev.action.isKey()) controller.bind(ev.action, ev.payload.settings);
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ReviewSettings>,
  ): void {
    if (ev.action.isKey()) controller.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<ReviewSettings>): void {
    controller.unbind(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<ReviewSettings>): Promise<void> {
    await controller.press(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Message, ReviewSettings>,
  ): Promise<void> {
    const p = ev.payload,
      id = ev.action.id;
    if (
      !p ||
      typeof p.requestId !== "string" ||
      streamDeck.ui.action?.id !== id
    )
      return;
    let error: string | undefined;
    if (p.type === "refresh-oldest-pr") await controller.refresh(id);
    else if (p.type === "forget-oldest-pr") {
      try {
        if (
          p.confirmed !== true ||
          typeof p.prKey !== "string" ||
          typeof p.accountId !== "number" ||
          typeof p.operationId !== "string"
        )
          throw new Error("Orcaで前回の起動状況を確認してください。");
        await controller.forget(id, p.prKey, p.accountId, p.operationId);
      } catch (e) {
        error = e instanceof Error ? e.message : "記録を解除できません。";
      }
    } else if (p.type !== "get-oldest-pr-view") return;
    const view = controller.view(id),
      candidate = view.candidate;
    const previous =
      candidate && view.accountId
        ? latestReviewRecord(
            await readReviewRecords(),
            view.accountId,
            candidate,
          )
        : undefined;
    const current = controller.view(id);
    if (
      streamDeck.ui.action?.id !== id ||
      JSON.stringify([
        current.settings,
        current.accountId,
        current.candidate,
      ]) !== JSON.stringify([view.settings, view.accountId, view.candidate])
    )
      return;
    await streamDeck.ui.sendToPropertyInspector({
      type: "oldest-pr-view",
      actionId: id,
      requestId: p.requestId,
      ...current,
      previous,
      ...(error ? { error } : {}),
    });
  }
}
