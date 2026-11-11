import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeStore } from "../src/claude-code-store.ts";
import { copyToTarget, existingOnTarget, prepare } from "../src/copy.ts";
import { locateSession } from "../src/locate.ts";
import { LocalTarget } from "../src/target.ts";
import { cleanupTempDirs, installFixtureSession, SESSION_ID, snapshot, tempDir } from "./helpers.ts";

afterAll(cleanupTempDirs);

const layout = ClaudeCodeStore.layout("-home-tester-proj-app", SESSION_ID);

async function fixtureSession() {
  const home = await tempDir();
  await installFixtureSession(home);
  return { home, session: await locateSession(home, SESSION_ID) };
}

describe("prepare (symlink mode)", () => {
  test("lists the originals without writing anything", async () => {
    const { home, session } = await fixtureSession();
    const before = await snapshot(home);
    const prepared = await prepare(session, "symlink", []);
    expect(prepared.mainLog).toBe(session.mainLog);
    expect(prepared.sidecarDir).toBe(session.sidecarDir);
    expect(prepared.files.map((f) => f.rel)).toEqual([
      `${SESSION_ID}.jsonl`,
      `${SESSION_ID}/subagents/agent-a1.jsonl`,
      `${SESSION_ID}/subagents/agent-a1.meta.json`,
      `${SESSION_ID}/tool-results/b1.txt`,
    ]);
    expect(prepared.files.every((f) => f.replacements === 0 && f.bytes > 0)).toBe(true);
    expect(prepared.fileHistory.files).toBe(1);
    await prepared.cleanup();
    expect(await snapshot(home)).toEqual(before);
  });
});

describe("copyToTarget", () => {
  test("copies the log, sidecar and file-history into the target layout", async () => {
    const { home, session } = await fixtureSession();
    const targetHome = await tempDir();
    const target = new LocalTarget(targetHome);
    const prepared = await prepare(session, "symlink", []);

    expect(await existingOnTarget(target, layout)).toEqual([]);
    expect(await copyToTarget(target, prepared, layout, { replace: false })).toEqual({ files: 5 });

    const source = await snapshot(join(home, ".claude"));
    const copied = await snapshot(join(targetHome, ".claude"));
    const renamed = Object.fromEntries(
      Object.entries(source).map(([rel, body]) => [rel.replace("-Users-testuser-proj-app", "-home-tester-proj-app"), body]),
    );
    expect(copied).toEqual(renamed);
    expect(await existingOnTarget(target, layout)).toEqual([layout.mainLog, layout.sidecarDir, layout.fileHistoryDir]);
  });

  test("replace removes files the source no longer has", async () => {
    const { session } = await fixtureSession();
    const targetHome = await tempDir();
    const target = new LocalTarget(targetHome);
    const prepared = await prepare(session, "symlink", []);
    await copyToTarget(target, prepared, layout, { replace: false });

    const stale = join(targetHome, layout.sidecarDir, "tool-results", "stale.txt");
    await writeFile(stale, "left over from an earlier copy");
    await copyToTarget(target, prepared, layout, { replace: true });
    expect(await Bun.file(stale).exists()).toBe(false);
  });

  test("works for a session with no sidecar and no file-history", async () => {
    const { home, session } = await fixtureSession();
    await rm(session.sidecarDir!, { recursive: true });
    await rm(session.fileHistoryDir!, { recursive: true });
    const bare = await locateSession(home, SESSION_ID);
    const targetHome = await tempDir();
    const result = await copyToTarget(new LocalTarget(targetHome), await prepare(bare, "symlink", []), layout, { replace: false });
    expect(result).toEqual({ files: 1 });
    expect(Object.keys(await snapshot(join(targetHome, ".claude")))).toEqual([layout.mainLog.replace(".claude/", "")]);
  });
});
