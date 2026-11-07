import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { WorkspaceExecutor } = await loadModule("src/orca/execution.ts");
const scope = { hostIds: ["local"], omittedHostIds: [] };
const snapshot = {
  runtimeId: "r",
  truncated: false,
  workspaces: [
    {
      id: "repo::/a",
      name: "A",
      path: "/a",
      hostId: "local",
      agents: [],
      activity: "active",
      terminalVerdict: "live",
    },
  ],
};
const response = (result, runtimeId = "r") => ({
  ok: true,
  _meta: { runtimeId },
  result,
});
const agent = (id = "one", extra = {}) => ({
  handle: `term_${id}`,
  incarnationId: `inc_${id}`,
  worktreeId: "repo::/a",
  executionHostId: "local",
  connected: true,
  writable: true,
  orphaned: false,
  agentIdentity: "codex",
  title: id,
  ...extra,
});
function fixture(rows = [agent()]) {
  const calls = [];
  let result;
  const executor = new WorkspaceExecutor(
    { snapshot: async () => snapshot },
    async (args) => {
      calls.push(args);
      if (args[1] === "list")
        return response({
          hostScope: scope,
          truncated: false,
          terminals: rows,
        });
      if (result instanceof Error) throw result;
      return (
        result ??
        (args[1] === "create"
          ? response({
              terminal: { handle: "new_shell", worktreeId: "repo::/a" },
            })
          : response({
              send: {
                handle: args[args.indexOf("--terminal") + 1],
                accepted: true,
                prompt: { requestId: "request", stages: ["input_accepted"] },
              },
            }))
      );
    },
  );
  return {
    executor,
    calls,
    setResult(value) {
      result = value;
    },
  };
}

test("シェルは対象ワークスペースの新しい実行用ターミナルへ、入力内容を一つの引数で渡す", async () => {
  const f = fixture();
  const body = 'npm test && echo "$HOME"\necho done';
  const result = await f.executor.execute("repo::/a", {
    mode: "shell",
    body,
    label: "テスト",
  });
  assert.equal(result.status, "accepted");
  const args = f.calls.at(-1);
  assert.deepEqual(args, [
    "terminal",
    "create",
    "--worktree",
    "id:repo::/a",
    "--title",
    "テスト",
    "--command",
    body,
    "--focus",
    "--json",
  ]);
  assert.equal(
    f.calls.some((args) => args[1] === "send"),
    false,
  );
});

test("AI が一つならそのセッションだけへ登録した指示を一回送る", async () => {
  const f = fixture();
  const result = await f.executor.execute("repo::/a", {
    mode: "ai",
    body: "変更をレビューして",
  });
  assert.equal(result.status, "accepted");
  assert.equal(result.requestId, "request");
  assert.deepEqual(f.calls.at(-1), [
    "terminal",
    "send",
    "--terminal",
    "term_one",
    "--text",
    "変更をレビューして",
    "--enter",
    "--json",
  ]);
});

test("自動クローズ指定時は、exit を含むスクリプトの終了コードを確実に出力する", async () => {
  for (const code of [0, 7]) {
    const f = fixture();
    await f.executor.execute("repo::/a", {
      mode: "shell",
      body: `printf '%s\\n' "quote: ' \\$HOME"; exit ${code}`,
      closeOnSuccess: true,
    });
    const args = f.calls.find((args) => args[1] === "create");
    const command = args[args.indexOf("--command") + 1];
    const output = execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, SHELL: "/bin/sh" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /quote: ' \$HOME/u);
    assert.match(output, new RegExp(`__ORCA_COMMAND_[a-f0-9]+:${code}__`));
  }
});

test("AI モードではターミナルの自動クローズ設定を適用しない", async () => {
  const f = fixture();
  await f.executor.execute("repo::/a", {
    mode: "ai",
    body: "変更をレビューして",
    closeOnExit: true,
    closeOnSuccess: true,
  });
  assert.equal(f.calls.at(-1)[1], "send");
  assert.equal(f.calls.at(-1)[5], "変更をレビューして");
});

test("起動したシェルの完了を追跡して閉じ、受付結果にも終了コードを反映する", async () => {
  const calls = [];
  let marker;
  const terminal = {
    handle: "created-shell",
    incarnationId: "created-process",
    worktreeId: "repo::/a",
    executionHostId: "local",
  };
  const executor = new WorkspaceExecutor(
    { snapshot: async () => snapshot },
    async (args) => {
      calls.push(args);
      if (args[1] === "create") {
        marker = args[args.indexOf("--command") + 1].match(
          /__ORCA_COMMAND_[a-f0-9]+/u,
        )[0];
        return response({ terminal });
      }
      if (args[1] === "read")
        return response({
          terminal: { handle: terminal.handle, tail: [`${marker}:0__`] },
        });
      if (args[1] === "show") return response({ terminal });
      return response({ close: { handle: terminal.handle, ptyKilled: true } });
    },
  );
  const result = await executor.execute("repo::/a", {
    mode: "shell",
    body: "exit 0",
    closeOnExit: true,
    closeOnSuccess: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.status, "accepted");
  assert.match(result.message, /終了コード 0.*閉じました/u);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["create", "read", "show", "close"],
  );
});

