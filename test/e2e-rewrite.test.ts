/**
 * End to end in the default rewrite mode. The symlink-mode flow is covered by
 * e2e.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeStore } from "../src/claude-code-store.ts";
import {
  cleanupTempDirs,
  FIXTURE,
  installFakeClaude,
  installToolSession,
  makeSourceHome,
  makeTargetHome,
  parseJsonl,
  runCli,
  SESSION_ID,
  snapshot,
  tempDir,
  TOOL_FIXTURE,
  TOOL_SESSION_ID,
} from "./helpers.ts";

afterAll(cleanupTempDirs);

const MAP = "/Users/testuser=/home/tester";
const TARGET_FOLDER = "-home-tester-proj-app";

describe("rewrite mode", () => {
  test("lands in the folder for the mapped cwd, with paths mapped in every file", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const before = await snapshot(join(source, ".claude"));

    const result = await runCli([SESSION_ID, `local:${target}`, "--map", MAP], source);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const copied = await snapshot(join(target, ".claude"));
    const base = `projects/${TARGET_FOLDER}/${SESSION_ID}`;
    expect(Object.keys(copied).sort()).toEqual([
      `file-history/${SESSION_ID}/abc123@v1`,
      `${base}.jsonl`,
      `${base}/subagents/agent-a1.jsonl`,
      `${base}/subagents/agent-a1.meta.json`,
      `${base}/tool-results/b1.txt`,
    ]);

    const fixture = await snapshot(FIXTURE);
    const original = parseJsonl(fixture["main.jsonl"]!);
    const main = parseJsonl(copied[`${base}.jsonl`]!);
    expect(main.map((r) => r.type)).toEqual(original.map((r) => r.type));
    expect(main.map((r) => Object.keys(r))).toEqual(original.map((r) => Object.keys(r)));
    expect(main.filter((r) => r.cwd).map((r) => r.cwd)).toEqual([
      "/home/tester/proj/app",
      "/home/tester/proj/app",
      "/home/tester/proj/app",
      "/home/tester/proj/app",
      "/home/tester/proj/app/src",
    ]);
    expect(main[2].message.content[1].input.file_path).toBe("/home/tester/proj/app/src/main.ts");
    // The text a Read returned is file content: it must come through exactly as recorded.
    expect(main[3].message.content[0].content).toBe(original[3].message.content[0].content);
    expect(main[3].toolUseResult.file.filePath).toBe("/home/tester/proj/app/src/main.ts");
    expect(main[3].message.content[0].content).toContain("/Volumes/backup/Users/testuser/archive");
    expect(main[3].message.content[0].content).toContain("/Users/testuserx/other/file.ts");
    expect(Object.keys(main[7].snapshot.trackedFileBackups)).toEqual(["/home/tester/proj/app/src/main.ts"]);
    expect(main[7].snapshot.trackedFileBackups["/home/tester/proj/app/src/main.ts"].realParentDir).toBe("/home/tester/proj/app/src");

    const agent = parseJsonl(copied[`${base}/subagents/agent-a1.jsonl`]!);
    expect(agent).toHaveLength(3);
    expect(agent[0].cwd).toBe("/home/tester/proj/app");
    expect(agent[1].message.content[0].input.path).toBe("/home/tester/proj/app/src");
    expect(JSON.parse(copied[`${base}/subagents/agent-a1.meta.json`]!)).toEqual({
      agentType: "general-purpose",
      description: "Inspect /home/tester/proj/app/src",
      toolUseId: "toolu_03",
      finished: true,
    });
    expect(copied[`${base}/tool-results/b1.txt`]).toBe(
      "/home/tester/proj/app/src/main.ts:12: error TS2322: type mismatch\n" +
        "/home/tester/proj/app/src/old.ts:3: warning: unused import\n" +
        "see also /Users/testuserx/unrelated.log\n",
    );
    // Checkpoints are the user's own file contents and are never rewritten.
    expect(copied[`file-history/${SESSION_ID}/abc123@v1`]).toBe(fixture["file-history/abc123@v1"]!);
    // The originals are never modified.
    expect(await snapshot(join(source, ".claude"))).toEqual(before);
  });

  test("reports records rewritten per file and the resume command", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const { stdout } = await runCli([SESSION_ID, `local:${target}`, "--map", MAP], source);
    expect(stdout).toMatch(new RegExp(`${SESSION_ID}\\.jsonl\\s+11 records, 8 rewritten, 18 paths replaced`));
    expect(stdout).toMatch(/subagents\/agent-a1\.jsonl\s+3 records, 2 rewritten, 4 paths replaced/);
    expect(stdout).toMatch(/subagents\/agent-a1\.meta\.json\s+1 path replaced/);
    expect(stdout).toMatch(/tool-results\/b1\.txt\s+2 paths replaced/);
    expect(stdout).toContain("total: 5 files");
    expect(stdout).toContain("10 records rewritten, 25 paths replaced");
    expect(stdout).toContain("copied and verified 5 files");
    expect(stdout).toContain(`cd /home/tester/proj/app && HOME=${target} ${target}/.local/bin/claude --resume ${SESSION_ID}`);
  });

  test("--dry-run rewrites into a temp dir, reports, copies nothing and cleans up", async () => {
    const source = await makeSourceHome();
    const target = await makeTargetHome();
    const scratch = await tempDir("sessmv-tmp-");
    const result = await runCli([SESSION_ID, `local:${target}`, "--map", MAP, "--dry-run"], source, { TMPDIR: scratch });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/11 records, 8 rewritten, 18 paths replaced/);
    expect(result.stdout).toContain("nothing was copied");
    expect(await snapshot(join(target, ".claude"))).toEqual({});
    expect(await readdir(scratch)).toEqual([]);
  });

  test("moves locations but leaves file contents as the files on disk have them", async () => {
    const source = await tempDir("sessmv-src-");
    const target = await makeTargetHome();
    await installFakeClaude(source, "2.1.322");
    await installToolSession(source);

    const result = await runCli([TOOL_SESSION_ID, `local:${target}`, "--map", "/Users/testuser=/home/tester"], source);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const copied = await snapshot(join(target, ".claude", "projects"));
    expect(Object.keys(copied)).toEqual([`-home-tester-demo/${TOOL_SESSION_ID}.jsonl`]);
    const before = parseJsonl(await Bun.file(TOOL_FIXTURE).text());
    const after = parseJsonl(copied[`-home-tester-demo/${TOOL_SESSION_ID}.jsonl`]!);

    // The bug: a Write whose content names a mapped path, and the Read that returned it.
    expect(after[1].message.content[0].input).toEqual({
      file_path: "/home/tester/demo/summary.txt",
      content: "notes live at /Users/testuser/demo/notes.txt\n",
    });
    expect(after[4].message.content[0].content).toBe("1\tnotes live at /Users/testuser/demo/notes.txt");
    expect(after[4].toolUseResult.file.content).toBe("notes live at /Users/testuser/demo/notes.txt\n");
    // Edits keep their text too, and locations still move.
    expect(after[5].message.content[0].input.old_string).toBe(before[5].message.content[0].input.old_string);
    expect(after[5].message.content[0].input.file_path).toBe("/home/tester/demo/summary.txt");
    expect(after[7].message.content[0].input.command).toBe("ls -la /home/tester/demo");
    expect(after.filter((r) => "cwd" in r).every((r) => r.cwd === "/home/tester/demo")).toBe(true);
    expect(result.stdout).toMatch(new RegExp(`${TOOL_SESSION_ID}\\.jsonl\\s+15 records, 14 rewritten, 40 paths replaced`));
  });

  test("stops before copying when two checkpoint keys would map to the same path", async () => {
    const id = "cccccccc-dddd-4eee-8fff-000000000000";
    const source = await tempDir("sessmv-src-");
    const target = await makeTargetHome();
    const scratch = await tempDir("sessmv-tmp-");
    await installFakeClaude(source, "2.1.322");
    const folder = join(source, ".claude", "projects", "-Users-testuser-proj");
    await mkdir(folder, { recursive: true });
    const records = [
      { type: "user", cwd: "/Users/testuser/proj", sessionId: id },
      { type: "file-history-snapshot", snapshot: { trackedFileBackups: { "/Users/testuser/a.ts": { version: 1 }, "/Volumes/work/a.ts": { version: 1 } } } },
    ];
    await writeFile(join(folder, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = await runCli([id, `local:${target}`, "--map", "/Users/testuser=/srv/shared", "--map", "/Volumes/work=/srv/shared"], source, { TMPDIR: scratch });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`cannot rewrite ${id}.jsonl`);
    expect(result.stderr).toContain("/Users/testuser/a.ts");
    expect(result.stderr).toContain("/Volumes/work/a.ts");
    expect(result.stderr).toContain("/srv/shared/a.ts");
    expect(result.stderr).toContain("line 2");
    expect(await snapshot(join(target, ".claude"))).toEqual({});
    expect(await readdir(scratch)).toEqual([]);
  });

  test("the default map sends source HOME to target HOME, including the session's own folder", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const source = await tempDir("sessmv-src-");
    const target = await tempDir("sessmv-dst-");
    await installFakeClaude(source, "2.1.322");
    await installFakeClaude(target, "2.1.322");
    const cwd = join(source, "work");
    const sourceFolder = join(source, ".claude", "projects", ClaudeCodeStore.encodeCwd(cwd));
    await mkdir(sourceFolder, { recursive: true });
    const saved = `${sourceFolder}/${id}/tool-results/out.txt`;
    const records = [
      { type: "user", cwd, sessionId: id, message: { role: "user", content: `open ${cwd}/a.txt` } },
      { type: "user", cwd, sessionId: id, toolUseResult: { persistedOutputPath: saved } },
    ];
    await writeFile(join(sourceFolder, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = await runCli([id, `local:${target}`], source);

    expect(result.code).toBe(0);
    const targetFolder = ClaudeCodeStore.encodeCwd(`${target}/work`);
    const copied = await snapshot(join(target, ".claude", "projects"));
    expect(Object.keys(copied)).toEqual([`${targetFolder}/${id}.jsonl`]);
    expect(parseJsonl(copied[`${targetFolder}/${id}.jsonl`]!)).toEqual([
      { type: "user", cwd: `${target}/work`, sessionId: id, message: { role: "user", content: `open ${target}/work/a.txt` } },
      { type: "user", cwd: `${target}/work`, sessionId: id, toolUseResult: { persistedOutputPath: `${target}/.claude/projects/${targetFolder}/${id}/tool-results/out.txt` } },
    ]);
  });
});
