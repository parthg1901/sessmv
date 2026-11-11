import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compareGit, gitState, normalizeRemote, parseGitState, type GitState } from "../src/git.ts";
import { LocalTarget } from "../src/target.ts";
import { cleanupTempDirs, sh, tempDir } from "./helpers.ts";

afterAll(cleanupTempDirs);

const repo = (over: Partial<Extract<GitState, { kind: "repo" }>> = {}): GitState => ({
  kind: "repo",
  remote: "git@github.com:example/app.git",
  branch: "main",
  head: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  ...over,
});

describe("parseGitState", () => {
  test("parses a repository", () => {
    const out = "state=repo\nremote=git@github.com:example/app.git\nbranch=main\nhead=abc123\ndirty=1\n";
    expect(parseGitState(out)).toEqual({ kind: "repo", remote: "git@github.com:example/app.git", branch: "main", head: "abc123", dirty: true });
  });

  test("parses the non-repository states", () => {
    expect(parseGitState("state=missing-dir\n")).toEqual({ kind: "missing-dir" });
    expect(parseGitState("state=no-git\n")).toEqual({ kind: "no-git" });
    expect(parseGitState("state=not-a-repo\n")).toEqual({ kind: "not-a-repo" });
  });

  test("rejects output it does not understand", () => {
    expect(() => parseGitState("")).toThrow(/unexpected/);
  });
});

describe("normalizeRemote", () => {
  test("treats ssh, scp-like and https forms of one repository as equal", () => {
    const expected = "github.com/example/app";
    expect(normalizeRemote("git@github.com:example/app.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/example/app.git")).toBe(expected);
    expect(normalizeRemote("https://github.com/example/app/")).toBe(expected);
    expect(normalizeRemote("ssh://git@GitHub.com/example/app")).toBe(expected);
  });

  test("keeps different repositories different", () => {
    expect(normalizeRemote("git@github.com:example/app.git")).not.toBe(normalizeRemote("git@github.com:example/App.git"));
    expect(normalizeRemote("git@github.com:example/app.git")).not.toBe(normalizeRemote("git@gitlab.com:example/app.git"));
    expect(normalizeRemote("/srv/git/app.git")).toBe("/srv/git/app");
  });
});

describe("compareGit", () => {
  const compare = (source: GitState, target: GitState) => compareGit(source, target, "/Users/testuser/proj/app", "/home/tester/proj/app");

  test("matches when everything lines up, even across URL styles", () => {
    const result = compare(repo(), repo({ remote: "https://github.com/example/app" }));
    expect(result.status).toBe("match");
    expect(result.warnings).toEqual([]);
  });

  test("warns about each difference", () => {
    const result = compare(repo(), repo({ remote: "git@github.com:example/fork.git", branch: "dev", head: "f".repeat(40) }));
    expect(result.status).toBe("mismatch");
    expect(result.warnings.join("\n")).toMatch(/remote differs[\s\S]*branch differs[\s\S]*HEAD differs/);
  });

  test("warns about uncommitted changes on either side", () => {
    expect(compare(repo({ dirty: true }), repo()).warnings.join()).toMatch(/source has uncommitted changes/);
    expect(compare(repo(), repo({ dirty: true })).warnings.join()).toMatch(/target has uncommitted changes/);
  });

  test("warns when the target directory or repository is missing", () => {
    expect(compare(repo(), { kind: "missing-dir" }).warnings.join()).toMatch(/\/home\/tester\/proj\/app does not exist/);
    expect(compare(repo(), { kind: "not-a-repo" }).warnings.join()).toMatch(/not a git repository/);
    expect(compare(repo(), { kind: "missing-dir" }).status).toBe("mismatch");
  });

  test("skips the comparison when the source is not a repository", () => {
    expect(compare({ kind: "not-a-repo" }, { kind: "not-a-repo" })).toMatchObject({ status: "skipped", warnings: [] });
    expect(compare({ kind: "missing-dir" }, repo())).toMatchObject({ status: "skipped", warnings: [] });
  });

  test("still warns about a missing target directory when the source is not a repository", () => {
    const result = compare({ kind: "not-a-repo" }, { kind: "missing-dir" });
    expect(result.status).toBe("mismatch");
    expect(result.warnings).toHaveLength(1);
  });
});

describe("gitState", () => {
  const git = "git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false";

  test("reads remote, branch, HEAD and dirtiness from a real repository", async () => {
    const dir = await tempDir();
    const machine = new LocalTarget(dir);
    await sh(`git init -q -b trunk . && git remote add origin https://example.com/demo.git && echo one > a.txt && git add a.txt && ${git} commit -q -m first`, dir);
    const head = (await sh("git rev-parse HEAD", dir)).trim();

    expect(await gitState(machine, dir)).toEqual({ kind: "repo", remote: "https://example.com/demo.git", branch: "trunk", head, dirty: false });

    await sh("echo two >> a.txt", dir);
    expect(await gitState(machine, dir)).toMatchObject({ dirty: true });
  });

  test("reports plain and missing directories", async () => {
    const dir = await tempDir();
    const machine = new LocalTarget(dir);
    expect(await gitState(machine, dir)).toEqual({ kind: "not-a-repo" });
    expect(await gitState(machine, join(dir, "no such dir"))).toEqual({ kind: "missing-dir" });
  });
});
