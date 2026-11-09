import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { ReviewLauncher } = await loadModule("src/orca/review-launcher.ts");
const { reviewPrompt, normalizeReviewSettings, normalizeOldestReviewSettings } =
  await loadModule("src/pr-review-settings.ts");
const pr = {
  repo: "acme/app",
  number: 12,
  title: "PR",
  url: "https://github.com/acme/app/pull/12",
  author: "author",
  branch: "fix/a",
  headRepo: "acme/app",
  baseBranch: "main",
  sha: "a".repeat(40),
};
const env = (result) => ({ ok: true, _meta: { runtimeId: "r" }, result });
function fixture({
  workspaces = true,
  dirty = false,
  fork = false,
  launchError = false,
} = {}) {
  const calls = [],
    records = {};
  const detail = { ...pr, ...(fork ? { headRepo: "fork/app" } : {}) };
  let exists = workspaces;
  const branch = fork ? "streamdeck-review/pr-12" : detail.branch;
  const ws = {
    id: "repo::/ws",
    path: "/ws",
    branch: `refs/heads/${branch}`,
    hostId: "local",
    isArchived: false,
  };
  const deps = {
    github: { detail: async () => detail },
    run: async (args) => {
      calls.push(args);
      if (args[0] === "repo")
        return env({
          repos: [
            {
              id: "repo",
              path: "/repo",
              kind: "git",
              gitRemoteIdentity: {
                canonicalKey: "github.com/acme/app",
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/app.git",
              },
            },
          ],
        });
      if (args[0] === "status")
        return env({
          capabilities: [
            "agent.launch.v2",
            "agent.launch.prompt-carry.v1",
            "agent.launch.replay-required.v1",
          ],
        });
      if (args[1] === "show") return env({ worktree: ws });
      return env({
        worktrees: exists ? [ws] : [],
        truncated: false,
        hostScope: { hostIds: ["local"], omittedHostIds: [] },
      });
    },
    git: async (path, args) => {
      calls.push(["git", path, ...args]);
      if (args[0] === "status") return dirty ? " M file.ts\n" : "";
      if (args[0] === "symbolic-ref") return branch;
      if (args[0] === "remote") return "git@github.com:acme/app.git";
      return pr.sha;
    },
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === "settings.getAgentLaunch")
        return env({
          settings: { defaultTuiAgent: "codex", disabledTuiAgents: [] },
        });
      if (method === "worktree.create") {
        exists = true;
        return env({ worktree: ws });
      }
      if (launchError) throw new Error("connection lost");
      return env({
        worktreeId: ws.id,
        outcome: { kind: "terminal", handle: "term_new" },
        prompt: {
          delivery: params.prompt.delivery,
          outcome: "handed-to-terminal",
        },
      });
    },
    readRecords: async () => records,
    saveRecord: async (key, value) => {
      records[key] = value;
    },
    focus: async (id) => {
      calls.push(["focus", id]);
      return true;
    },
  };
  return { launcher: new ReviewLauncher(deps), calls, records, detail, deps };
}
test("両PRアクションはOrca既定を初期値にし、明示したAIを保持する", () => {
  for (const normalize of [
    normalizeReviewSettings,
    normalizeOldestReviewSettings,
  ]) {
    assert.equal(normalize({}).agent, "default");
    for (const agent of ["default", "codex", "claude"])
      assert.equal(normalize({ agent }).agent, agent);
  }
});
test("Orca既定は起動時に取得したAIを使い、起動直前にも再照合する", async () => {
  const f = fixture();
  const original = f.deps.rpc;
  let reads = 0;
  f.deps.rpc = async (method, ...args) => {
    if (method === "settings.getAgentLaunch") {
      ++reads;
      return env({
        settings: { defaultTuiAgent: "omp", disabledTuiAgents: [] },
      });
    }
    return original(method, ...args);
  };
  const result = await f.launcher.launch(pr, 7, {
    agent: "default",
    body: "review",
  });
  assert.equal(result.status, "accepted");
  assert.equal(reads, 2);
  assert.equal(
    f.calls.find(([name]) => name === "agent.launchReplay")[1].agent,
    "omp",
  );
});
test("明示したCodex・ClaudeではOrca既定を読まず、指定をそのまま使う", async () => {
  for (const agent of ["codex", "claude"]) {
    const f = fixture();
    await f.launcher.launch(pr, 7, { agent, body: "review" });
    assert.equal(
      f.calls.find(([name]) => name === "agent.launchReplay")[1].agent,
      agent,
    );
    assert.ok(!f.calls.some(([name]) => name === "settings.getAgentLaunch"));
  }
});
test("Orca既定の未設定・通常端末・無効化・不正値・取得失敗ではAIを起動しない", async () => {
  for (const value of [
    null,
    "blank",
    "",
    "codex;echo",
    { id: "codex" },
    "disabled",
    "unavailable",
    "runtime-change",
  ]) {
    const f = fixture();
    const original = f.deps.rpc;
    f.deps.rpc = async (method, ...args) => {
      if (method !== "settings.getAgentLaunch")
        return original(method, ...args);
      if (value === "unavailable") throw new Error("connection failed");
      const response = env({
        settings: {
          defaultTuiAgent: value === "disabled" ? "codex" : value,
          disabledTuiAgents: value === "disabled" ? ["codex"] : [],
        },
      });
      if (value === "runtime-change") response._meta.runtimeId = "other";
      return response;
    };
    await assert.rejects(
      f.launcher.launch(pr, 7, { agent: "default", body: "review" }),
      /既定|デフォルト|実行環境/u,
    );
    assert.ok(
      !f.calls.some(
        ([name]) => name === "agent.launchReplay" || name === "worktree.create",
      ),
    );
    assert.equal(Object.values(f.records).filter(Boolean).length, 0);
  }
});
test("準備中にOrca既定が変われば別AIへ差し替えず起動を中止する", async () => {
  const f = fixture();
  const original = f.deps.rpc;
  let reads = 0;
  f.deps.rpc = async (method, ...args) =>
    method === "settings.getAgentLaunch"
      ? env({
          settings: {
            defaultTuiAgent: ++reads === 1 ? "codex" : "omp",
            disabledTuiAgents: [],
          },
        })
      : original(method, ...args);
  await assert.rejects(
    f.launcher.launch(pr, 7, { agent: "default", body: "review" }),
    /既定|デフォルト/u,
  );
  assert.ok(!f.calls.some(([name]) => name === "agent.launchReplay"));
});
test("起動済みPRの再押下はOrca既定を取得できなくてもWSだけを開く", async () => {
  const f = fixture();
  await f.launcher.launch(pr, 7, { agent: "codex", body: "review" });
  f.deps.rpc = async () => {
    throw new Error("既定AIを取得できません");
  };
  const result = await f.launcher.launch(
    pr,
    7,
    { agent: "default", body: "review" },
    () => true,
    "asc",
  );
  assert.equal(result.status, "opened");
  assert.equal(
    f.calls.filter(([name]) => name === "agent.launchReplay").length,
    1,
  );
});
test("既存の対象ブランチWSを再利用して新規AIへ複数行をdraftで渡す", async () => {
  const f = fixture();
  const r = await f.launcher.launch(pr, 7, {
    body: "review\n{{pr_url}}",
    enter: false,
  });
  assert.equal(r.status, "accepted");
  assert.equal(f.calls.filter((a) => a[0] === "worktree.create").length, 0);
  const [, launch] = f.calls.find((a) => a[0] === "agent.launchReplay");
  assert.equal(launch.target.worktree, "id:repo::/ws");
  assert.deepEqual(launch.prompt, {
    text: `review\n${pr.url}`,
    delivery: "draft",
  });
});
test("WSがなければPRのheadから作成し、設定したEnterを送る", async () => {
  const f = fixture({ workspaces: false });
  await f.launcher.launch(pr, 7, { body: "review", enter: true });
  const [, create] = f.calls.find((a) => a[0] === "worktree.create");
  assert.equal(create.branchNameOverride, pr.branch);
  assert.ok(create.baseBranch.startsWith("refs/streamdeck-orca/"));
  const [, launch] = f.calls.find((a) => a[0] === "agent.launchReplay");
  assert.equal(launch.prompt.delivery, "submit");
});
test("forkの同名ブランチを本体のWSとして再利用しない", async () => {
  const f = fixture({ workspaces: false, fork: true });
  await f.launcher.launch(pr, 7, { body: "review" });
  assert.equal(
    f.calls.find((a) => a[0] === "worktree.create")[1].branchNameOverride,
    "streamdeck-review/pr-12",
  );
});
test("未コミット変更があるWSではAIを起動しない", async () => {
  const f = fixture({ dirty: true });
  await assert.rejects(
    f.launcher.launch(pr, 7, { body: "review" }),
    /未コミット/,
  );
  assert.ok(!f.calls.some((a) => a[0] === "agent.launchReplay"));
});
test("同じPRの連打と起動済みPRの再押下でAIを重複起動しない", async () => {
  const f = fixture();
  await Promise.all([
    f.launcher.launch(pr, 7, { body: "review" }),
    f.launcher.launch(pr, 7, { body: "review" }),
  ]);
  await f.launcher.launch(pr, 7, { body: "review" });
  assert.equal(f.calls.filter((a) => a[0] === "agent.launchReplay").length, 1);
});
test("応答消失後は起動記録を残し、自動・再押下で再起動しない", async () => {
  const f = fixture({ launchError: true });
  await f.launcher.launch(pr, 7, { body: "review" });
  await f.launcher.launch(pr, 7, { body: "review" });
  assert.equal(f.calls.filter((a) => a[0] === "agent.launchReplay").length, 1);
  assert.equal(Object.values(f.records)[0].status, "unknown");
});
test("プレースホルダーは一度だけ置換し、制御文字は拒否する", () => {
  assert.equal(
    reviewPrompt("{{branch}}", { ...pr, branch: "{{repo}}" }),
    "{{repo}}",
  );
  assert.throws(() => reviewPrompt("x\x1b", pr));
});
test("既存WSでも実際のGitリモートが変わっていたら再利用しない", async () => {
  const f = fixture(),
    original = f.deps.git;
  f.deps.git = async (path, args) =>
    args[0] === "remote"
      ? "git@github.com:other/repo.git"
      : original(path, args);
  const launcher = new ReviewLauncher(f.deps);
  await assert.rejects(
    launcher.launch(pr, 7, { body: "review" }),
    /リポジトリ/,
  );
  assert.ok(!f.calls.some((c) => c[0] === "agent.launchReplay"));
});
test("GitHub再確認の間にWSが変更されたらAIを起動しない", async () => {
  const f = fixture();
  let changed = false,
    checks = 0;
  const original = f.deps.git;
  f.deps.github.detail = async () => {
    if (++checks === 2) changed = true;
    return f.detail;
  };
  f.deps.git = async (path, args) =>
    args[0] === "status" && changed ? " M changed.ts" : original(path, args);
  await assert.rejects(
    new ReviewLauncher(f.deps).launch(pr, 7, { body: "review" }),
    /未コミット/,
  );
  assert.ok(!f.calls.some((c) => c[0] === "agent.launchReplay"));
});
test("plugin再起動後も結果不明の起動記録から重複起動しない", async () => {
  const f = fixture({ launchError: true });
  await f.launcher.launch(pr, 7, { body: "review" });
  const result = await new ReviewLauncher(f.deps).launch(pr, 7, {
    body: "review",
  });
  assert.equal(result.status, "unknown");
  assert.equal(f.calls.filter((a) => a[0] === "agent.launchReplay").length, 1);
});
test("起動済みWSを別ブランチに切り替えた場合はそのPRとして開かない", async () => {
  const f = fixture();
  await f.launcher.launch(pr, 7, { body: "review" });
  const original = f.deps.git;
  f.deps.git = async (path, args) =>
    args[0] === "symbolic-ref" ? "different-branch" : original(path, args);
  await assert.rejects(
    new ReviewLauncher(f.deps).launch(pr, 7, { body: "review" }),
    /ブランチ|HEAD/,
  );
  assert.ok(!f.calls.some((a) => a[0] === "focus"));
});
test("PR_LINKエイリアスを空白付きでも一度だけ展開する", () => {
  assert.equal(
    reviewPrompt("Review {{ PR_LINK }}\n{{pr_url}}", pr),
    `Review ${pr.url}\n${pr.url}`,
  );
});
test("起動だけでは空本文を許容してpromptを一切渡さず、再押下で重複起動しない", async () => {
  const f = fixture();
  const original = f.deps.rpc;
  f.deps.rpc = async (method, params) => {
    if (method === "settings.getAgentLaunch") return original(method, params);
    f.calls.push([method, params]);
    return env({
      worktreeId: "repo::/ws",
      outcome: { kind: "structured", handle: "chat" },
    });
  };
  const result = await f.launcher.launch(pr, 7, { handoff: "none", body: "" });
  assert.equal(result.status, "accepted");
  const params = f.calls.find((a) => a[0] === "agent.launchReplay")[1];
  assert.equal("prompt" in params, false);
  assert.equal(
    (await f.launcher.launch(pr, 7, { handoff: "none", body: "" })).status,
    "opened",
  );
  assert.equal(f.calls.filter((a) => a[0] === "agent.launchReplay").length, 1);
});
test("現行statusのruntime.capabilitiesでも起動対応を確認する", async () => {
  const f = fixture(),
    run = f.deps.run;
  f.deps.run = async (a) => {
    const value = await run(a);
    if (a[0] === "status")
      return env({ runtime: { capabilities: value.result.capabilities } });
    return value;
  };
  assert.equal(
    (await f.launcher.launch(pr, 7, { body: "review" })).status,
    "accepted",
  );
});
test("最古ボタンの検証検索にも昇順を渡し、再利用focusへ取消ガードを渡す", async () => {
  const f = fixture(),
    orders = [];
  f.deps.github.detail = async (_pr, _mode, _account, order) => {
    orders.push(order);
    return f.detail;
  };
  await f.launcher.launch(pr, 7, { body: "review" }, () => true, "asc");
  assert.deepEqual(orders, ["asc", "asc"]);
  let guard,
    current = true;
  f.deps.focus = async (_id, check) => {
    guard = check;
    return true;
  };
  await f.launcher.launch(pr, 7, { body: "review" }, () => current, "asc");
  assert.equal(typeof guard, "function");
  current = false;
  assert.equal(guard(), false);
});
test("最古ボタンは同じPRのSHAが変わりWSを更新済みでもAIを重複起動しない", async () => {
  const f = fixture();
  await f.launcher.launch(pr, 7, { body: "review" }, () => true, "asc");
  const next = { ...pr, sha: "b".repeat(40) };
  f.deps.github.detail = async () => next;
  const git = f.deps.git;
  f.launcher.git = async (path, args) =>
    args[0] === "rev-parse" ? next.sha : git(path, args);
  const r = await f.launcher.launch(
    pr,
    7,
    { body: "review" },
    () => true,
    "asc",
  );
  assert.equal(r.status, "opened");
  assert.equal(f.calls.filter((a) => a[0] === "agent.launchReplay").length, 1);
});
