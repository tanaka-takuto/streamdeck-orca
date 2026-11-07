import streamDeck from "@elgato/streamdeck";
import { ActiveAiInputAction } from "./actions/active-ai-input";
import { AttentionAction } from "./actions/attention";
import { ChangeRadarAction } from "./actions/change-radar";
import { WorkspaceCommandAction } from "./actions/workspace-command";
import {
  WorkspaceDialAction,
  WorkspaceStatusAction,
} from "./actions/workspace-status";
import { workspaceService } from "./workspace-service";

streamDeck.actions.registerAction(new WorkspaceStatusAction());
streamDeck.actions.registerAction(new WorkspaceDialAction());
streamDeck.actions.registerAction(new WorkspaceCommandAction());
streamDeck.actions.registerAction(new ActiveAiInputAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new ChangeRadarAction());
streamDeck
  .connect()
  .then(() => workspaceService.initialize())
  .catch((error: unknown) => streamDeck.logger.error(error));
