import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeCodeStore, type Install } from "../src/claude-code-store.ts";
import { LocalTarget, SshTarget } from "../src/target.ts";
import { cleanupTempDirs, installFakeClaude, SESSION_ID, tempDir } from "./helpers.ts";

afterAll(cleanupTempDirs);

const install = (over: Partial<Install> = {}): Install => ({ home: "/home/tester", claude: "home", version: "2.1.322", ...over });

describe("encodeCwd", () => {
  test("replaces every non-alphanumeric character with a dash", () => {
    expect(ClaudeCodeStore.encodeCwd("/Users/testuser")).toBe("-Users-testuser");
    expect(ClaudeCodeStore.encodeCwd("/home/tester/.config/projects")).toBe("-home-tester--config-projects");
    expect(ClaudeCodeStore.encodeCwd("/Users/testuser/my proj_v2.1")).toBe("-Users-testuser-my-proj-v2-1");
  });
});

describe("isSessionId", () => {
  test("accepts plain names and rejects anything that could leave the folder", () => {
    expect(ClaudeCodeStore.isSessionId(SESSION_ID)).toBe(true);
    expect(ClaudeCodeStore.isSessionId("")).toBe(false);
    expect(ClaudeCodeStore.isSessionId("../etc/passwd")).toBe(false);
    expect(ClaudeCodeStore.isSessionId("a b")).toBe(false);
    expect(ClaudeCodeStore.isSessionId(".hidden")).toBe(false);
  });
});

describe("storage layout", () => {
  test("layout places a session relative to a home", () => {
    expect(ClaudeCodeStore.layout("-home-tester-proj-app", SESSION_ID)).toEqual({
      projectDir: ".claude/projects/-home-tester-proj-app",
      mainLog: `.claude/projects/-home-tester-proj-app/${SESSION_ID}.jsonl`,
      sidecarDir: `.claude/projects/-home-tester-proj-app/${SESSION_ID}`,
      fileHistoryRoot: ".claude/file-history",
      fileHistoryDir: `.claude/file-history/${SESSION_ID}`,
    });
  });

  test("sessionPaths are the same places under a given home", () => {
    expect(ClaudeCodeStore.projectsDir("/Users/testuser")).toBe("/Users/testuser/.claude/projects");
    expect(ClaudeCodeStore.sessionPaths("/Users/testuser", "-Users-testuser-proj-app", SESSION_ID)).toEqual({
      projectDir: "/Users/testuser/.claude/projects/-Users-testuser-proj-app",
      mainLog: `/Users/testuser/.claude/projects/-Users-testuser-proj-app/${SESSION_ID}.jsonl`,
      sidecarDir: `/Users/testuser/.claude/projects/-Users-testuser-proj-app/${SESSION_ID}`,
      fileHistoryDir: `/Users/testuser/.claude/file-history/${SESSION_ID}`,
    });
  });

  test("selfMap sends the session's old folder to its new one", () => {
    expect(ClaudeCodeStore.selfMap("/Users/testuser/.claude/projects/-Users-testuser-proj-app", "/home/tester", "-home-tester-proj-app")).toEqual({
      from: "/Users/testuser/.claude/projects/-Users-testuser-proj-app",
      to: "/home/tester/.claude/projects/-home-tester-proj-app",
    });
  });

  test("fileKind classifies logs, metadata and tool results", () => {
    expect(ClaudeCodeStore.fileKind(`${SESSION_ID}.jsonl`)).toBe("jsonl");
    expect(ClaudeCodeStore.fileKind("subagents/agent-a1.jsonl")).toBe("jsonl");
    expect(ClaudeCodeStore.fileKind("subagents/agent-a1.meta.json")).toBe("json");
    expect(ClaudeCodeStore.fileKind("tool-results/b1.txt")).toBe("text");
    expect(ClaudeCodeStore.fileKind("abc123@v1")).toBe("other");
  });
});

