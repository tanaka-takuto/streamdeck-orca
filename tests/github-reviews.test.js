import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { GitHubReviews } = await loadModule("src/github/reviews.ts");
const item = {
  number: 12,
  title: "レビュー対象",
  html_url: "https://github.com/acme/app/pull/12",
  repository_url: "https://api.github.com/repos/acme/app",
  user: { login: "author" },
};
function fixture(mode = "personal") {
  const calls = [];
  const github = new GitHubReviews(async (args) => {
    calls.push(args);
    if (args[1] === "user") return { login: "me", id: 7 };
    return { total_count: 1, incomplete_results: false, items: [item] };
  });
  return { github, calls, mode };
}
test("個人宛てとチーム宛ての依頼を混ぜずに検索する", async () => {
  for (const mode of ["personal", "team"]) {
    const f = fixture(mode);
    const result = await f.github.list(mode);
    const search = f.calls.find((a) => a[1] === "search/issues");
    assert.ok(
      search.some((a) =>
        a.includes(
          mode === "personal"
            ? "user-review-requested:@me"
            : "team-review-requested-user:@me",
        ),
      ),
    );
    assert.equal(result.account, "me");
    assert.equal(result.rows[0].repo, "acme/app");
    assert.equal(result.rows[0].number, 12);
  }
});
test("認証アカウントが取得途中で変わった一覧を公開しない", async () => {
  let user = 0;
  const g = new GitHubReviews(async (a) =>
    a[1] === "user"
      ? { login: ++user === 1 ? "me" : "other", id: user }
      : { total_count: 1, incomplete_results: false, items: [item] },
  );
  await assert.rejects(g.list("personal"), /アカウント/);
});
test("検索上限や不完全な検索を全件取得として扱わない", async () => {
  const g = new GitHubReviews(async (a) =>
    a[1] === "user"
      ? { login: "me", id: 7 }
      : { total_count: 120, incomplete_results: true, items: [item] },
  );
  assert.equal((await g.list("team")).partial, true);
});
test("最古検索はGitHubでupdated昇順を指定し全件数と不完全検索を分ける", async () => {
  const calls = [];
  const g = new GitHubReviews(async (a) => {
    calls.push(a);
    return a[1] === "user"
      ? { login: "me", id: 7 }
      : {
          total_count: 120,
          incomplete_results: false,
          items: [{ ...item, updated_at: "2026-01-02T00:00:00Z" }],
        };
  });
  const list = await g.list("personal", undefined, "asc");
  assert.ok(calls.find((a) => a[1] === "search/issues").includes("order=asc"));
  assert.equal(list.totalCount, 120);
  assert.equal(list.incomplete, false);
  assert.equal(list.rows[0].updatedAt, "2026-01-02T00:00:00Z");
});
test("最古検索で更新日時がない候補と不正な全件数を採用しない", async () => {
  for (const patch of [
    { items: [item] },
    {
      total_count: -1,
      items: [{ ...item, updated_at: "2026-01-01T00:00:00Z" }],
    },
  ]) {
    const g = new GitHubReviews(async (a) =>
      a[1] === "user"
        ? { login: "me", id: 7 }
        : { total_count: 1, incomplete_results: false, ...patch },
    );
    await assert.rejects(g.list("personal", undefined, "asc"));
  }
});