test("複数 AI では自動で選ばず、指定したワークスペース・ランタイム・プロセスの一致した相手へ送る", async () => {
  const f = fixture([agent("one"), agent("two")]);
  await assert.rejects(
    f.executor.execute("repo::/a", { mode: "ai", body: "指示" }),
    /複数|送信先/u,
  );
  const target = {
    handle: "term_two",
    runtimeId: "r",
    incarnationId: "inc_two",
    identity: "codex",
  };
  const result = await f.executor.execute("repo::/a", {
    mode: "ai",
    body: "指示",
    agentTargets: { "repo::/a": target },
  });
  assert.equal(result.status, "accepted");
  assert.equal(f.calls.at(-1)[3], "term_two");
});

for (const [name, rows, target] of [
  ["AI 不在", [agent("shell", { agentIdentity: undefined })], undefined],
  [
    "別ワークスペース",
    [agent("one", { worktreeId: "repo::/other" })],
    undefined,
  ],
  ["切断", [agent("one", { connected: false })], undefined],
  [
    "別ランタイム",
    [agent()],
    { handle: "term_one", runtimeId: "old", incarnationId: "inc_one" },
  ],
  [
    "再起動したプロセス",
    [agent()],
    { handle: "term_one", runtimeId: "r", incarnationId: "old" },
  ],
  [
    "別のAIに変わった端末",
    [agent("one", { agentIdentity: "claude" })],
    {
      handle: "term_one",
      runtimeId: "r",
      incarnationId: "inc_one",
      identity: "codex",
    },
  ],
])
  test(`${name}には送信しない`, async () => {
    const f = fixture(rows);
    await assert.rejects(
      f.executor.execute("repo::/a", {
        mode: "ai",
        body: "指示",
        agentTargets: target ? { "repo::/a": target } : undefined,
      }),
    );
    assert.equal(
      f.calls.some((args) => args[1] === "send"),
      false,
    );
  });

test("空の内容・不明なモード・消失したワークスペースでは実行しない", async () => {
  const f = fixture();
  for (const settings of [
    { mode: "shell", body: " " },
    { mode: "other", body: "x" },
  ])
    await assert.rejects(f.executor.execute("repo::/a", settings));
  await assert.rejects(
    f.executor.execute("missing", { mode: "shell", body: "x" }),
  );
  assert.equal(
    f.calls.some((args) => ["send", "create"].includes(args[1])),
    false,
  );
});

test("実行前に選択が変わったら中止し、結果不明時も自動で再実行しない", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.executor.execute(
        "repo::/a",
        { mode: "shell", body: "echo hi" },
        () => false,
      )
    ).status,
    "cancelled",
  );
  assert.equal(f.calls.length, 0);
  f.setResult(new Error("timeout"));
  assert.equal(
    (await f.executor.execute("repo::/a", { mode: "shell", body: "echo hi" }))
      .status,
    "unknown",
  );
  assert.equal(f.calls.filter((args) => args[1] === "create").length, 1);
});

test("受付拒否や異なる実行環境の応答を実行完了扱いしない", async () => {
  const f = fixture();
  f.setResult(response({ send: { handle: "term_one", accepted: false } }));
  assert.equal(
    (await f.executor.execute("repo::/a", { mode: "ai", body: "x" })).status,
    "refused",
  );
  f.setResult(
    response({ terminal: { handle: "new", worktreeId: "repo::/a" } }, "other"),
  );
  assert.equal(
    (await f.executor.execute("repo::/a", { mode: "shell", body: "x" })).status,
    "unknown",
  );
});

test("送信先を取得している途中で対象が変わったら、古い対象へ実行しない", async () => {
  let current = true;
  const calls = [];
  const executor = new WorkspaceExecutor(
    {
      snapshot: async () => {
        current = false;
        return snapshot;
      },
    },
    async (args) => {
      calls.push(args);
      return response({});
    },
  );
  const result = await executor.execute(
    "repo::/a",
    { mode: "shell", body: "echo hi" },
    () => current,
  );
  assert.equal(result.status, "cancelled");
  assert.equal(calls.length, 0);
});
