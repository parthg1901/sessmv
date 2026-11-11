/**
 * End to end through the real CLI: a fake source HOME built from fixtures and
 * a `local:<tmpdir>` target. These use symlink mode (byte-for-byte), so they
 * pass while src/rewrite.ts is a stub; rewrite mode is in e2e-rewrite.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeStore } from "../src/claude-code-store.ts";
import {
  cleanupTempDirs,
  FIXTURE,
  installFakeClaude,
  installFixtureSession,
  makeSourceHome,
  makeTargetHome,
  runCli,
  SESSION_ID,
  sh,
  snapshot,
  tempDir,
} from "./helpers.ts";

afterAll(cleanupTempDirs);

const MAP = "/Users/testuser=/home/tester";
const TARGET_FOLDER = "-home-tester-proj-app";
const symlinkArgs = (target: string, ...extra: string[]) => [SESSION_ID, `local:${target}`, "--map", MAP, "--mode", "symlink", ...extra];

async function expectedTargetFiles(): Promise<Record<string, string>> {
  const fixture = await snapshot(FIXTURE);
  return {
    [`projects/${TARGET_FOLDER}/${SESSION_ID}.jsonl`]: fixture["main.jsonl"]!,
    [`projects/${TARGET_FOLDER}/${SESSION_ID}/subagents/agent-a1.jsonl`]: fixture["subagents/agent-a1.jsonl"]!,
    [`projects/${TARGET_FOLDER}/${SESSION_ID}/subagents/agent-a1.meta.json`]: fixture["subagents/agent-a1.meta.json"]!,
    [`projects/${TARGET_FOLDER}/${SESSION_ID}/tool-results/b1.txt`]: fixture["tool-results/b1.txt"]!,
    [`file-history/${SESSION_ID}/abc123@v1`]: fixture["file-history/abc123@v1"]!,
  };
}

describe("symlink mode", () => {
  test("copies the session byte-for-byte into the folder for the mapped cwd", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const before = await snapshot(join(source, ".claude"));

    const result = await runCli(symlinkArgs(target), source);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await snapshot(join(target, ".claude"))).toEqual(await expectedTargetFiles());
    expect(await snapshot(join(source, ".claude"))).toEqual(before);
  });

  test("prints the summary, the symlink commands and the resume command", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const { stdout } = await runCli(symlinkArgs(target), source);

    expect(stdout).toContain("source cwd     /Users/testuser/proj/app");
    expect(stdout).toContain("target cwd     /home/tester/proj/app");
    expect(stdout).toContain("/Users/testuser -> /home/tester");
    expect(stdout).toContain("ok: Claude Code 2.1.322 on both machines");
    expect(stdout).toContain("sudo mkdir -p /Users");
    expect(stdout).toContain("sudo ln -s /home/tester /Users/testuser");
    expect(stdout).toContain("total: 5 files");
    expect(stdout).toContain("copied and verified 5 files");
    expect(stdout).toContain(`cd /home/tester/proj/app && HOME=${target} ${target}/.local/bin/claude --resume ${SESSION_ID}`);
  });

  test("warns loudly, without failing, when the mapped cwd is missing on the target", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const result = await runCli(symlinkArgs(target), source);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WARNING: /home/tester/proj/app does not exist on the target");
  });

  test("a cwd outside every map keeps its path", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const result = await runCli([SESSION_ID, `local:${target}`, "--mode", "symlink"], source);
    expect(result.code).toBe(0);
    expect(Object.keys(await snapshot(join(target, ".claude", "projects")))).toContain(`-Users-testuser-proj-app/${SESSION_ID}.jsonl`);
  });
});

describe("--dry-run", () => {
  test("prints the summary and copies nothing", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const result = await runCli(symlinkArgs(target, "--dry-run"), source);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nothing was copied");
    expect(result.stdout).toContain("total: 5 files");
    expect(result.stdout).toContain(`--resume ${SESSION_ID}`);
    expect(await snapshot(join(target, ".claude"))).toEqual({});
  });
});

describe("locating the session", () => {
  test("fails clearly when the session does not exist", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const result = await runCli(["99999999-0000-4000-8000-000000000000", `local:${target}`], source);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("session 99999999-0000-4000-8000-000000000000 not found");
  });

  test("fails clearly when the session is in two project folders", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    await installFixtureSession(source, "-Users-testuser-proj-other");
    const result = await runCli(symlinkArgs(target), source);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("-Users-testuser-proj-app");
    expect(result.stderr).toContain("-Users-testuser-proj-other");
    expect(await snapshot(join(target, ".claude"))).toEqual({});
  });
});

describe("version check", () => {
  test("refuses when the versions differ", async () => {
    const source = await makeSourceHome("2.1.322");
    const target = await makeTargetHome("2.0.9");
    const result = await runCli(symlinkArgs(target), source);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Claude Code versions differ: source 2.1.322, target 2.0.9");
    expect(await snapshot(join(target, ".claude"))).toEqual({});
  });

  test("--force copies anyway and says so", async () => {
    const source = await makeSourceHome("2.1.322");
    const target = await makeTargetHome("2.0.9");
    const result = await runCli(symlinkArgs(target, "--force"), source);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WARNING: Claude Code versions differ: source 2.1.322, target 2.0.9");
    expect(await snapshot(join(target, ".claude"))).toEqual(await expectedTargetFiles());
  });

  test("refuses when Claude Code is not installed on the target", async () => {
    const source = await makeSourceHome();
    const target = await tempDir("sessmv-dst-");
    const result = await runCli(symlinkArgs(target), source, { PATH: "/usr/bin:/bin" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("source 2.1.322, target not found");
  });
});

describe("existing session on the target", () => {
  test("is never overwritten without --force", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    expect((await runCli(symlinkArgs(target), source)).code).toBe(0);
    const log = join(target, ".claude", "projects", TARGET_FOLDER, `${SESSION_ID}.jsonl`);
    await writeFile(log, '{"type":"user","note":"continued on the target"}\n');
    const before = await snapshot(join(target, ".claude"));

    const result = await runCli(symlinkArgs(target), source);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stderr).toContain("--force");
    expect(await snapshot(join(target, ".claude"))).toEqual(before);
  });

  test("--force replaces it, including files the source does not have", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    expect((await runCli(symlinkArgs(target), source)).code).toBe(0);
    await writeFile(join(target, ".claude", "projects", TARGET_FOLDER, SESSION_ID, "tool-results", "stale.txt"), "stale");

    const result = await runCli(symlinkArgs(target, "--force"), source);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("replacing the existing copy");
    expect(await snapshot(join(target, ".claude"))).toEqual(await expectedTargetFiles());
  });

  test("--dry-run reports it instead of failing", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    expect((await runCli(symlinkArgs(target), source)).code).toBe(0);
    const result = await runCli(symlinkArgs(target, "--dry-run"), source);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("a real run needs --force");
  });
});

describe("default map and git check", () => {
  const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const git = "git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false";

  /** Source and target homes that each hold a clone of one repository at ~/work, plus a session started there. */
  async function workspace() {
    const source = await tempDir("sessmv-src-");
    const target = await tempDir("sessmv-dst-");
    const origin = join(await tempDir("sessmv-origin-"), "demo.git");
    await installFakeClaude(source, "2.1.322");
    await installFakeClaude(target, "2.1.322");
    await sh(`git init -q --bare -b main "${origin}"`, source);
    await sh(`git clone -q "${origin}" work 2>/dev/null && cd work && git checkout -q -b main && echo one > a.txt && git add a.txt && ${git} commit -q -m first && git push -q origin main`, source);
    await sh(`git clone -q "${origin}" work`, target);

    const cwd = join(source, "work");
    const projectDir = join(source, ".claude", "projects", ClaudeCodeStore.encodeCwd(cwd));
    await mkdir(projectDir, { recursive: true });
    const records = [
      { type: "user", cwd, sessionId: ID, message: { role: "user", content: `list ${cwd}` } },
      { type: "assistant", cwd, sessionId: ID, message: { role: "assistant", content: [{ type: "text", text: "a.txt" }] } },
    ];
    await writeFile(join(projectDir, `${ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return { source, target, cwd };
  }

  test("maps source HOME to target HOME by default and reports matching repositories", async () => {
    const { source, target } = await workspace();
    const result = await runCli([ID, `local:${target}`, "--mode", "symlink"], source);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${source} -> ${target}`);
    expect(result.stdout).toContain(`target cwd     ${target}/work`);
    expect(result.stdout).toContain("ok: same remote, branch and commit, both clean");
    expect(result.stdout).not.toContain("differs");
    expect(Object.keys(await snapshot(join(target, ".claude", "projects")))).toEqual([`${ClaudeCodeStore.encodeCwd(`${target}/work`)}/${ID}.jsonl`]);
  });

  test("warns about a different branch, commit and uncommitted changes without blocking", async () => {
    const { source, target, cwd } = await workspace();
    await sh(`echo two >> a.txt && ${git} commit -q -am second && echo three >> a.txt`, cwd);
    await sh("git checkout -q -b feature && echo local > b.txt", join(target, "work"));

    const result = await runCli([ID, `local:${target}`, "--mode", "symlink"], source);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("WARNING: branch differs: source main, target feature");
    expect(result.stdout).toContain("WARNING: HEAD differs");
    expect(result.stdout).toContain("WARNING: source has uncommitted changes");
    expect(result.stdout).toContain("WARNING: target has uncommitted changes");
    expect(result.stdout).not.toContain("remote differs");
    expect(Object.keys(await snapshot(join(target, ".claude", "projects")))).toHaveLength(1);
  });

  test("warns when the target has the directory but no repository", async () => {
    const { source } = await workspace();
    const target = await makeTargetHome();
    await mkdir(join(target, "work"));
    const result = await runCli([ID, `local:${target}`, "--mode", "symlink", "--dry-run"], source);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/WARNING: source is a git repository but .*\/work on the target is not/);
  });
});

describe("usage errors", () => {
  test.each([
    ["no arguments", []],
    ["a missing target", [SESSION_ID]],
    ["an unknown mode", [SESSION_ID, "local:/tmp/x", "--mode", "warp"]],
    ["a malformed map", [SESSION_ID, "local:/tmp/x", "--map", "/Users/testuser"]],
    ["an unknown option", [SESSION_ID, "local:/tmp/x", "--frobnicate"]],
  ])("exits 2 with usage on %s", async (_name, args) => {
    const result = await runCli(args, await tempDir());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: sessmv");
  });

  test("--help prints usage", async () => {
    const result = await runCli(["--help"], await tempDir());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: sessmv");
  });
});
