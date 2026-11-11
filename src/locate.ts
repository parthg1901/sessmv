import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeStore } from "./claude-code-store.ts";

export interface LocatedSession {
  id: string;
  /** The session's project folder on the source. */
  projectDir: string;
  encodedCwd: string;
  /** The working directory the session belongs to. */
  cwd: string;
  /** False when no record's cwd encodes to the project folder name and the first cwd was used instead. */
  cwdMatchesFolder: boolean;
  mainLog: string;
  /** Subagent logs and saved tool results, if present. */
  sidecarDir: string | null;
  /** File checkpoints, if present. */
  fileHistoryDir: string | null;
}

export class LocateError extends Error {}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Find a session by id by searching every project folder under `home`. */
export async function locateSession(home: string, id: string): Promise<LocatedSession> {
  if (!ClaudeCodeStore.isSessionId(id)) throw new LocateError(`"${id}" is not a valid session id`);

  const projectsDir = ClaudeCodeStore.projectsDir(home);
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    throw new LocateError(`no ${ClaudeCodeStore.name} projects directory at ${projectsDir}`);
  }

  const matches: string[] = [];
  for (const entry of entries.sort()) {
    if (await isFile(ClaudeCodeStore.sessionPaths(home, entry, id).mainLog)) matches.push(entry);
  }
  if (matches.length === 0) {
    throw new LocateError(`session ${id} not found under ${projectsDir}`);
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `  ${join(projectsDir, m)}`).join("\n");
    throw new LocateError(`session ${id} is ambiguous; it exists in ${matches.length} project folders:\n${list}`);
  }

  const encodedCwd = matches[0]!;
  const paths = ClaudeCodeStore.sessionPaths(home, encodedCwd, id);
  const found = ClaudeCodeStore.sessionCwd(await Bun.file(paths.mainLog).text(), encodedCwd);
  if (!found) {
    throw new LocateError(`${paths.mainLog} has no record with a cwd field, so the session's working directory is unknown`);
  }

  return {
    id,
    projectDir: paths.projectDir,
    encodedCwd,
    cwd: found.cwd,
    cwdMatchesFolder: found.matchesFolder,
    mainLog: paths.mainLog,
    sidecarDir: (await isDir(paths.sidecarDir)) ? paths.sidecarDir : null,
    fileHistoryDir: (await isDir(paths.fileHistoryDir)) ? paths.fileHistoryDir : null,
  };
}
