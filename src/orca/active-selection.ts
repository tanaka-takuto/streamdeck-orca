export type ActiveSelection = {
  runtimeId: string;
  workspaceId: string;
  paneKey: string;
};

export type ActiveSelectionReader = () => Promise<ActiveSelection>;

export function parseActiveSelection(
  state: unknown,
  runtimeId: string,
): ActiveSelection {
  const session = object(state);
  const workspaceId = session.activeWorktreeId;
  const tabId = session.activeTabId;
  if (
    !runtimeId ||
    typeof workspaceId !== "string" ||
    !workspaceId ||
    session.activeWorkspaceKey !== `worktree:${workspaceId}` ||
    (session.activeWorkspaceExecutionHostId != null &&
      session.activeWorkspaceExecutionHostId !== "local") ||
    typeof tabId !== "string" ||
    !tabId ||
    object(session.activeTabTypeByWorktree)[workspaceId] !== "terminal" ||
    object(session.activeTabIdByWorktree)[workspaceId] !== tabId
  )
    throw new Error(
      "Orca で入力先のローカル AI ターミナルを選択してください。",
    );
  const tabs = object(session.tabsByWorktree)[workspaceId];
  const layout = object(object(session.terminalLayoutsByTabId)[tabId]);
  if (
    !Array.isArray(tabs) ||
    !tabs.some((row) => object(row).id === tabId) ||
    typeof layout.activeLeafId !== "string" ||
    !layout.activeLeafId
  )
    throw new Error("選択中の AI ターミナルのペインを確認できません。");
  return { runtimeId, workspaceId, paneKey: `${tabId}:${layout.activeLeafId}` };
}

const execFileAsync = promisify(execFile);
/** Orca 1.4.229 のプロファイル保存状態を参照する。DB は読み取り専用で開く。 */
export function createActiveSelectionReader(
  options: {
    directory?: string;
    query?: (database: string) => Promise<string>;
  } = {},
): ActiveSelectionReader {
  const directory =
    options.directory ??
    process.env.ORCA_USER_DATA_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/orca")
      : process.platform === "win32"
        ? join(process.env.APPDATA ?? homedir(), "orca")
        : join(
            process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
            "orca",
          ));
  const read = (name: string) =>
    object(JSON.parse(readFileSync(join(directory, name), "utf8")));
  const query =
    options.query ??
    (async (database) => {
      if (process.platform === "win32")
        throw new Error(
          "アクティブ AI への入力は現在 macOS / Linux に対応しています。",
        );
      const { stdout } = await execFileAsync(
        process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3",
        [
          "-readonly",
          "-json",
          database,
          "SELECT payload FROM profile_state_documents WHERE domain='workspaceSession';",
        ],
        { timeout: 2_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      );
      return stdout;
    });
  return async () => {
    try {
      const metadata = read("orca-runtime.json");
      const index = read("orca-profile-index.json");
      const profileId = index.activeProfileId;
      if (
        typeof metadata.runtimeId !== "string" ||
        !metadata.runtimeId ||
        typeof profileId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(profileId) ||
        !Array.isArray(index.profiles) ||
        !index.profiles.some((row) => object(row).id === profileId)
      )
        throw new Error();
      const rows: unknown = JSON.parse(
        await query(join(directory, "profiles", profileId, "profile-state.db")),
      );
      if (
        !Array.isArray(rows) ||
        rows.length !== 1 ||
        read("orca-runtime.json").runtimeId !== metadata.runtimeId ||
        read("orca-profile-index.json").activeProfileId !== profileId
      )
        throw new Error();
      const payload = object(rows[0]).payload;
      if (typeof payload !== "string") throw new Error();
      return parseActiveSelection(JSON.parse(payload), metadata.runtimeId);
    } catch {
      // DB、メタデータ、実行内容をログへ出さない。
      throw new Error(
        "Orca の選択状態を確認できません。ローカル AI ターミナルを選択してください。macOS / Linux の sqlite3 が必要です。",
      );
    }
  };
}

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { object } from "./model";
