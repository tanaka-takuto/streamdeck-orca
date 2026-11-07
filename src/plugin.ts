import streamDeck from "@elgato/streamdeck";
import {
  WorkspaceDialAction,
  WorkspaceStatusAction,
} from "./actions/workspace-status";
import { workspaceService } from "./workspace-service";

streamDeck.actions.registerAction(new WorkspaceStatusAction());
streamDeck.actions.registerAction(new WorkspaceDialAction());
streamDeck
  .connect()
  .then(() => workspaceService.initialize())
  .catch((error: unknown) => streamDeck.logger.error(error));
