import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

test("SDKのダイヤル選択から対象PRの新規AI起動・draft/Enter・永続記録までつながる", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orca-pr-review-sdk-"));
  const rpcPath = join(dir, "runtime.sock"),
    launches = [],
    messages = [],
    sockets = new Set();
  const envelope = (result) => ({
    ok: true,
    _meta: { runtimeId: "runtime" },
    result,
  });
  const rpc = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      if (!pending.includes("\n")) return;
      const request = JSON.parse(pending.split("\n")[0]);
      assert.equal(request.authToken, "test-only-token");
      assert.equal(request.method, "agent.launchReplay");
      launches.push(request.params);
      socket.write(
        `${JSON.stringify({ id: request.id, ...envelope({ worktreeId: request.params.target.worktree.slice(3), outcome: { kind: "terminal", handle: `term_${launches.length}` }, prompt: { delivery: request.params.prompt.delivery, outcome: "handed-to-terminal" } }) })}\n`,
      );
    });
  });
  rpc.listen(rpcPath);
  await once(rpc, "listening");
  writeFileSync(
    join(dir, "orca-runtime.json"),
    JSON.stringify({
      runtimeId: "runtime",
      authToken: "test-only-token",
      transport: { kind: "unix", endpoint: rpcPath },
    }),
  );
  const sha = "a".repeat(40);
  const writeCommand = (name, source) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/usr/bin/env node\n${source}`);
    chmodSync(path, 0o755);
    return path;
  };
  writeCommand(
    "gh",
    `
const args=process.argv.slice(2), api=args[1];
const item=n=>({number:n,title:'PR '+n,html_url:'https://github.com/acme/app/pull/'+n,user:{login:'author'}});
let data;
if(api==='user')data={login:'me',id:7};
else if(api==='search/issues')data={total_count:2,incomplete_results:false,items:[item(1),item(2)]};
else {const n=Number(api.split('/').at(-1));data={...item(n),state:'open',merged:false,requested_reviewers:[{login:'me',id:7}],requested_teams:[],head:{sha:'${sha}',ref:'fix/'+n,repo:{full_name:'acme/app'}},base:{ref:'main',repo:{full_name:'acme/app'}}};}
console.log(JSON.stringify(data));`,
  );
  writeCommand(
    "git",
    `const a=process.argv.slice(2);const command=a[2];console.log(command==='remote'?'git@github.com:acme/app.git':command==='symbolic-ref'?'fix/'+a[1].slice(-1):command==='rev-parse'?'${sha}':'');`,
  );
  const orca = writeCommand(
    "orca-test",
    `
const a=process.argv.slice(2);let result;
if(a[0]==='status')result={capabilities:['agent.launch.v2','agent.launch.prompt-carry.v1','agent.launch.replay-required.v1']};
else if(a[0]==='repo')result={repos:[{id:'repo',path:'/fake/repo',kind:'git',gitRemoteIdentity:{canonicalKey:'github.com/acme/app',remoteName:'origin'}}]};
else result={worktrees:[1,2].map(n=>({id:'repo::/fake/pr'+n,path:'/fake/pr'+n,branch:'refs/heads/fix/'+n,hostId:'local',isArchived:false})),truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}};
console.log(JSON.stringify({ok:true,_meta:{runtimeId:'runtime'},result}));`,
  );
  writeFileSync(
    join(dir, "manifest.json"),
    readFileSync("com.tanaka-takuto.orca.sdPlugin/manifest.json"),
  );
  await build({
    entryPoints: ["src/plugin.ts"],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: join(dir, "plugin.cjs"),
    logLevel: "silent",
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let socket,
    settings = {},
    stderr = "";
  server.on("connection", (s) => {
    socket = s;
    s.on("message", (raw) => {
      const m = JSON.parse(raw);
      messages.push(m);
      if (m.event === "getGlobalSettings")
        s.send(
          JSON.stringify({
            event: "didReceiveGlobalSettings",
            payload: { settings },
          }),
        );
      if (m.event === "setGlobalSettings") settings = m.payload;
    });
  });
  const info = {
    application: {
      version: "7.6.1",
      platform: "mac",
      platformVersion: "14.0",
      language: "ja",
      font: "Arial",
    },
    plugin: { uuid: "com.tanaka-takuto.orca", version: "0.8.0.0" },
    devices: [
      {
        id: "device",
        name: "Stream Deck +",
        type: 7,
        size: { columns: 4, rows: 2 },
      },
    ],
  };
  const child = spawn(
    process.execPath,
    [
      join(dir, "plugin.cjs"),
      "-port",
      String(server.address().port),
      "-pluginUUID",
      "test-plugin",
      "-registerEvent",
      "registerPlugin",
      "-info",
      JSON.stringify(info),
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ORCA_CLI_COMMAND: orca,
        ORCA_USER_DATA_PATH: dir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (s) => {
    stderr += s;
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    for (const s of server.clients) s.terminate();
    await new Promise((r) => server.close(r));
    for (const s of sockets) s.destroy();
    await new Promise((r) => rpc.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const wait = async (predicate) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (child.exitCode !== null) throw new Error(stderr);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout: ${stderr}`);
  };
  const send = (event, payload = {}) =>
    socket.send(
      JSON.stringify({
        event,
        action: "com.tanaka-takuto.orca.pr-review",
        context: "review",
        device: "device",
        payload,
      }),
    );
  const feedback = () =>
    messages
      .filter((m) => m.event === "setFeedback" && m.context === "review")
      .at(-1)?.payload;
  await wait(() => messages.some((m) => m.event === "registerPlugin"));
  send("willAppear", {
    controller: "Encoder",
    settings: { body: "Review\n{{pr_url}}", enter: false },
  });
  await wait(() => feedback()?.pr?.startsWith("#1"));
  send("dialRotate", { ticks: 1, pressed: false });
  await wait(() => feedback()?.pr?.startsWith("#2"));
  send("dialDown", { pressed: true });
  send("dialDown", { pressed: true });
  await wait(() =>
    Object.values(settings.prReviewLaunches ?? {}).some(
      (r) => r.status === "accepted",
    ),
  );
  assert.equal(launches.length, 1);
  assert.equal(launches[0].target.worktree, "id:repo::/fake/pr2");
  assert.deepEqual(launches[0].prompt, {
    text: "Review\nhttps://github.com/acme/app/pull/2",
    delivery: "draft",
  });
  await wait(() => feedback()?.operation?.includes("起動受付"));
  send("didReceiveSettings", {
    settings: { body: "Enter {{pr_number}}", enter: true },
  });
  await wait(
    () =>
      feedback()?.pr?.startsWith("#1") && feedback()?.input?.includes("Enter"),
  );
  send("dialDown", { pressed: true });
  await wait(
    () =>
      Object.values(settings.prReviewLaunches ?? {}).filter(
        (r) => r.status === "accepted",
      ).length === 2,
  );
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[1].prompt, { text: "Enter 1", delivery: "submit" });
});
