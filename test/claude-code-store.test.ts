import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeCodeStore, type Install } from "../src/claude-code-store.ts";
import { LocalTarget, SshTarget } from "../src/target.ts";
import { rewriteJsonl } from "../src/rewrite.ts";
import { cleanupTempDirs, installFakeClaude, MAC_TO_LINUX, parseJsonl, SESSION_ID, tempDir, TOOL_FIXTURE } from "./helpers.ts";

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

describe("locations are rewritten, file contents are not", () => {
  const OLD = "/Users/testuser/demo";
  const NEW = "/home/tester/demo";
  const load = async () => {
    const text = await Bun.file(TOOL_FIXTURE).text();
    const result = rewriteJsonl(text, MAC_TO_LINUX, ClaudeCodeStore.contentGuard(text));
    return { before: parseJsonl(text), after: parseJsonl(result.text), result, text };
  };

  test("Write: file_path moves, content stays, in the message and in the wire copy", async () => {
    const { after } = await load();
    const expected = { file_path: `${NEW}/summary.txt`, content: `notes live at ${OLD}/notes.txt\n` };
    expect(after[1].message.content[0].input).toEqual(expected);
    expect(after[1].wireToolInputs.toolu_w1).toEqual(expected);
  });

  test("Write result: the confirmation and filePath move, the recorded content stays", async () => {
    const { after } = await load();
    expect(after[2].message.content[0].content).toBe(`File created successfully at: ${NEW}/summary.txt`);
    expect(after[2].toolUseResult).toMatchObject({ filePath: `${NEW}/summary.txt`, content: `notes live at ${OLD}/notes.txt\n` });
  });

  test("Read: file_path moves, the text it returned stays", async () => {
    const { after } = await load();
    expect(after[3].message.content[0].input).toEqual({ file_path: `${NEW}/summary.txt` });
    expect(after[4].message.content[0].content).toBe(`1\tnotes live at ${OLD}/notes.txt`);
    expect(after[4].toolUseResult.file).toEqual({
      filePath: `${NEW}/summary.txt`,
      content: `notes live at ${OLD}/notes.txt\n`,
      numLines: 1,
      startLine: 1,
      totalLines: 1,
    });
  });

  test("Edit: file_path moves, old_string and new_string stay, also in the result", async () => {
    const { after, before } = await load();
    const input = { replace_all: false, file_path: `${NEW}/summary.txt`, old_string: `notes live at ${OLD}/notes.txt`, new_string: `notes: ${OLD}/notes.txt` };
    expect(after[5].message.content[0].input).toEqual(input);
    expect(after[5].wireToolInputs.toolu_e1).toEqual(input);
    expect(after[6].message.content[0].content).toBe(`The file ${NEW}/summary.txt has been updated successfully.`);
    expect(after[6].toolUseResult).toEqual({ ...before[6].toolUseResult, filePath: `${NEW}/summary.txt` });
  });

  test("Bash: the command and its output keep the generic behaviour", async () => {
    const { after } = await load();
    expect(after[7].message.content[0].input.command).toBe(`ls -la ${NEW}`);
    expect(after[7].wireToolInputs.toolu_b1.command).toBe(`ls -la ${NEW}`);
    expect(after[8].message.content[0].content).toBe(`${NEW}:\nnotes.txt\nsummary.txt`);
    expect(after[8].toolUseResult.stdout).toBe(`${NEW}:\nnotes.txt\nsummary.txt`);
  });

  test("a failed Read is an error message about a location, so it is rewritten", async () => {
    const { after } = await load();
    expect(after[10].message.content[0].content).toBe(`File does not exist. Note: your current working directory is ${NEW}.`);
    expect(after[10].toolUseResult).toBe(`Error: File does not exist. Note: your current working directory is ${NEW}.`);
  });

  test("MultiEdit edits and NotebookEdit new_source stay; notebook_path and Grep/Glob path move", async () => {
    const { after } = await load();
    const inputs = after[11].message.content.map((block: any) => block.input);
    expect(inputs[0]).toEqual({ file_path: `${NEW}/summary.txt`, edits: [{ old_string: `${OLD}/notes.txt`, new_string: `${OLD}/notes.md` }] });
    expect(inputs[1]).toEqual({ notebook_path: `${NEW}/nb.ipynb`, new_source: `open('${OLD}/notes.txt')` });
    expect(inputs[2]).toEqual({ pattern: "notes", path: NEW });
    expect(inputs[3]).toEqual({ pattern: "**/*.txt", path: NEW });
  });

  test("a field called content on some other tool is not file content", async () => {
    const { after } = await load();
    expect(after[11].message.content[4].input).toEqual({ content: `stored under ${NEW}` });
  });

  test("request-blob copies follow the same rules", async () => {
    const { after } = await load();
    expect(after[12].message.content[0].input).toEqual({ file_path: `${NEW}/summary.txt`, content: `notes live at ${OLD}/notes.txt\n` });
    expect(after[13].message.content[0].content).toEqual([{ type: "text", text: `1\tnotes live at ${OLD}/notes.txt` }]);
  });

  test("a file attached to a prompt: its name moves, its text stays", async () => {
    const { after } = await load();
    expect(after[14].attachment.filename).toBe(`${NEW}/notes.txt`);
    expect(after[14].attachment.content.file).toMatchObject({ filePath: `${NEW}/notes.txt`, content: `see ${OLD}/summary.txt\n` });
  });

  test("every record's cwd moves", async () => {
    const { after } = await load();
    expect(after.filter((r) => "cwd" in r).map((r) => r.cwd)).toEqual(Array(13).fill(NEW));
  });

  test("the generic rewrite, without the guard, is what changed the file contents", async () => {
    const { text } = await load();
    const generic = parseJsonl(rewriteJsonl(text, MAC_TO_LINUX).text);
    expect(generic[1].message.content[0].input.content).toBe(`notes live at ${NEW}/notes.txt\n`);
    expect(generic[4].message.content[0].content).toBe(`1\tnotes live at ${NEW}/notes.txt`);
  });

  test("toolNames indexes every tool call by id", async () => {
    const { text } = await load();
    const names = ClaudeCodeStore.toolNames(text);
    expect(names.get("toolu_w1")).toBe("Write");
    expect(names.get("toolu_r1")).toBe("Read");
    expect(names.get("toolu_x1")).toBe("mcp__notes__save");
    expect(names.size).toBe(10);
  });

  test("contentFields names what it found", async () => {
    const { text, before } = await load();
    const names = ClaudeCodeStore.toolNames(text);
    const what = (index: number) => ClaudeCodeStore.contentFields(before[index], names).map((f) => f.what);
    expect(what(0)).toEqual([]);
    expect(what(1)).toEqual(["Write content", "Write content (wire copy)"]);
    expect(what(2)).toEqual(["Write toolUseResult content", "Write toolUseResult originalFile", "Write toolUseResult structuredPatch"]);
    expect(what(4)).toEqual(["Read result text", "Read toolUseResult file content"]);
    expect(what(5)).toEqual(["Edit old_string", "Edit new_string", "Edit old_string (wire copy)", "Edit new_string (wire copy)"]);
    expect(what(8)).toEqual([]);
    expect(what(10)).toEqual([]);
    expect(what(11)).toEqual(["MultiEdit edits", "NotebookEdit new_source"]);
    expect(what(14)).toEqual(["attached file content"]);
  });

  test("a result whose tool call is not in the log keeps the generic behaviour", () => {
    const record = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_unknown", content: `1\t${OLD}/a.txt` }] } };
    const text = JSON.stringify(record) + "\n";
    expect(parseJsonl(rewriteJsonl(text, MAC_TO_LINUX, ClaudeCodeStore.contentGuard(text)).text)[0].message.content[0].content).toBe(`1\t${NEW}/a.txt`);
  });
});
