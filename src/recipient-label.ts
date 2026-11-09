import { shorten } from "./key-text";
import type { AgentTarget } from "./orca/agent-directory";
/** A location is the identity cue: never abbreviate it into another leaf's cue. */
export const locationFitsKey = (location: string | undefined): boolean =>
  !!location && shorten(location, 12) === location;
export const recipientLine = (
  target: Pick<AgentTarget, "identity" | "location">,
) => `${shorten(target.identity, 7)} · ${target.location ?? ""}`;
