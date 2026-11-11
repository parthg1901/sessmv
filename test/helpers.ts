import { chmod, cp, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const FIXTURE = join(import.meta.dir, "fixtures", "session");
export const SESSION_ID = "11111111-2222-4333-8444-555555555555";
/** The fixture session's working directory and its project folder name. */
export const FIXTURE_CWD = "/Users/testuser/proj/app";
export const FIXTURE_FOLDER = "-Users-testuser-proj-app";

/** A second fixture: one record of each kind of Claude Code tool call, for locations vs contents. */
export const TOOL_FIXTURE = join(import.meta.dir, "fixtures", "tool-session.jsonl");
export const TOOL_SESSION_ID = "22222222-3333-4444-8555-666666666666";
export const TOOL_FOLDER = "-Users-testuser-demo";

export const MAC_TO_LINUX = [{ from: "/Users/testuser", to: "/home/tester" }];
export const LINUX_TO_MAC = [{ from: "/home/tester", to: "/Users/testuser" }];

const created: string[] = [];

export async function tempDir(prefix = "sessmv-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** Put a fake `claude` that only answers --version into <home>/.local/bin. */
export async function installFakeClaude(home: string, version: string): Promise<void> {
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, "claude");
  await writeFile(path, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  await chmod(path, 0o755);
}

/** Lay the fixture session out under <home>/.claude the way Claude Code stores it. */
export async function installFixtureSession(home: string, folder = FIXTURE_FOLDER): Promise<string> {
  const projectDir = join(home, ".claude", "projects", folder);
  await mkdir(join(projectDir, SESSION_ID), { recursive: true });
  await cp(join(FIXTURE, "main.jsonl"), join(projectDir, `${SESSION_ID}.jsonl`));
  await cp(join(FIXTURE, "subagents"), join(projectDir, SESSION_ID, "subagents"), { recursive: true });
  await cp(join(FIXTURE, "tool-results"), join(projectDir, SESSION_ID, "tool-results"), { recursive: true });
  await cp(join(FIXTURE, "file-history"), join(home, ".claude", "file-history", SESSION_ID), { recursive: true });
  await setAge(join(projectDir, `${SESSION_ID}.jsonl`), 3600);
  await setAge(join(projectDir, SESSION_ID), 3600);
  return projectDir;
}

/** Make a file, or every file below a directory, look as if it was last written `seconds` ago. */
export async function setAge(path: string, seconds: number): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries) {
    for (const entry of entries) await setAge(join(path, entry.name), seconds);
    return;
  }
  const when = new Date(Date.now() - seconds * 1000);
  await utimes(path, when, when);
}

/** Lay the tool-record fixture out under <home>/.claude as a session of its own. */
export async function installToolSession(home: string): Promise<string> {
  const projectDir = join(home, ".claude", "projects", TOOL_FOLDER);
  await mkdir(projectDir, { recursive: true });
  const log = join(projectDir, `${TOOL_SESSION_ID}.jsonl`);
  await cp(TOOL_FIXTURE, log);
  await setAge(log, 3600);
  return log;
}

/** A fake source home holding the fixture session and a fake claude. */
export async function makeSourceHome(version = "2.1.322"): Promise<string> {
  const home = await tempDir("sessmv-src-");
  await installFakeClaude(home, version);
  await installFixtureSession(home);
  return home;
}

/** An empty fake target home with a fake claude. */
export async function makeTargetHome(version = "2.1.322"): Promise<string> {
  const home = await tempDir("sessmv-dst-");
  await installFakeClaude(home, version);
  return home;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for message assertions. */
  output: string;
}

/** Run the CLI as a subprocess with HOME pointing at a fake source home. */
export async function runCli(args: string[], home: string, env: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, join(REPO, "src", "cli.ts"), ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, output: stdout + stderr };
}

/** Every regular file under `dir` as relative path -> contents. Empty if `dir` does not exist. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (sub: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(rel);
      else if (entry.isFile()) out[rel] = await Bun.file(join(dir, rel)).text();
    }
  };
  await visit("");
  return out;
}

export function parseJsonl(text: string): any[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export async function sh(script: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", script], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`sh failed (${code}): ${script}\n${stderr}`);
  return stdout;
}
