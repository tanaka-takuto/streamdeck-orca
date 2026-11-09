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

test("SDKのPRダイヤルと最古PRボタンが起動記録を共有し、入力・起動のみ・再押下を分ける", {
  skip: process.platform === "win32",
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orca-pr-review-sdk-"));
  const rpcPath = join(dir, "runtime.sock"),
    launches = [],
    activations = [],
    messages = [],
    sockets = new Set();
  let defaultAgent = "codex";
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
      if (request.method === "settings.getAgentLaunch") {
        socket.write(
          `${JSON.stringify({ id: request.id, ...envelope({ settings: { defaultTuiAgent: defaultAgent, disabledTuiAgents: [] } }) })}\n`,
        );
        return;
      }
      if (request.method === "worktree.activate") {
        activations.push(request.params.worktree);
        socket.write(
          `${JSON.stringify({ id: request.id, ...envelope({ worktreeId: request.params.worktree.slice(3), activated: true }) })}\n`,
        );
        return;
      }
      assert.equal(request.method, "agent.launchReplay");
      launches.push(request.params);
      socket.write(
        `${JSON.stringify({ id: request.id, ...envelope({ worktreeId: request.params.target.worktree.slice(3), outcome: { kind: "terminal", handle: `term_${launches.length}` }, ...(request.params.prompt ? { prompt: { delivery: request.params.prompt.delivery, outcome: "handed-to-terminal" } } : {}) }) })}\n`,
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
  const listPath = join(dir, "reviews.json");
  writeFileSync(listPath, JSON.stringify([1, 2]));
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
const item=n=>({updated_at:new Date(Date.UTC(2026,0,n===2?1:n+1)).toISOString(),number:n,title:'PR '+n,html_url:'https://github.com/acme/app/pull/'+n,user:{login:'author'}});
let data;
if(api==='user')data={login:'me',id:7};
else if(api==='search/issues'){const nums=JSON.parse(require('node:fs').readFileSync(${JSON.stringify(listPath)},'utf8'));const asc=args.includes('order=asc');const items=nums.map(item).sort((a,b)=>asc?a.updated_at.localeCompare(b.updated_at):b.updated_at.localeCompare(a.updated_at));data={total_count:asc?120:items.length,incomplete_results:false,items};}
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
else if(a[0]==='worktree'&&a[1]==='show'){const id=a[a.indexOf('--worktree')+1].slice(3),n=id.slice(-1);result={worktree:{id,path:'/fake/pr'+n,branch:'refs/heads/fix/'+n,hostId:'local',isArchived:false}};}
else if(a[0]==='worktree'&&a[1]==='ps')result={worktrees:[1,2,3,4].map(n=>({worktreeId:'repo::/fake/pr'+n,path:'/fake/pr'+n,displayName:'PR '+n,repo:'app',agents:[],hostId:'local',terminalVerdict:'none',status:'inactive'})),truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}};
else result={worktrees:[1,2,3,4].map(n=>({id:'repo::/fake/pr'+n,path:'/fake/pr'+n,branch:'refs/heads/fix/'+n,hostId:'local',isArchived:false})),truncated:false,hostScope:{hostIds:['local'],omittedHostIds:[]}};
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
    settings = {
      workspaceSelections: {
        legacy: { workspaceId: "keep", workspaceName: "Keep" },
      },
    },
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
  socket.send(
    JSON.stringify({
      event: "deviceDidConnect",
      device: "device",
      deviceInfo: info.devices[0],
    }),
  );
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
  assert.equal(launches[0].agent, "codex");
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
  const sendButton = (event, payload = {}) =>
    socket.send(
      JSON.stringify({
        event,
        action: "com.tanaka-takuto.orca.oldest-pr-review",
        context: "oldest",
        device: "device",
        payload,
      }),
    );
  const image = () =>
    decodeURIComponent(
      messages
        .filter((m) => m.event === "setImage" && m.context === "oldest")
        .at(-1)?.payload.image ?? "",
    );
  sendButton("willAppear", {
    controller: "Keypad",
    settings: { handoff: "none" },
  });
  await wait(() => image().includes("120件") && image().includes("#2"));
  sendButton("keyDown");
  sendButton("keyDown");
  await wait(() => image().includes("WSを開きました"));
  assert.equal(launches.length, 2);
  assert.ok(activations.includes("id:repo::/fake/pr2"));
  writeFileSync(listPath, JSON.stringify([3]));
  sendButton("didReceiveSettings", {
    settings: { handoff: "draft", body: "Button {{PR_LINK}}" },
  });
  await wait(() => image().includes("#3") && image().includes("下書き"));
  sendButton("keyDown");
  await wait(
    () =>
      launches.length === 3 &&
      Object.values(settings.prReviewLaunches ?? {}).filter(
        (r) => r.status === "accepted",
      ).length === 3,
  );
  assert.deepEqual(launches[2].prompt, {
    text: "Button https://github.com/acme/app/pull/3",
    delivery: "draft",
  });
  await wait(() => image().includes("起動受付済み"));
  sendButton("keyDown");
  await wait(() => image().includes("WSを開きました"));
  assert.equal(launches.length, 3);
  defaultAgent = "omp";
  writeFileSync(listPath, JSON.stringify([4]));
  sendButton("didReceiveSettings", { settings: { handoff: "none", body: "" } });
  await wait(() => image().includes("#4") && image().includes("AI起動のみ"));
  sendButton("keyDown");
  await wait(() => launches.length === 4 && image().includes("起動受付済み"));
  assert.equal("prompt" in launches[3], false);
  assert.equal(launches[3].agent, "omp");
  assert.deepEqual(settings.workspaceSelections, {
    legacy: { workspaceId: "keep", workspaceName: "Keep" },
  });
});
