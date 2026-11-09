import streamDeck from "@elgato/streamdeck";
import { ActiveAiInputAction } from "./actions/active-ai-input";
import { AttentionAction } from "./actions/attention";
import { PRReviewAction } from "./actions/pr-review";
import { WorkspaceStatusAction } from "./actions/workspace-status";
import { workspaceService } from "./workspace-service";

streamDeck.devices.onDeviceDidDisconnect((ev) =>
  workspaceService.status.disconnect(ev.device.id),
);
streamDeck.actions.registerAction(new WorkspaceStatusAction());
streamDeck.actions.registerAction(new ActiveAiInputAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new PRReviewAction());
streamDeck.connect().catch((error: unknown) => streamDeck.logger.error(error));
