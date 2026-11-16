import { join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import { ActiveAiInputAction } from "./actions/active-ai-input";
import { AttentionAction } from "./actions/attention";
import { OldestPRReviewAction } from "./actions/oldest-pr-review";
import { PRReviewAction } from "./actions/pr-review";
import { WorkspaceStatusAction } from "./actions/workspace-status";
import { errorDetails } from "./diagnostic-error";
import { logDiagnostic } from "./diagnostics";
import { workspaceService } from "./workspace-service";

declare const __ORCA_BUILD_TIME__: string;
logDiagnostic("plugin.started", {
  pid: process.pid,
  version: streamDeck.info.plugin.version,
  streamDeckVersion: streamDeck.info.application.version,
  nodeVersion: process.version,
  platform: process.platform,
  logDirectory: join(process.cwd(), "logs"),
  buildTime:
    typeof __ORCA_BUILD_TIME__ === "string" ? __ORCA_BUILD_TIME__ : "test",
});
streamDeck.devices.onDeviceDidDisconnect((ev) => {
  logDiagnostic("device.disconnected", { deviceId: ev.device.id });
  workspaceService.status.disconnect(ev.device.id);
});
streamDeck.devices.onDeviceDidConnect((ev) => {
  logDiagnostic("device.connected", { deviceId: ev.device.id });
  workspaceService.status.connect(ev.device.id);
  // 再接続時にwillAppearが来なくても、可視キーの最新設定で内部登録を復旧する。
  // 応答はSDKのdidReceiveSettings経由で扱い、離脱済みキーは復活させない。
  for (const key of ev.device.actions) {
    if (
      key.manifestId !== "com.tanaka-takuto.orca.workspace-status" ||
      !key.isKey()
    )
      continue;
    logDiagnostic("workspace.reconnect.settings-requested", {
      actionId: key.id,
    });
    void key.getSettings().catch((error: unknown) => {
      logDiagnostic("workspace.reconnect.settings-failed", {
        actionId: key.id,
        ...errorDetails(error),
      });
    });
  }
});
streamDeck.actions.registerAction(new WorkspaceStatusAction());
streamDeck.actions.registerAction(new ActiveAiInputAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new PRReviewAction());
streamDeck.actions.registerAction(new OldestPRReviewAction());
streamDeck.connect().then(
  () => {
    logDiagnostic("plugin.connected");
    // 起動引数の機器は接続済みとして扱う。SDKの初期値falseは切断通知ではない。
    for (const device of streamDeck.devices) {
      workspaceService.status.connect(device.id);
      logDiagnostic("device.registered", {
        deviceId: device.id,
        sdkConnected: device.isConnected,
      });
    }
  },
  (error: unknown) => streamDeck.logger.error(error),
);
