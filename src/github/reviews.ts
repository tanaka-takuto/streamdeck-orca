import { executable, runCommand } from "../command";
import { object } from "../orca/model";

export type ReviewOrder = "asc" | "desc";
export type ReviewMode = "personal" | "team";
export type ReviewPR = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt?: string;
};
export type ReviewList = {
  account: string;
  accountId: number;
  rows: ReviewPR[];
  partial: boolean;
  totalCount: number;
  incomplete: boolean;
};
export type ReviewDetail = ReviewPR & {
  sha: string;
  branch: string;
  headRepo: string;
  baseBranch: string;
};
export type GitHubRunner = (args: string[]) => Promise<unknown>;
export const githubRunner: GitHubRunner = async (args) =>
  JSON.parse(await runCommand(executable("gh"), args, 30_000));
export const reviewQuery = (mode: ReviewMode) =>
  `is:pr is:open ${mode === "personal" ? "user-review-requested:@me" : "team-review-requested-user:@me"}`;
export const prKey = (pr: ReviewPR) => `${pr.repo.toLowerCase()}#${pr.number}`;
export class GitHubReviews {
  constructor(private readonly run: GitHubRunner = githubRunner) {}
  async account() {
    const user = object(
      await this.run(["api", "user", "--hostname", "github.com"]),
    );
    if (
      typeof user.login !== "string" ||
      !/^[a-z\d-]+$/iu.test(user.login) ||
      !Number.isSafeInteger(user.id)
    )
      throw new Error(
        "GitHubのアカウントを確認できません。gh auth login を実行してください。",
      );
    return { login: user.login, id: user.id as number };
  }
  async list(
    mode: ReviewMode,
    repo?: string,
    order: ReviewOrder = "desc",
  ): Promise<ReviewList> {
    const account = await this.account();
    const data = object(
      await this.run([
        "api",
        "search/issues",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "-f",
        `q=${reviewQuery(mode)}${repo ? ` repo:${repo}` : ""}`,
        "-f",
        "sort=updated",
        "-f",
        `order=${order}`,
        "-F",
        "per_page=100",
      ]),
    );
    if (
      !Array.isArray(data.items) ||
      !Number.isSafeInteger(data.total_count) ||
      (data.total_count as number) < data.items.length ||
      typeof data.incomplete_results !== "boolean"
    )
      throw new Error("レビュー依頼の一覧を確認できません。");
    const rows = data.items.map((value): ReviewPR => {
      const row = object(value);
      const match =
        typeof row.html_url === "string"
          ? /^https:\/\/github\.com\/([a-z\d_.-]+\/[a-z\d_.-]+)\/pull\/(\d+)$/iu.exec(
              row.html_url,
            )
          : null;
      if (
        !match ||
        !Number.isSafeInteger(row.number) ||
        Number(match[2]) !== row.number ||
        typeof row.title !== "string"
      )
        throw new Error("PRの識別情報を確認できません。");
      const updatedAt =
        typeof row.updated_at === "string" &&
        Number.isFinite(Date.parse(row.updated_at))
          ? row.updated_at
          : undefined;
      if (order === "asc" && !updatedAt)
        throw new Error("PRの更新日時を確認できません。");
      return {
        ...(updatedAt ? { updatedAt } : {}),
        repo: match[1],
        number: row.number as number,
        title: row.title,
        url: row.html_url as string,
        author: String(object(row.user).login ?? ""),
      };
    });
    if (order === "asc")
      rows.sort(
        (a, b) =>
          Date.parse(a.updatedAt ?? "") - Date.parse(b.updatedAt ?? "") ||
          prKey(a).localeCompare(prKey(b)),
      );
    const after = await this.account();
    if (after.id !== account.id || after.login !== account.login)
      throw new Error("GitHubのアカウントが変わりました。更新してください。");
    return {
      account: account.login,
      accountId: account.id,
      rows,
      totalCount: data.total_count as number,
      incomplete: data.incomplete_results as boolean,
      partial:
        data.incomplete_results || (data.total_count as number) > rows.length,
    };
  }
  async detail(
    pr: ReviewPR,
    mode: ReviewMode,
    accountId: number,
    order: ReviewOrder = "desc",
  ): Promise<ReviewDetail> {
    const list = await this.list(mode, pr.repo, order);
    if (list.accountId !== accountId)
      throw new Error("GitHubのアカウントが変わりました。更新してください。");
    if (!list.rows.some((p) => prKey(p) === prKey(pr)))
      throw new Error(
        "このPRはレビュー依頼の対象外になりました。更新してください。",
      );
    const data = object(
      await this.run([
        "api",
        `repos/${pr.repo}/pulls/${pr.number}`,
        "--hostname",
        "github.com",
      ]),
    );
    const head = object(data.head),
      base = object(data.base);
    const baseRepo = object(base.repo),
      headRepo = object(head.repo);
    if (
      data.state !== "open" ||
      data.merged === true ||
      data.html_url !== pr.url ||
      data.number !== pr.number ||
      String(baseRepo.full_name).toLowerCase() !== pr.repo.toLowerCase() ||
      typeof headRepo.full_name !== "string" ||
      !/^[a-z\d_.-]+\/[a-z\d_.-]+$/iu.test(headRepo.full_name) ||
      typeof head.sha !== "string" ||
      !/^[a-f\d]{40}$/iu.test(head.sha) ||
      typeof head.ref !== "string" ||
      !head.ref ||
      typeof base.ref !== "string"
    )
      throw new Error("PRの最新ブランチを確認できません。更新してください。");
    if (
      mode === "personal" &&
      (!Array.isArray(data.requested_reviewers) ||
        !data.requested_reviewers.some((u) => object(u).id === accountId))
    )
      throw new Error("個人宛てのレビュー依頼が取り消されました。");
    if (
      mode === "team" &&
      (!Array.isArray(data.requested_teams) || !data.requested_teams.length)
    )
      throw new Error("チーム宛てのレビュー依頼が取り消されました。");
    const after = await this.account();
    if (after.id !== accountId)
      throw new Error("GitHubのアカウントが変わりました。更新してください。");
    return {
      ...pr,
      title: typeof data.title === "string" ? data.title : pr.title,
      sha: head.sha,
      branch: head.ref,
      headRepo: headRepo.full_name,
      baseBranch: base.ref,
    };
  }
}
