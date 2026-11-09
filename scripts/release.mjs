import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseMetadata({
  packageVersion,
  manifestVersion,
  uuid,
  runNumber,
  sha,
  repository,
}) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(packageVersion) ||
    !new RegExp(`^${packageVersion.replaceAll(".", "\\.")}\\.\\d+$`, "u").test(
      manifestVersion,
    ) ||
    !/^[1-9]\d*$/u.test(runNumber) ||
    Number(runNumber) > 65535 ||
    !/^[a-f0-9]{40}$/u.test(sha) ||
    !/^[a-z\d][a-z\d-]*\/[\w.-]+$/iu.test(repository) ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(uuid)
  )
    throw new Error("Invalid release version, build number, SHA or repository");
  const version = `${packageVersion}.${runNumber}`;
  return {
    version,
    tag: `v${version}`,
    asset: `${uuid}.streamDeckPlugin`,
    sha,
    repository,
  };
}

function runGh(args, optional = false) {
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return args[0] === "api" ? JSON.parse(output) : undefined;
  } catch (error) {
    if (optional) {
      try {
        if (String(JSON.parse(String(error.stdout)).status) === "404")
          return undefined;
      } catch {}
    }
    throw new Error(
      `GitHub request failed: ${args[0]} ${args[1]}. ${String(error.stderr ?? error.message)}`,
    );
  }
}
function newerThan(version, tag) {
  if (!/^v?\d+\.\d+\.\d+(?:\.\d+)?$/u.test(tag)) return false;
  const previous = tag.replace(/^v/u, "").split(".").map(Number);
  const next = version.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if (next[i] !== (previous[i] ?? 0)) return next[i] > (previous[i] ?? 0);
  }
  return false;
}
/** Only complete drafts are published. Published assets are never overwritten. */
export function publishRelease(meta, { gh = runGh, directory = "dist" } = {}) {
  const get = (path, optional = false) =>
    gh(["api", `repos/${meta.repository}${path}`], optional);
  const repo = get("");
  const head = get(`/commits/${encodeURIComponent(repo.default_branch)}`);
  if (!/^[a-f0-9]{40}$/u.test(head.sha))
    throw new Error("Default branch SHA is unavailable");
  if (head.sha !== meta.sha) return "skipped: default branch has advanced";
  const ref = get(`/git/ref/tags/${meta.tag}`, true);
  if (ref && get(`/commits/${meta.tag}`).sha !== meta.sha)
    throw new Error("Release tag SHA differs from build SHA");
  const existing = get(`/releases/tags/${meta.tag}`, true);
  const complete = (release) =>
    [meta.asset, "SHA256SUMS"].every((name) =>
      release.assets?.some(
        (a) => a.name === name && a.state === "uploaded" && a.size > 0,
      ),
    );
  if (existing && !existing.draft) {
    if (!ref || !complete(existing))
      throw new Error(
        "Published release has missing assets or tag; create a new workflow run",
      );
    return "already published";
  }
  if (existing && existing.target_commitish !== meta.sha)
    throw new Error("Draft target SHA differs from build SHA");
  const latest = get("/releases/latest", true);
  const promote = !latest || newerThan(meta.version, latest.tag_name);
  const common = [meta.tag, "--repo", meta.repository];
  if (!existing)
    gh([
      "release",
      "create",
      ...common,
      "--target",
      meta.sha,
      "--draft",
      "--latest=false",
      "--title",
      `Orca ${meta.version}`,
      "--notes-file",
      join(directory, "release-notes.md"),
    ]);
  gh([
    "release",
    "upload",
    ...common,
    join(directory, meta.asset),
    join(directory, "SHA256SUMS"),
    "--clobber",
  ]);
  if (!complete(get(`/releases/tags/${meta.tag}`)))
    throw new Error("Release assets are incomplete; left as draft");
  gh(["release", "edit", ...common, "--draft=false", `--latest=${promote}`]);
  return `published ${meta.tag}`;
}

async function main(mode) {
  const pkg = JSON.parse(readFileSync("package.json"));
  const directory = "com.tanaka-takuto.orca.sdPlugin";
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  const meta = releaseMetadata({
    packageVersion: pkg.version,
    manifestVersion: manifest.Version,
    uuid: manifest.UUID,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
  });
  if (mode === "prepare") {
    mkdirSync("dist", { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, Version: meta.version }, null, 2)}\n`,
    );
    writeFileSync("dist/release.json", `${JSON.stringify(meta, null, 2)}\n`);
    return;
  }
  if (
    JSON.stringify(JSON.parse(readFileSync("dist/release.json"))) !==
    JSON.stringify(meta)
  )
    throw new Error("Release artifact does not match this workflow run");
  if (mode === "verify") {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: ["src/plugin.ts"],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      outfile: join(directory, "bin/plugin.cjs"),
      write: false,
      logLevel: "silent",
    });
    if (
      !readFileSync(result.outputFiles[0].path).equals(
        Buffer.from(result.outputFiles[0].contents),
      )
    )
      throw new Error("Packaged bundle differs from source build");
    if (manifest.Version !== meta.version)
      throw new Error("Manifest release version differs");
    const archive = join("dist", meta.asset);
    const entries = execFileSync("unzip", ["-Z1", archive], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((p) => !p.endsWith("/"));
    if (!entries.length) throw new Error("Empty plugin package");
    if (
      !entries.includes(`${directory}/manifest.json`) ||
      !entries.includes(`${directory}/${manifest.CodePath}`)
    )
      throw new Error("Required manifest or executable bundle is missing");
    for (const entry of entries) {
      if (
        !entry.startsWith(`${directory}/`) ||
        entry.split("/").includes("..") ||
        !readFileSync(entry).equals(
          execFileSync("unzip", ["-p", archive, entry], {
            maxBuffer: 20 * 1024 * 1024,
          }),
        )
      )
        throw new Error(`Package mismatch: ${entry}`);
    }
    writeFileSync(
      "dist/SHA256SUMS",
      `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${meta.asset}\n`,
    );
    console.log(
      `Verified ${entries.length} package files, source build and ${meta.version}`,
    );
  } else if (mode === "publish") {
    const expected = readFileSync("dist/SHA256SUMS", "utf8");
    const actual = `${createHash("sha256")
      .update(readFileSync(join("dist", meta.asset)))
      .digest("hex")}  ${meta.asset}\n`;
    if (actual !== expected)
      throw new Error("Downloaded installer checksum differs");
    writeFileSync(
      "dist/release-notes.md",
      `デフォルトブランチの検証済みビルドです。\n\nAssets の ${meta.asset} をダウンロードし、ダブルクリックしてインストールしてください。Stream Deck 6.9以上が必要です。\n\nVersion: ${meta.version}\nSource: https://github.com/${meta.repository}/commit/${meta.sha}\nWorkflow: https://github.com/${meta.repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n\nSHA-256は添付のSHA256SUMSで確認できます。\n`,
    );
    console.log(publishRelease(meta));
  } else
    throw new Error("Usage: node scripts/release.mjs prepare|verify|publish");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
