import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildSync } from "esbuild";
import { publishRelease, releaseMetadata } from "../scripts/release.mjs";

const sha = "a".repeat(40);
const input = {
  packageVersion: "0.8.0",
  manifestVersion: "0.8.0.0",
  uuid: "com.tanaka-takuto.orca",
  runNumber: "12",
  sha,
  repository: "tanaka-takuto/streamdeck-orca",
};
test("pushごとの版と固定ダウンロード名を作り、再実行では同じ版を使う", () => {
  const meta = releaseMetadata(input);
  assert.equal(meta.version, "0.8.0.12");
  assert.equal(meta.tag, "v0.8.0.12");
  assert.equal(meta.asset, "com.tanaka-takuto.orca.streamDeckPlugin");
  assert.deepEqual(releaseMetadata(input), meta);
  assert.equal(
    releaseMetadata({ ...input, runNumber: "13" }).version,
    "0.8.0.13",
  );
  for (const invalid of [
    { runNumber: "0" },
    { runNumber: "65536" },
    { runNumber: "1\n2" },
    { runNumber: "12\n" },
    { packageVersion: "0.8.0-beta" },
    { manifestVersion: "0.7.0.0" },
    { sha: "main" },
    { repository: "../foreign" },
  ])
    assert.throws(() => releaseMetadata({ ...input, ...invalid }));
});

function fixture({
  existing,
  head = sha,
  tagSha = sha,
  latest = "v0.8.0.11",
  failRead = false,
  failUpload = false,
} = {}) {
  let release = existing
    ? {
        id: 1,
        tag_name: "v0.8.0.12",
        target_commitish: sha,
        assets: [],
        ...existing,
      }
    : undefined;
  let latestTag = latest;
  const mutations = [];
  const gh = (args) => {
    if (args[0] === "api") {
      if (failRead) throw new Error("permission denied");
      const route = args[1].replace(`repos/${input.repository}`, "");
      if (!route) return { default_branch: "main" };
      if (route === "/commits/main") return { sha: head };
      if (route === "/releases/latest")
        return latestTag ? { tag_name: latestTag } : undefined;
      if (route.startsWith("/commits/v")) return { sha: tagSha };
      if (route.startsWith("/git/ref/tags/"))
        return release ? { object: { sha: tagSha } } : undefined;
      if (route.startsWith("/releases/tags/"))
        return release?.draft ? undefined : release;
      if (route === "/releases?per_page=100") return [release ? [release] : []];
      if (route === "/releases/1") return release;
      throw new Error(`Unexpected route ${route}`);
    }
    mutations.push(args[1]);
    if (args[1] === "create")
      release = {
        id: 1,
        tag_name: "v0.8.0.12",
        draft: true,
        target_commitish: sha,
        assets: [],
      };
    if (args[1] === "upload") {
      if (failUpload) throw new Error("upload failed");
      release.assets = [
        "com.tanaka-takuto.orca.streamDeckPlugin",
        "SHA256SUMS",
      ].map((name) => ({ name, state: "uploaded", size: 10 }));
    }
    if (args[1] === "edit") {
      assert.equal(
        release.assets.length,
        2,
        "全成果物の取得成功前に公開しない",
      );
      release.draft = false;
      if (args.includes("--latest=true")) latestTag = "v0.8.0.12";
    }
    return {};
  };
  return {
    gh,
    mutations,
    get release() {
      return release;
    },
    get latest() {
      return latestTag;
    },
  };
}
test("成果物2個をdraftへアップロードしてから指定SHAのReleaseを公開する", () => {
  const f = fixture({ latest: undefined });
  publishRelease(releaseMetadata(input), { gh: f.gh });
  assert.equal(f.release.draft, false);
  assert.equal(f.release.target_commitish, sha);
  assert.equal(f.latest, "v0.8.0.12");
});
test("公開済み版の再実行ではassetを変更せず、失敗したdraftは回復する", () => {
  const uploaded = [
    "com.tanaka-takuto.orca.streamDeckPlugin",
    "SHA256SUMS",
  ].map((name) => ({ name, state: "uploaded", size: 10 }));
  const f = fixture({ existing: { draft: false, assets: uploaded } });
  publishRelease(releaseMetadata(input), { gh: f.gh });
  assert.deepEqual(f.mutations, []);
  const draft = fixture({ existing: { draft: true } });
  publishRelease(releaseMetadata(input), { gh: draft.gh });
  assert.equal(draft.release.draft, false);
  assert.ok(!draft.mutations.includes("create"));
});
test("古いSHA・別SHAのタグ・認証失敗では公開せず、より新しいLatestを巻き戻さない", () => {
  const old = fixture({ head: "b".repeat(40) });
  publishRelease(releaseMetadata(input), { gh: old.gh });
  assert.deepEqual(old.mutations, []);
  const conflict = fixture({
    existing: { draft: true },
    tagSha: "b".repeat(40),
  });
  assert.throws(
    () => publishRelease(releaseMetadata(input), { gh: conflict.gh }),
    /SHA/u,
  );
  assert.deepEqual(conflict.mutations, []);
  const denied = fixture({ failRead: true });
  assert.throws(
    () => publishRelease(releaseMetadata(input), { gh: denied.gh }),
    /permission/u,
  );
  assert.deepEqual(denied.mutations, []);
  const newer = fixture({ latest: "v0.8.0.13" });
  publishRelease(releaseMetadata(input), { gh: newer.gh });
  assert.equal(newer.latest, "v0.8.0.13");
});
test("アップロード失敗ではdraftのまま止め、不完全な公開済み版を上書きしない", () => {
  const f = fixture({ failUpload: true });
  assert.throws(
    () => publishRelease(releaseMetadata(input), { gh: f.gh }),
    /upload/u,
  );
  assert.equal(f.release.draft, true);
  assert.ok(!f.mutations.includes("edit"));
  const incomplete = fixture({ existing: { draft: false } });
  assert.throws(
    () => publishRelease(releaseMetadata(input), { gh: incomplete.gh }),
    /asset|成果物/u,
  );
  assert.deepEqual(incomplete.mutations, []);
});

