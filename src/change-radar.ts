import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OrcaWorkspace } from "./orca/model";
export type RadarSide = {
  workspace: OrcaWorkspace;
  line: number;
  open: "file" | "workspace" | "staged";
};
export type RadarContact = {
  id: string;
  fingerprint: string;
  path: string;
  kind: "lines" | "file" | "same" | "structure" | "manual";
  base: string;
  self: RadarSide;
  peer: RadarSide;
  ranges: string;
};
export type RadarResult = {
  contacts: RadarContact[];
  compared: number;
  skipped: { workspaceId: string; name: string; reason: string }[];
  at: number;
};
type Meta = {
  workspace: OrcaWorkspace;
  root: string;
  common: string;
  head: string;
};
type Hunk = {
  old: number;
  count: number;
  line: number;
  area: "file" | "staged";
};
type FileState = {
  status: string;
  patch: string;
  indexPatch: string;
  stageViewMatches: boolean;
  hunks: Hunk[];
  digest: string;
  open: "file" | "workspace";
};
export type GitReader = (cwd: string, args: string[]) => Promise<string>;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const readGit: GitReader = (cwd, args) =>
  new Promise((done, reject) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_EXTERNAL_DIFF",
    ])
      delete env[key as keyof typeof env];
    execFile(
      "git",
      [
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd,
        env,
        encoding: "buffer",
        timeout: 2000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Gitの変更を読み取れません。"));
          return;
        }
        try {
          done(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
        } catch {
          reject(new Error("UTF-8で読めない変更があります。"));
        }
      },
    );
  });
const cleanPath = (path: string) =>
  !!path &&
  !isAbsolute(path) &&
  !path.includes("\0") &&
  !path.split(/[\\/]/u).includes("..");