describe("sessionCwd", () => {
  const line = (cwd: string) => JSON.stringify({ type: "user", cwd });

  test("prefers the cwd that encodes to the folder name", () => {
    const log = [line("/Users/testuser/proj/app/src"), line("/Users/testuser/proj/app")].join("\n");
    expect(ClaudeCodeStore.sessionCwd(log, "-Users-testuser-proj-app")).toEqual({ cwd: "/Users/testuser/proj/app", matchesFolder: true });
  });

  test("falls back to the first cwd when none matches", () => {
    const log = [line("/Users/testuser/a"), line("/Users/testuser/b")].join("\n");
    expect(ClaudeCodeStore.sessionCwd(log, "-somewhere-else")).toEqual({ cwd: "/Users/testuser/a", matchesFolder: false });
  });

  test("skips records without a cwd and lines that are not JSON", () => {
    const log = ['{"type":"mode"}', '{"cwd": broken', line("/Users/testuser/proj/app")].join("\n");
    expect(ClaudeCodeStore.sessionCwd(log, "-Users-testuser-proj-app")?.cwd).toBe("/Users/testuser/proj/app");
    expect(ClaudeCodeStore.sessionCwd('{"type":"mode"}\n', "-x")).toBeNull();
  });
});

describe("version check", () => {
  test("parseVersion extracts the version number", () => {
    expect(ClaudeCodeStore.parseVersion("2.1.322 (Claude Code)")).toBe("2.1.322");
    expect(ClaudeCodeStore.parseVersion("")).toBeNull();
    expect(ClaudeCodeStore.parseVersion(undefined)).toBeNull();
  });

  test("passes only when both sides report the same version", () => {
    expect(ClaudeCodeStore.checkVersions(install(), install({ home: "/Users/testuser" }))).toEqual({
      ok: true,
      summary: "Claude Code 2.1.322 on both machines",
    });
    expect(ClaudeCodeStore.checkVersions(install(), install({ version: "2.0.9" }))).toEqual({
      ok: false,
      problem: "Claude Code versions differ: source 2.1.322, target 2.0.9",
    });
  });

  test("an unreadable version on either side is a failure", () => {
    expect(ClaudeCodeStore.checkVersions(install(), install({ claude: null, version: null }))).toEqual({
      ok: false,
      problem: "Claude Code versions differ: source 2.1.322, target not found",
    });
    expect(ClaudeCodeStore.checkVersions(install({ version: null }), install({ version: null })).ok).toBe(false);
  });
});

describe("inspect", () => {
  test("reports home and the version of ~/.local/bin/claude", async () => {
    const home = await tempDir();
    await installFakeClaude(home, "9.8.7");
    expect(await ClaudeCodeStore.inspect(new LocalTarget(home))).toEqual({ home, claude: "home", version: "9.8.7" });
  });

  test("falls back to claude on PATH, or reports none", async () => {
    const home = await tempDir();
    const elsewhere = await tempDir();
    await installFakeClaude(elsewhere, "1.2.3");
    const machine = new LocalTarget(home);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `${join(elsewhere, ".local", "bin")}:/usr/bin:/bin`;
      expect(await ClaudeCodeStore.inspect(machine)).toEqual({ home, claude: "path", version: "1.2.3" });
      process.env.PATH = "/usr/bin:/bin";
      expect(await ClaudeCodeStore.inspect(machine)).toEqual({ home, claude: null, version: null });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("resumeCommand", () => {
  test("calls claude by full path, because ~/.local/bin is not on PATH over SSH", () => {
    expect(ClaudeCodeStore.resumeCommand(install(), SESSION_ID, { expandHome: false })).toBe(`~/.local/bin/claude --resume ${SESSION_ID}`);
  });

  test("falls back to claude on PATH when that is where it was found", () => {
    expect(ClaudeCodeStore.resumeCommand(install({ claude: "path" }), SESSION_ID, { expandHome: false })).toBe(`claude --resume ${SESSION_ID}`);
  });

  test("spells the home out when asked", () => {
    expect(ClaudeCodeStore.resumeCommand(install({ home: "/tmp/fake home" }), "abc", { expandHome: true })).toBe(
      "'/tmp/fake home/.local/bin/claude' --resume abc",
    );
  });

  test("combined with an ssh target it is the command from the README", () => {
    const command = ClaudeCodeStore.resumeCommand(install(), SESSION_ID, { expandHome: false });
    expect(new SshTarget("myserver").resumeCommand("/home/tester/proj/app", command)).toBe(
      `ssh -t myserver 'cd /home/tester/proj/app && ~/.local/bin/claude --resume ${SESSION_ID}'`,
    );
  });
});
