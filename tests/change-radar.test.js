import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModule } from "./helpers/load-module.js";

const { ChangeRadar } = await loadModule("src/change-radar.ts");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "orca-radar-")),
    a = join(root, "a"),
    b = join(root, "b");
  mkdirSync(a);
  const git = (cwd, ...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Radar Test",
        "-c",
        "user.email=radar@example.test",
        ...args,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
  git(a, "init", "-b", "main");
  writeFileSync(
    join(a, "shared.txt"),
    `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
  );
  git(a, "add", ".");
  git(a, "commit", "-m", "base");
  git(a, "worktree", "add", "-b", "other", b);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = (id, path) => ({
    id,
    name: id,
    project: "Test",
    path,
    hostId: "local",
    agents: [],
    activity: "active",
    terminalVerdict: "live",
  });
  return {
    a,
    b,
    git,
    left: ws("A", a),
    right: ws("B", b),
    change(path, line, text) {
      const p = join(path, "shared.txt"),
        s = execFileSync("cat", [p], { encoding: "utf8" }).split("\n");
      s[line - 1] = text;
      writeFileSync(p, s.join("\n"));
    },
  };
}
test("コミット済みと未コミットの同じ基点行の変更を検出し、元の作業状態を変えない", async (t) => {
  const f = fixture(t);
  f.change(f.a, 5, "left change");
  f.git(f.a, "add", ".");
  f.git(f.a, "commit", "-m", "left");
  f.change(f.b, 5, "right change");
  const before = f.git(f.b, "status", "--porcelain");
  const r = await new ChangeRadar().scan(f.left, [f.left, f.right]);
  assert.equal(r.contacts.length, 1);
  assert.equal(r.contacts[0].kind, "lines");
  assert.equal(r.contacts[0].self.line, 5);
  assert.equal(r.contacts[0].peer.line, 5);
  assert.equal(f.git(f.b, "status", "--porcelain"), before);
});
test("同ファイルの別行域と同一内容を区別する", async (t) => {
  const f = fixture(t);
  f.change(f.a, 5, "change");
  f.change(f.b, 25, "other");
  const radar = new ChangeRadar();
  assert.equal(
    (await radar.scan(f.left, [f.left, f.right])).contacts[0].kind,
    "file",
  );
  f.git(f.b, "restore", "shared.txt");
  f.change(f.b, 5, "change");
  assert.equal(
    (await radar.scan(f.left, [f.left, f.right])).contacts[0].kind,
    "same",
  );
});
test("両側の未追跡同path追加を拾い、Gitignoreは含めない", async (t) => {
  const f = fixture(t);
  for (const path of [f.a, f.b]) {
    writeFileSync(join(path, "new file.txt"), "new");
    writeFileSync(join(path, ".gitignore"), "ignored\n");
    writeFileSync(join(path, "ignored"), "secret");
  }
  const r = await new ChangeRadar().scan(f.left, [f.left, f.right]);
  assert.ok(r.contacts.some((x) => x.path === "new file.txt"));
  assert.equal(
    r.contacts.some((x) => x.path === "ignored"),
    false,
  );
});
test("削除と変更の接点は自分側をWSで開くと明示する", async (t) => {
  const f = fixture(t);
  rmSync(join(f.a, "shared.txt"));
  f.change(f.b, 5, "peer");
  const c = (await new ChangeRadar().scan(f.left, [f.left, f.right]))
    .contacts[0];
  assert.equal(c.kind, "structure");
  assert.equal(c.self.open, "workspace");
  assert.equal(c.peer.open, "file");
});
test("別リポジトリやremoteを同じプロジェクト名だけで比較しない", async (t) => {
  const f = fixture(t),
    other = join(f.a, "nested");
  mkdirSync(other);
  f.git(other, "init", "-b", "main");
  writeFileSync(join(other, "file"), "x");
  f.git(other, "add", ".");
  f.git(other, "commit", "-m", "other");
  const r = await new ChangeRadar().scan(f.left, [
    f.left,
    { ...f.right, id: "remote", hostId: "remote" },
    { ...f.right, id: "other", path: other },
  ]);
  assert.equal(r.contacts.length, 0);
  assert.ok(r.skipped.length >= 1);
});

test("working側で打ち消したstage変更も比較に残し、stage差分へ案内する", async (t) => {
  const f = fixture(t);
  f.change(f.a, 5, "staged");
  f.git(f.a, "add", "shared.txt");
  writeFileSync(
    join(f.a, "shared.txt"),
    `${f.git(f.a, "show", "HEAD:shared.txt")}\n`,
  );
  f.change(f.b, 5, "peer");
  const c = (
    await new ChangeRadar().scan(f.left, [f.left, f.right])
  ).contacts.find((x) => x.path === "shared.txt");
  assert.ok(c);
  assert.equal(c.kind, "lines");
  assert.equal(c.self.open, "staged");
});

test("空白・改行・Unicode・glob記号のrawpathを比較し、同一実体のaliasを重複しない", async (t) => {
  const f = fixture(t),
    path = "-- x [a]*\n🦫e\u0301.txt";
  for (const d of [f.a, f.b]) writeFileSync(join(d, path), d);
  const r = await new ChangeRadar().scan(f.left, [
    f.left,
    { ...f.left, id: "alias" },
    f.right,
  ]);
  assert.ok(r.contacts.some((c) => c.path === path));
  assert.equal(r.compared, 1);
});
test("共通祖先がない系列は未比較とし、接点なしの完全取得と区別する", async (t) => {
  const f = fixture(t);
  f.git(f.b, "checkout", "--orphan", "orphan");
  f.git(f.b, "rm", "-rf", ".");
  writeFileSync(join(f.b, "shared.txt"), "orphan");
  f.git(f.b, "add", ".");
  f.git(f.b, "commit", "-m", "orphan");
  const r = await new ChangeRadar().scan(f.left, [f.left, f.right]);
  assert.equal(r.compared, 0);
  assert.equal(r.skipped.length, 1);
});

test("コミット変更のworking打消しを空のstage差分へ案内しない", async (t) => {
  const f = fixture(t);
  f.change(f.a, 5, "committed");
  f.git(f.a, "add", ".");
  f.git(f.a, "commit", "-m", "committed");
  writeFileSync(
    join(f.a, "shared.txt"),
    `${f.git(f.b, "show", "HEAD:shared.txt")}\n`,
  );
  f.change(f.b, 5, "peer");
  assert.equal(f.git(f.a, "diff", "--cached"), "");
  const c = (
    await new ChangeRadar().scan(f.left, [f.left, f.right])
  ).contacts.find((x) => x.path === "shared.txt");
  assert.ok(c);
  assert.equal(c.self.open, "workspace");
});
test("外部clean/process filterのあるrepoをdiff前に未比較にする", async (t) => {
  const f = fixture(t);
  f.git(f.a, "config", "filter.review.clean", "touch should-not-run; cat");
  for (const d of [f.a, f.b])
    writeFileSync(join(d, ".gitattributes"), "shared.txt filter=review\n");
  f.change(f.a, 5, "left");
  f.change(f.b, 5, "right");
  await assert.rejects(
    new ChangeRadar().scan(f.left, [f.left, f.right]),
    /filter/,
  );
  for (const d of [f.a, f.b])
    assert.equal(
      (await import("node:fs")).existsSync(join(d, "should-not-run")),
      false,
    );
});

test("祖先symlinkがWS外へ向くpathをread/open対象にしない", async (t) => {
  const f = fixture(t),
    fs = await import("node:fs");
  mkdirSync(join(f.a, "nested"));
  writeFileSync(join(f.a, "nested/file.ts"), "base\n");
  f.git(f.a, "add", ".");
  f.git(f.a, "commit", "-m", "nested");
  f.git(f.b, "merge", "main");
  mkdirSync(join(f.b, "outside"));
  writeFileSync(join(f.b, "outside/file.ts"), "outside secret\n");
  rmSync(join(f.a, "nested"), { recursive: true });
  fs.symlinkSync(join(f.b, "outside"), join(f.a, "nested"), "dir");
  writeFileSync(join(f.b, "nested/file.ts"), "peer change\n");
  const r = await new ChangeRadar().scan(f.left, [f.left, f.right]);
  assert.equal(
    r.contacts.some(
      (c) => c.path === "nested/file.ts" && c.self.open === "file",
    ),
    false,
  );
  assert.ok(r.skipped.length);
});
