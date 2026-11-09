import type { ReviewDetail, ReviewMode } from "./github/reviews";
export type ReviewSettings = {
  reviewMode?: ReviewMode;
  agent?: "codex" | "claude";
  body?: string;
  enter?: boolean;
  handoff?: "none" | "draft" | "send";
  revision?: string;
};
export const defaultReviewBody =
  "次のPRをレビューしてください。コードは変更せず、重要な指摘と根拠をまとめてください。\n{{pr_url}}";
export function normalizeReviewSettings(s: ReviewSettings) {
  return {
    reviewMode:
      s.reviewMode === "team" ? ("team" as const) : ("personal" as const),
    agent: s.agent === "claude" ? ("claude" as const) : ("codex" as const),
    body: typeof s.body === "string" ? s.body : defaultReviewBody,
    enter: s.enter === true,
  };
}
export function reviewPrompt(body: string, pr: ReviewDetail): string {
  const values: Record<string, string> = {
    PR_LINK: pr.url,
    pr_url: pr.url,
    pr_number: String(pr.number),
    repo: pr.repo,
    branch: pr.branch,
    head_sha: pr.sha,
    base_branch: pr.baseBranch,
  };
  const text = body
    .replaceAll("\r\n", "\n")
    .replace(
      /\{\{\s*(PR_LINK|pr_url|pr_number|repo|branch|head_sha|base_branch)\s*\}\}/gu,
      (_, name: string) => values[name],
    );
  if (
    !text.trim() ||
    text.length > 16_000 ||
    Array.from(text).some((c) => {
      const n = c.charCodeAt(0);
      return (n < 32 && n !== 9 && n !== 10) || (n >= 127 && n <= 159);
    })
  )
    throw new Error(
      "AIに渡すテキストを1〜16000文字で設定してください。制御文字は使えません。",
    );
  return text;
}

export function reviewHandoff(s: ReviewSettings): "none" | "draft" | "send" {
  return s.handoff === "none" || s.handoff === "draft" || s.handoff === "send"
    ? s.handoff
    : s.enter === true
      ? "send"
      : "draft";
}
export function normalizeOldestReviewSettings(s: ReviewSettings) {
  const handoff: "none" | "draft" | "send" =
    s.handoff === "draft" || s.handoff === "send" ? s.handoff : "none";
  return {
    ...normalizeReviewSettings(s),
    reviewMode: "personal" as const,
    handoff,
    enter: handoff === "send",
    body:
      typeof s.body === "string"
        ? s.body
        : defaultReviewBody.replace("{{pr_url}}", "{{PR_LINK}}"),
  };
}
