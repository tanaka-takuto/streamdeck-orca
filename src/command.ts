import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function executable(name: string): string {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "darwin")
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs) {
    const path = join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* 次のPATHを確認 */
    }
  }
  return name;
}
export function runCommand(
  command: string,
  args: string[],
  timeout = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GH_PROMPT_DISABLED: "1",
        },
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              `${command.split(/[\\/]/u).at(-1)} の実行に失敗しました。認証・接続・Orca側の状態を確認してください。`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}
