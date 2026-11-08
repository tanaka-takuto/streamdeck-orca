import streamDeck from "@elgato/streamdeck";
import type { ReviewRecord } from "./orca/review-launcher";
import type { SavedSelection } from "./workspace-selections";

export type PluginSettings = {
  workspaceSelections?: Record<string, SavedSelection>;
  prReviewLaunches?: Record<string, ReviewRecord>;
};
let writes: Promise<unknown> = Promise.resolve();
export async function readPluginSettings(): Promise<PluginSettings> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      streamDeck.settings.getGlobalSettings<PluginSettings>(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("プラグイン設定を読み込めません。")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** プラグイン内の全global設定更新を、最新値の読込から保存確認まで直列化する。 */
export function updatePluginSettings(
  update: (current: PluginSettings) => PluginSettings,
): Promise<PluginSettings> {
  const pending = writes
    .catch(() => {})
    .then(async () => {
      const next = update(await readPluginSettings());
      await streamDeck.settings.setGlobalSettings(next);
      return await readPluginSettings();
    });
  writes = pending;
  return pending;
}
