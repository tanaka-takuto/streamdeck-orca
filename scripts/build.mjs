import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const uuid = "com.tanaka-takuto.orca";
const directory = `${uuid}.sdPlugin`;
const pluginPath = join(root, directory);
const options = {
  absWorkingDir: root,
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: `${directory}/bin/plugin.cjs`,
  logLevel: "info",
};

if (!process.argv.includes("--watch")) {
  await build(options);
} else {
  const pluginsPath =
    process.platform === "darwin"
      ? join(
          homedir(),
          "Library/Application Support/com.elgato.StreamDeck/Plugins",
        )
      : process.platform === "win32" && process.env.APPDATA
        ? join(process.env.APPDATA, "Elgato/StreamDeck/Plugins")
        : undefined;
  let linked = false;
  if (pluginsPath) {
    try {
      linked =
        realpathSync(join(pluginsPath, directory)) === realpathSync(pluginPath);
    } catch {
      // 未インストールの場合も、先に開発用リンクを設定してもらう。
    }
  }
  if (!linked) {
    console.error(
      "開発用リンクがありません。\n" +
        "通常インストールした Orca がある場合は、Stream Deck アプリで削除してから\n" +
        "npm run link を一度実行し、npm run dev を起動してください。",
    );
    process.exit(1);
  }

  const cli = resolve(root, "node_modules/@elgato/cli/bin/streamdeck.mjs");
  const ctx = await context({
    ...options,
    sourcemap: true,
    write: false,
    plugins: [
      {
        name: "restart-stream-deck",
        setup(builder) {
          builder.onLoad({ filter: /plugin\.ts$/ }, (args) => {
            if (args.path !== join(root, "src/plugin.ts")) return;
            const watchFiles = [args.path, join(pluginPath, "manifest.json")];
            const watchDirs = [];
            function includeAssets(path) {
              watchDirs.push(path);
              if (!existsSync(path)) return;
              for (const entry of readdirSync(path, { withFileTypes: true })) {
                const entryPath = join(path, entry.name);
                if (entry.isDirectory()) includeAssets(entryPath);
                else watchFiles.push(entryPath);
              }
            }
            includeAssets(join(pluginPath, "imgs"));
            includeAssets(join(pluginPath, "ui"));
            return {
              contents: readFileSync(args.path, "utf8"),
              loader: "ts",
              watchFiles,
              watchDirs,
            };
          });
          builder.onEnd((result) => {
            if (result.errors.length > 0) return;
            for (const file of result.outputFiles) {
              mkdirSync(dirname(file.path), { recursive: true });
              writeFileSync(file.path, file.contents);
            }
            const validated = spawnSync(
              process.execPath,
              [cli, "validate", "--no-update-check", directory],
              { cwd: root, stdio: "inherit", timeout: 10_000 },
            );
            if (validated.error || validated.status !== 0) return;
            const restarted = spawnSync(
              process.execPath,
              [cli, "restart", uuid],
              {
                cwd: root,
                stdio: "inherit",
                timeout: 10_000,
              },
            );
            if (restarted.error || restarted.status !== 0) {
              console.error(
                "Orca の再起動に失敗しました。Stream Deck アプリを確認してください。",
              );
            }
          });
        },
      },
    ],
  });

  async function stop() {
    await ctx.dispose();
    process.exit(0);
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await ctx.watch();
  console.log("ソース・manifest・画像・UI を監視中。終了は Ctrl+C。");
}