test("CLIは実行とartifactを照合し、404だけを未作成として公開する", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orca-release-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "com.tanaka-takuto.orca.sdPlugin"));
  mkdirSync(join(directory, "dist"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ version: "0.8.0" }),
  );
  writeFileSync(
    join(directory, "com.tanaka-takuto.orca.sdPlugin/manifest.json"),
    JSON.stringify({ UUID: input.uuid, Version: input.manifestVersion }),
  );
  const script = resolve("scripts/release.mjs");
  const env = {
    ...process.env,
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: input.repository,
    GITHUB_RUN_NUMBER: "12",
    GITHUB_RUN_ID: "34",
  };
  execFileSync(process.execPath, [script, "prepare"], { cwd: directory, env });
  assert.equal(
    JSON.parse(
      readFileSync(
        join(directory, "com.tanaka-takuto.orca.sdPlugin/manifest.json"),
      ),
    ).Version,
    "0.8.0.12",
  );

  const meta = JSON.parse(readFileSync(join(directory, "dist/release.json")));
  const asset = Buffer.from("test-only-installer");
  writeFileSync(join(directory, "dist", meta.asset), asset);
  writeFileSync(
    join(directory, "dist/SHA256SUMS"),
    `${createHash("sha256").update(asset).digest("hex")}  ${meta.asset}\n`,
  );
  const ghPath = join(directory, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs=require('node:fs'), a=process.argv.slice(2), state=fs.existsSync('state.json')?JSON.parse(fs.readFileSync('state.json')):null;
if(a[0]==='api') {
  const route=a[1].replace('repos/${input.repository}','');
  if(!route) console.log(JSON.stringify({default_branch:'main'}));
  else if(route==='/commits/main') console.log(JSON.stringify({sha:'${sha}'}));
  else if(route.startsWith('/releases/tags/')&&state&&!state.draft) console.log(JSON.stringify(state));
  else if(route==='/releases?per_page=100') console.log(JSON.stringify(state?[[state]]:[[]]));
  else if(route==='/releases/1'&&state) console.log(JSON.stringify(state));
  else {console.log(JSON.stringify({message:'Not Found',status:'404'}));process.exit(1);}
} else {
  fs.appendFileSync('effects.log',a[1]+'\\n');
  if(a[1]==='create') fs.writeFileSync('state.json',JSON.stringify({id:1,tag_name:'v0.8.0.12',draft:true,target_commitish:'${sha}',assets:[]}));
  if(a[1]==='upload') {state.assets=['${meta.asset}','SHA256SUMS'].map(name=>({name,state:'uploaded',size:10}));fs.writeFileSync('state.json',JSON.stringify(state));}
  if(a[1]==='edit') {state.draft=false;fs.writeFileSync('state.json',JSON.stringify(state));}
}
`,
  );
  chmodSync(ghPath, 0o755);
  env.PATH = `${directory}:${process.env.PATH}`;
  env.GH_TOKEN = "test-only-token";
  execFileSync(process.execPath, [script, "publish"], { cwd: directory, env });
  assert.equal(
    JSON.parse(readFileSync(join(directory, "state.json"))).draft,
    false,
  );
  assert.equal(
    readFileSync(join(directory, "effects.log"), "utf8"),
    "create\nupload\nedit\n",
  );
  writeFileSync(join(directory, "dist", meta.asset), "tampered");
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "publish"], {
        cwd: directory,
        env,
        stdio: "pipe",
      }),
    /checksum/u,
  );
  assert.equal(
    readFileSync(join(directory, "effects.log"), "utf8"),
    "create\nupload\nedit\n",
  );
});

test("pack検証は生成物の一致に加え、インストーラー内の実行bundle欠落も拒否する", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "orca-release-verify-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plugin = `${input.uuid}.sdPlugin`;
  mkdirSync(join(directory, plugin), { recursive: true });
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ version: input.packageVersion }),
  );
  writeFileSync(
    join(directory, plugin, "manifest.json"),
    JSON.stringify({
      UUID: input.uuid,
      Version: input.manifestVersion,
      CodePath: "bin/plugin.cjs",
    }),
  );
  writeFileSync(
    join(directory, "src/plugin.ts"),
    'console.log("test fixture");',
  );
  const script = resolve("scripts/release.mjs");
  const env = {
    ...process.env,
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: input.repository,
    GITHUB_RUN_NUMBER: "12",
  };
  execFileSync(process.execPath, [script, "prepare"], { cwd: directory, env });
  buildSync({
    absWorkingDir: directory,
    entryPoints: ["src/plugin.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: `${plugin}/bin/plugin.cjs`,
    logLevel: "silent",
  });
  const archive = `dist/${input.uuid}.streamDeckPlugin`;
  execFileSync(
    "zip",
    ["-q", archive, `${plugin}/manifest.json`, `${plugin}/bin/plugin.cjs`],
    { cwd: directory },
  );
  execFileSync(process.execPath, [script, "verify"], { cwd: directory, env });
  execFileSync("zip", ["-qd", archive, `${plugin}/bin/plugin.cjs`], {
    cwd: directory,
  });
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "verify"], {
        cwd: directory,
        env,
        stdio: "pipe",
      }),
    /bundle|manifest|required|missing/u,
  );
});
