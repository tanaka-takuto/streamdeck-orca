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
import { prKey } from "../github/reviews";
import type { ReviewRecord } from "../orca/review-launcher";
import { PRReviewController } from "../pr-review-controller";
import {
  reviewGitHub as github,
  reviewLauncher as launcher,
  readReviewRecords as records,
} from "../pr-review-runtime";
import type { ReviewSettings } from "../pr-review-settings";

const controller = new PRReviewController(github, launcher);

@action({ UUID: "com.tanaka-takuto.orca.pr-review" })
export class PRReviewAction extends SingletonAction<ReviewSettings> {
  override onWillAppear(ev: WillAppearEvent<ReviewSettings>): void {
    if (ev.action.isDial()) controller.bind(ev.action, ev.payload.settings);
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ReviewSettings>,
  ): void {
    if (ev.action.isDial()) controller.bind(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<ReviewSettings>): void {
    controller.unbind(ev.action.id);
  }
  override onDialRotate(ev: DialRotateEvent<ReviewSettings>): void {
    controller.rotate(ev.action.id, ev.payload.ticks);
  }
  override async onDialDown(ev: DialDownEvent<ReviewSettings>): Promise<void> {
    await controller.launch(ev.action.id);
  }
  override async onTouchTap(ev: TouchTapEvent<ReviewSettings>): Promise<void> {
    await controller.refresh(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<
      {
        type: string;
        requestId: string;
        prKey?: string;
        confirmed?: boolean;
        accountId?: number;
        operationId?: string;
      },
      ReviewSettings
    >,
  ): Promise<void> {
    if (
      !ev.payload ||
      typeof ev.payload.requestId !== "string" ||
      streamDeck.ui.action?.id !== ev.action.id
    )
      return;
    if (ev.payload.type === "refresh-pr-review") {
      await controller.refresh(ev.action.id);
      return;
    }
    if (
      ev.payload.type !== "get-pr-review-view" &&
      ev.payload.type !== "forget-pr-review"
    )
      return;
    let error: string | undefined;
    if (ev.payload.type === "forget-pr-review") {
      try {
        if (
          ev.payload.confirmed !== true ||
          typeof ev.payload.prKey !== "string" ||
          typeof ev.payload.operationId !== "string" ||
          typeof ev.payload.accountId !== "number"
        )
          throw new Error(
            "Orcaで起動状況を確認してから記録を解除してください。",
          );
        await controller.forget(
          ev.action.id,
          ev.payload.prKey,
          ev.payload.accountId,
          ev.payload.operationId,
        );
      } catch (e) {
        error = e instanceof Error ? e.message : "記録を解除できません。";
      }
    }
    const view = controller.view(ev.action.id);
    let previous: ReviewRecord | undefined;
    const candidate = view.candidate;
    if (candidate && view.accountId)
      previous = Object.values(await records())
        .filter(
          (r) =>
            r.accountId === view.accountId && prKey(r.pr) === prKey(candidate),
        )
        .sort((a, b) => b.at - a.at)[0];
    await streamDeck.ui.sendToPropertyInspector({
      type: "pr-review-view",
      actionId: ev.action.id,
      requestId: ev.payload.requestId,
      ...view,
      previous,
      ...(error ? { error } : {}),
    });
  }
}
