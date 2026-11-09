import { runCommand } from "./command";
import { GitHubReviews } from "./github/reviews";
import { OrcaClient, resolveOrcaCommand } from "./orca/client";
import { createLocalRpc } from "./orca/local-rpc";
import { ReviewLauncher, type ReviewRecord } from "./orca/review-launcher";
import { readPluginSettings, updatePluginSettings } from "./plugin-settings";

export async function readReviewRecords() {
  return (await readPluginSettings()).prReviewLaunches ?? {};
}
async function saveRecord(
  key: string,
  value: ReviewRecord | undefined,
): Promise<void> {
  const saved = (
    await updatePluginSettings((current) => {
      const next = { ...current.prReviewLaunches };
      if (value) next[key] = { ...value };
      else delete next[key];
      return { ...current, prReviewLaunches: next };
    })
  ).prReviewLaunches?.[key];
  if (
    value
      ? saved?.operationId !== value.operationId ||
        saved?.status !== value.status
      : saved !== undefined
  )
    throw new Error(
      "起動記録の保存を確認できません。Orca側を確認してください。",
    );
}
const command = resolveOrcaCommand();
const run = async (args: string[]) =>
  JSON.parse(await runCommand(command, args));
export const reviewGitHub = new GitHubReviews();
const client = new OrcaClient(run);
export const reviewLauncher = new ReviewLauncher({
  github: reviewGitHub,
  run,
  rpc: createLocalRpc(),
  readRecords: readReviewRecords,
  saveRecord,
  focus: (id, current) => client.focusWorkspace(id, current),
});
