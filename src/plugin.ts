import streamDeck from "@elgato/streamdeck";
import { ActiveAiInputAction } from "./actions/active-ai-input";
import { AttentionAction } from "./actions/attention";
import { ChangeRadarAction } from "./actions/change-radar";
import { PRReviewAction } from "./actions/pr-review";
import { WorkspaceCommandAction } from "./actions/workspace-command";
import { WorkspaceStatusAction } from "./actions/workspace-status";
import { workspaceService } from "./workspace-service";

streamDeck.devices.onDeviceDidDisconnect((ev) =>
  workspaceService.status.disconnect(ev.device.id),
);
streamDeck.actions.registerAction(new WorkspaceStatusAction());
streamDeck.actions.registerAction(new WorkspaceCommandAction());
streamDeck.actions.registerAction(new ActiveAiInputAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new ChangeRadarAction());
streamDeck.actions.registerAction(new PRReviewAction());
streamDeck
  .connect()
  .then(() => workspaceService.initialize())
  .catch((error: unknown) => streamDeck.logger.error(error));
