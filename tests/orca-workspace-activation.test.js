import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { createWorkspaceActivator } = await loadModule(
  "src/orca/workspace-activation.ts",
);
async function fixture(t, respond) {
  const directory = mkdtempSync(join(tmpdir(), "oa-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\orca-test-${directory.split(/[\\/]/u).at(-1)}`
      : join(directory, "r.sock");
  const received = [];
  const clients = new Set();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]);
      received.push(request);
      respond(socket, request);
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise((done) => server.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  const metadata = {
    runtimeId: "r",
    authToken: "test-only-token",
    transports: [{ kind: "unix", endpoint }],
  };
  return {
    received,
    metadata,
    activate: createWorkspaceActivator(() => metadata),
  };
}
const reply = (request, extra = {}) => ({
  id: request.id,
  ok: true,
  _meta: { runtimeId: "r" },
  result: { worktreeId: "repo::/a", activated: true },
  ...extra,
});

test("ワークスペース選択 API を呼び、端末作成やエージェント起動のコマンドを送らない", async (t) => {
  const f = await fixture(t, (socket, request) =>
    socket.end(`${JSON.stringify(reply(request))}\n`),
  );
  assert.equal(await f.activate("repo::/a", "r"), true);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].method, "worktree.activate");
  assert.equal(f.received[0].authToken, "test-only-token");
  assert.deepEqual(f.received[0].params, {
    worktree: "id:repo::/a",
    navigation: "host",
  });
});

test("別ランタイム・古い操作では切り替えを送信しない", async (t) => {
  const f = await fixture(t, () => {});
  await assert.rejects(f.activate("repo::/a", "different"), /実行環境|再起動/u);
  assert.equal(await f.activate("repo::/a", "r", () => false), false);
  let checks = 0;
  assert.equal(await f.activate("repo::/a", "r", () => ++checks === 1), false);
  assert.equal(f.received.length, 0);
});

for (const [name, patch] of [
  ["応答 ID 違い", { id: "other-request" }],
  ["ランタイム違い", { _meta: { runtimeId: "other-runtime" } }],
  [
    "別ワークスペース",
    { result: { worktreeId: "repo::/other", activated: true } },
  ],
  ["切り替え未確認", { result: { worktreeId: "repo::/a", activated: false } }],
]) {
  test(`${name}を成功扱いしない`, async (t) => {
    const f = await fixture(t, (socket, request) =>
      socket.end(`${JSON.stringify(reply(request, patch))}\n`),
    );
    await assert.rejects(f.activate("repo::/a", "r"));
    assert.equal(f.received.length, 1);
  });
}

test("分割された応答と keepalive を読み取る", async (t) => {
  const f = await fixture(t, (socket, request) => {
    const response = JSON.stringify(reply(request));
    socket.write(`{"_keepalive":true}\n${response.slice(0, 20)}`);
    setImmediate(() => socket.end(`${response.slice(20)}\n`));
  });
  assert.equal(await f.activate("repo::/a", "r"), true);
});

test("途中切断と不正な応答では認証情報を含めずに失敗する", async (t) => {
  for (const response of [null, "bad-json\n"]) {
    await t.test(String(response), async (t) => {
      const f = await fixture(t, (socket) =>
        response === null ? socket.end() : socket.end(response),
      );
      await assert.rejects(
        f.activate("repo::/a", "r"),
        (error) => !error.message.includes("test-only-token"),
      );
      assert.equal(f.received.length, 1);
    });
  }
});
