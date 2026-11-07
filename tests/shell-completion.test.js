import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { ShellCompletion } = await loadModule("src/orca/shell-completion.ts");
const job = {
  handle: "own-terminal",
  incarnationId: "own-process",
  workspaceId: "repo::/a",
  runtimeId: "runtime",
  hostId: "local",
  marker: "__ORCA_COMMAND_abc123",
  closeOnExit: false,
};
const response = (result, runtimeId = "runtime") => ({
  ok: true,
  _meta: { runtimeId },
  result,
});
const output = (tail, extra = {}) =>
  response({
    terminal: {
      handle: job.handle,
      source: "stream",
      status: "running",
      tail,
      nextCursor: "12",
      latestCursor: "12",
      limited: false,
      ...extra,
    },
  });
function fixture(reads, extra = {}) {
  const calls = [];
  const watcher = new ShellCompletion(
    async (args) => {
      calls.push(args);
      if (args[1] === "read") return reads.shift();
      if (args[1] === "show")
        return response({
          terminal: {
            handle: job.handle,
            incarnationId: job.incarnationId,
            worktreeId: job.workspaceId,
            executionHostId: job.hostId,
            orphaned: false,
            ...extra,
          },
        });
      if (args[1] === "close")
        return response({ close: { handle: job.handle, ptyKilled: true } });
      throw new Error("unexpected command");
    },
    async () => {},
  );
  return { watcher, calls };
}

for (const [code, closeOnExit, closes] of [
  [0, false, true],
  [7, false, false],
  [0, true, true],
  [7, true, true],
  [130, false, false],
]) {
  test(`終了コード ${code}・終了時すべて閉じる ${closeOnExit} → 閉じる ${closes}`, async () => {
    const f = fixture([output([`${job.marker}:${code}__`])]);
    const message = await f.watcher.watch({ ...job, closeOnExit });
    assert.equal(f.calls.filter((args) => args[1] === "close").length, +closes);
    if (closes) {
      assert.deepEqual(f.calls.at(-1), [
        "terminal",
        "close",
        "--terminal",
        job.handle,
        "--json",
      ]);
      assert.match(message, /閉じました/u);
    } else assert.match(message, /残し/u);
    assert.match(message, new RegExp(String(code)));
  });
}

test("実行中・分割された出力はカーソルで追い、別の完了マーカーでは閉じない", async () => {
  const f = fixture([
    output(["__ORCA_COMMAND_other:0__", `${job.marker}:%s__`]),
    output([`${job.marker}:0__`]),
  ]);
  await f.watcher.watch(job);
  const reads = f.calls.filter((args) => args[1] === "read");
  assert.equal(reads.length, 2);
  assert.equal(reads[1][reads[1].indexOf("--cursor") + 1], "12");
  assert.equal(f.calls.filter((args) => args[1] === "close").length, 1);
});

for (const extra of [
  { incarnationId: "replacement" },
  { worktreeId: "another-workspace" },
  { executionHostId: "another-host" },
  { agentIdentity: "codex" },
])
  test(`実行した端末と一致しない場合は閉じない: ${JSON.stringify(extra)}`, async () => {
    const f = fixture([output([`${job.marker}:0__`])], extra);
    const message = await f.watcher.watch(job);
    assert.equal(
      f.calls.some((args) => args[1] === "close"),
      false,
    );
    assert.match(message, /閉じません/u);
  });

test("ランタイム変更・終了コード不明・読取失敗では閉じず、コマンドも再実行しない", async () => {
  for (const read of [
    response({ terminal: {} }, "replacement-runtime"),
    output([], { status: "exited", exitCode: 0 }),
    { ok: false, error: { message: "not found" } },
  ]) {
    const f = fixture([read]);
    const message = await f.watcher.watch(job);
    assert.equal(f.calls.length, 1);
    assert.match(message, /閉じません/u);
  }
});

test("閉じる要求の結果が不明でも、再度閉じたりコマンドを再実行したりしない", async () => {
  const calls = [];
  const watcher = new ShellCompletion(async (args) => {
    calls.push(args);
    if (args[1] === "read") return output([`${job.marker}:0__`]);
    if (args[1] === "show")
      return response({
        terminal: {
          handle: job.handle,
          incarnationId: job.incarnationId,
          worktreeId: job.workspaceId,
          executionHostId: job.hostId,
        },
      });
    throw new Error("connection lost after request");
  });
  const message = await watcher.watch(job);
  assert.match(message, /クローズの結果を確認できません/u);
  assert.equal(calls.filter((args) => args[1] === "close").length, 1);
  assert.equal(
    calls.some((args) => ["create", "send"].includes(args[1])),
    false,
  );
});
