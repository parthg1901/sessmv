import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocateError, locateSession } from "../src/locate.ts";
import { cleanupTempDirs, FIXTURE_CWD, FIXTURE_FOLDER, installFixtureSession, SESSION_ID, setAge, tempDir } from "./helpers.ts";

afterAll(cleanupTempDirs);

describe("locateSession", () => {
  test("finds the log, sidecar and file-history", async () => {
    const home = await tempDir();
    const projectDir = await installFixtureSession(home);
    const session = await locateSession(home, SESSION_ID);
    expect(session.projectDir).toBe(projectDir);
    expect(session.encodedCwd).toBe(FIXTURE_FOLDER);
    expect(session.cwd).toBe(FIXTURE_CWD);
    expect(session.cwdMatchesFolder).toBe(true);
    expect(session.mainLog).toBe(join(projectDir, `${SESSION_ID}.jsonl`));
    expect(session.sidecarDir).toBe(join(projectDir, SESSION_ID));
    expect(session.fileHistoryDir).toBe(join(home, ".claude", "file-history", SESSION_ID));
  });

  test("reports when the log or any sidecar file was last written", async () => {
    const home = await tempDir();
    const projectDir = await installFixtureSession(home);
    const hourAgo = Date.now() - 3600_000;
    expect(Math.abs((await locateSession(home, SESSION_ID)).lastWriteMs - hourAgo)).toBeLessThan(10_000);
    await setAge(join(projectDir, SESSION_ID, "tool-results", "b1.txt"), 30);
    expect(Math.abs((await locateSession(home, SESSION_ID)).lastWriteMs - (Date.now() - 30_000))).toBeLessThan(10_000);
  });

  test("reports missing sidecar and file-history as null", async () => {
    const home = await tempDir();
    const projectDir = await installFixtureSession(home);
    await rm(join(projectDir, SESSION_ID), { recursive: true });
    await rm(join(home, ".claude", "file-history"), { recursive: true });
    const session = await locateSession(home, SESSION_ID);
    expect(session.sidecarDir).toBeNull();
    expect(session.fileHistoryDir).toBeNull();
  });

  test("fails clearly when the session does not exist", async () => {
    const home = await tempDir();
    await installFixtureSession(home);
    await expect(locateSession(home, "99999999-0000-4000-8000-000000000000")).rejects.toThrow(/not found/);
    await expect(locateSession(await tempDir(), SESSION_ID)).rejects.toThrow(LocateError);
  });

  test("fails clearly when the id exists in two project folders", async () => {
    const home = await tempDir();
    await installFixtureSession(home);
    await installFixtureSession(home, "-Users-testuser-proj-other");
    await expect(locateSession(home, SESSION_ID)).rejects.toThrow(/ambiguous[\s\S]*-Users-testuser-proj-app[\s\S]*-Users-testuser-proj-other/);
  });

  test("rejects ids that are not plain names", async () => {
    const home = await tempDir();
    await expect(locateSession(home, "../etc/passwd")).rejects.toThrow(/not a valid session id/);
    await expect(locateSession(home, "")).rejects.toThrow(/not a valid session id/);
  });

  test("fails when the log has no cwd at all", async () => {
    const home = await tempDir();
    const dir = join(home, ".claude", "projects", "-Users-testuser-empty");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${SESSION_ID}.jsonl`), '{"type":"mode","mode":"default"}\n');
    await expect(locateSession(home, SESSION_ID)).rejects.toThrow(/no record with a cwd/);
  });
});
