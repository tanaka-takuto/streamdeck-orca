import streamDeck from "@elgato/streamdeck";
import { WorkspaceCommandAction } from "./actions/workspace-command";
import {
  WorkspaceDialAction,
  WorkspaceStatusAction,
} from "./actions/workspace-status";
import { workspaceService } from "./workspace-service";

streamDeck.actions.registerAction(new WorkspaceStatusAction());
streamDeck.actions.registerAction(new WorkspaceDialAction());
streamDeck.actions.registerAction(new WorkspaceCommandAction());
streamDeck
  .connect()
  .then(() => workspaceService.initialize())
  .catch((error: unknown) => streamDeck.logger.error(error));