const diffArgs = [
  "-c",
  "core.quotepath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--unified=0",
  "--full-index",
];
export class ChangeRadar {
  constructor(private readonly git: GitReader = readGit) {}
  private async meta(workspace: OrcaWorkspace): Promise<Meta> {
    if (workspace.hostId !== "local") throw new Error("リモートは未比較です。");
    const config = (
      await this.git(workspace.path, [
        "config",
        "--null",
        "--name-only",
        "--list",
      ])
    ).split("\0");
    if (config.some((key) => /^filter\..*\.(?:clean|process)$/u.test(key)))
      throw new Error("外部Git filter設定があるため自動比較しません。");
    const root = await realpath(workspace.path),
      top = (await this.git(root, ["rev-parse", "--show-toplevel"])).replace(
        /\n$/u,
        "",
      );
    if ((await realpath(top)) !== root)
      throw new Error("Gitルート以外のWSは未比較です。");
    const common = await realpath(
      resolve(
        root,
        (await this.git(root, ["rev-parse", "--git-common-dir"])).replace(
          /\n$/u,
          "",
        ),
      ),
    );
    const head = (
      await this.git(root, ["rev-parse", "--verify", "HEAD"])
    ).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head))
      throw new Error("HEADを確認できません。");
    return { workspace, root, common, head };
  }
  private async changes(
    meta: Meta,
    base: string,
  ): Promise<Map<string, string>> {
    const rows = new Map<string, string>();
    for (const area of [[], ["--cached"]]) {
      const raw = (
        await this.git(meta.root, [
          ...diffArgs,
          ...area,
          "--name-status",
          "-z",
          base,
          "--",
        ])
      ).split("\0");
      if (raw.at(-1) === "") raw.pop();
      if (raw.length % 2) throw new Error("変更一覧を確認できません。");
      for (let i = 0; i < raw.length; i += 2) {
        if (!cleanPath(raw[i + 1]))
          throw new Error("変更pathを確認できません。");
        rows.set(raw[i + 1], (rows.get(raw[i + 1]) ?? "") + raw[i]);
      }
    }
    const untracked = (
      await this.git(meta.root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    for (const path of untracked) {
      if (!cleanPath(path)) throw new Error("追加pathを確認できません。");
      rows.set(path, rows.get(path) ? `${rows.get(path)}?` : "?");
    }
    return rows;
  }
  private async blob(
    root: string,
    path: string,
  ): Promise<{ digest: string; open: "file" | "workspace" }> {
    const full = join(root, path);
    if (
      relative(root, full) === ".." ||
      relative(root, full).startsWith(`..${sep}`) ||
      isAbsolute(relative(root, full))
    )
      throw new Error("pathがWS外を指しています。");
    try {
      const s = await lstat(full);
      if (s.isSymbolicLink())
        return {
          digest: digest(`link:${await readlink(full)}`),
          open: "workspace",
        };
      const canonical = await realpath(full);
      if (canonical !== resolve(full))
        throw new Error("リンク経由のpathは未比較です。");
      if (!s.isFile() || s.size > 2 * 1024 * 1024)
        throw new Error("通常ファイル・2MB以内の範囲外です。");
      return {
        digest: digest(
          Buffer.concat([
            Buffer.from(`${s.mode & 0o111}:`),
            await readFile(full),
          ]),
        ),
        open: "file",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { digest: "missing", open: "workspace" };
      throw error;
    }
  }
  private async file(
    meta: Meta,
    base: string,
    path: string,
    status: string,
  ): Promise<FileState> {
    const before = await this.blob(meta.root, path);
    const [patch, indexPatch, stageViewPatch] = await Promise.all([
      this.git(meta.root, [...diffArgs, base, "--", path]),
      this.git(meta.root, [...diffArgs, "--cached", base, "--", path]),
      this.git(meta.root, [...diffArgs, "--cached", "--", path]),
    ]);
    const after = await this.blob(meta.root, path);
    if (before.digest !== after.digest)
      throw new Error("比較中にファイルが変わりました。");
    const hunks: Hunk[] = [];
    for (const [text, area] of [
      [patch, "file"],
      [indexPatch, "staged"],
    ] as const) {
      for (const m of text.matchAll(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/gmu,
      ))
        hunks.push({
          old: Number(m[1]),
          count: m[2] === undefined ? 1 : Number(m[2]),
          line: Math.max(1, Number(m[3])),
          area,
        });
    }
    return {
      status,
      patch,
      indexPatch,
      stageViewMatches: indexPatch === stageViewPatch,
      hunks,
      ...after,
    };
  }

  private async pairMeta(
    a: Meta,
    b: Meta,
    deadline = Date.now() + 8000,
  ): Promise<RadarContact[]> {
    const bases = (
      await this.git(a.root, ["merge-base", "--all", a.head, b.head])
    )
      .trim()
      .split("\n");
    if (bases.length !== 1 || !/^[0-9a-f]{40,64}$/u.test(bases[0]))
      throw new Error("共通基点を一つに決められません。");
    const base = bases[0];
    const [left, right] = await Promise.all([
      this.changes(a, base),
      this.changes(b, base),
    ]);
    const common = [...left.keys()].filter((p) => right.has(p)).sort();
    if (common.length > 32)
      throw new Error("共通ファイルが32件を超えています。");
    const contacts: RadarContact[] = [];
    for (const path of common) {
      if (Date.now() > deadline)
        throw new Error("比較の時間上限に達しました。");
      const [x, y] = await Promise.all([
        this.file(a, base, path, left.get(path) ?? ""),
        this.file(b, base, path, right.get(path) ?? ""),
      ]);
      const overlap = x.hunks.flatMap((l) =>
        y.hunks
          .filter(
            (r) =>
              l.old <= r.old + Math.max(1, r.count) - 1 &&
              r.old <= l.old + Math.max(1, l.count) - 1,
          )
          .map((r) => ({ l, r })),
      )[0];
      const structural = /[ADTU?]/u.test(x.status + y.status),
        manual = !x.hunks.length || !y.hunks.length;
      const kind =
        x.open === "file" &&
        y.open === "file" &&
        x.digest === y.digest &&
        x.patch === y.patch &&
        x.indexPatch === y.indexPatch
          ? "same"
          : structural
            ? "structure"
            : overlap
              ? "lines"
              : manual
                ? "manual"
                : "file";
      const l = overlap?.l ?? x.hunks[0],
        r = overlap?.r ?? y.hunks[0];
      contacts.push({
        id: JSON.stringify([a.workspace.id, b.workspace.id, path]),
        fingerprint: digest(JSON.stringify([base, a.head, b.head, path, x, y])),
        path,
        kind,
        base,
        self: {
          workspace: a.workspace,
          line: l?.line ?? 1,
          open:
            l?.area === "staged" || (!x.patch && x.indexPatch)
              ? x.stageViewMatches
                ? "staged"
                : "workspace"
              : x.open,
        },
        peer: {
          workspace: b.workspace,
          line: r?.line ?? 1,
          open:
            r?.area === "staged" || (!y.patch && y.indexPatch)
              ? y.stageViewMatches
                ? "staged"
                : "workspace"
              : y.open,
        },
        ranges: overlap
          ? `共通基点 ${Math.max(overlap.l.old, overlap.r.old)}行付近`
          : structural
            ? "追加・削除等を含む"
            : kind === "same"
              ? "現在の内容が同じ"
              : "共通ファイルの変更",
      });
    }
    const [ah, bh] = await Promise.all([
      this.git(a.root, ["rev-parse", "HEAD"]),
      this.git(b.root, ["rev-parse", "HEAD"]),
    ]);
    if (ah.trim() !== a.head || bh.trim() !== b.head)
      throw new Error("比較中にHEADが変わりました。");
    return contacts;
  }
  async pair(
    left: OrcaWorkspace,
    right: OrcaWorkspace,
  ): Promise<RadarContact[]> {
    const [a, b] = await Promise.all([this.meta(left), this.meta(right)]);
    if (a.root === b.root) throw new Error("同じ実体のワークスペースです。");
    if (a.common !== b.common)
      throw new Error("同じGit作業系列ではありません。");
    return this.pairMeta(a, b);
  }
  async scan(
    workspace: OrcaWorkspace,
    catalog: readonly OrcaWorkspace[],
  ): Promise<RadarResult> {
    const a = await this.meta(workspace),
      result: RadarResult = {
        contacts: [],
        compared: 0,
        skipped: [],
        at: Date.now(),
      };
    const deadline = Date.now() + 8000;
    let examined = 0;
    const seenRoots = new Set([a.root]);
    const peers = catalog.filter((w) => w.id !== workspace.id);
    for (const w of peers) {
      if (++examined > 24 || result.compared >= 12 || Date.now() > deadline) {
        result.skipped.push({
          workspaceId: w.id,
          name: w.name,
          reason:
            Date.now() > deadline
              ? "比較の時間上限"
              : examined > 24
                ? "一覧確認上限24WS"
                : "比較上限12WS",
        });
        continue;
      }
      try {
        const b = await this.meta(w);
        if (a.common !== b.common || seenRoots.has(b.root)) continue;
        seenRoots.add(b.root);
        const contacts = await this.pairMeta(a, b, deadline);
        result.contacts.push(...contacts);
        result.compared++;
      } catch (error) {
        result.skipped.push({
          workspaceId: w.id,
          name: w.name,
          reason: error instanceof Error ? error.message : "取得不能",
        });
      }
    }
    const order = { lines: 0, structure: 1, manual: 2, file: 3, same: 4 };
    result.contacts.sort(
      (x, y) =>
        order[x.kind] - order[y.kind] ||
        x.peer.workspace.name.localeCompare(y.peer.workspace.name) ||
        x.path.localeCompare(y.path),
    );
    result.at = Date.now();
    return result;
  }
}
