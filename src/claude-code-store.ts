/**
 * Everything this tool knows about Claude Code: where a session is stored, how
 * a working directory becomes a folder name, how to read the installed version
 * and how to resume. The rest of the tool goes through this module, so another
 * harness would be a second module of the same shape.
 *
 * Storage, verified on Claude Code 2.1.322 (identical on macOS and Linux):
 *   ~/.claude/projects/<encoded-cwd>/<id>.jsonl          main log
 *   ~/.claude/projects/<encoded-cwd>/<id>/subagents/     agent-*.jsonl, agent-*.meta.json
 *   ~/.claude/projects/<encoded-cwd>/<id>/tool-results/  *.txt
 *   ~/.claude/file-history/<id>/                         checkpoints of edited files
 */
import { join } from "node:path";
import { normalizeDir, shellQuote, type PathMap } from "./paths.ts";
import { parseKeyValues, type Target } from "./target.ts";

/** Absolute paths of one session's parts under a home directory. */
export interface SessionPaths {
  projectDir: string;
  mainLog: string;
  sidecarDir: string;
  fileHistoryDir: string;
}

/** The same parts relative to a home directory, for placing a session on a target. */
export interface Layout {
  projectDir: string;
  mainLog: string;
  sidecarDir: string;
  fileHistoryRoot: string;
  fileHistoryDir: string;
}

export type FileKind = "jsonl" | "json" | "text" | "other";

/** What a machine reports about itself and its Claude Code. */
export interface Install {
  home: string;
  /** Where Claude Code was found: "home" = ~/.local/bin/claude, "path" = on PATH, null = not installed. */
  claude: "home" | "path" | null;
  /** Bare version number such as "2.1.322", or null if it could not be read. */
  version: string | null;
}

export type VersionCheck = { ok: true; summary: string } | { ok: false; problem: string };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ~/.local/bin is not on PATH in a non-interactive SSH session, so look there first.
const INSPECT_SCRIPT = `
printf 'home=%s\\n' "$HOME"
if [ -x "$HOME/.local/bin/claude" ]; then
  printf 'claude=home\\n'
  printf 'version=%s\\n' "$("$HOME/.local/bin/claude" --version 2>/dev/null </dev/null | head -n 1)"
elif command -v claude >/dev/null 2>&1; then
  printf 'claude=path\\n'
  printf 'version=%s\\n' "$(claude --version 2>/dev/null </dev/null | head -n 1)"
fi
`;

function relativeLayout(encodedCwd: string, id: string): Layout {
  const projectDir = `.claude/projects/${encodedCwd}`;
  return {
    projectDir,
    mainLog: `${projectDir}/${id}.jsonl`,
    sidecarDir: `${projectDir}/${id}`,
    fileHistoryRoot: ".claude/file-history",
    fileHistoryDir: `.claude/file-history/${id}`,
  };
}

export const ClaudeCodeStore = {
  name: "Claude Code",

  /** The project folder name for a working directory: every non-alphanumeric character becomes "-". */
  encodeCwd(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, "-");
  },

  /** Session ids become file names and shell words, so only plain names are accepted. */
  isSessionId(id: string): boolean {
    return SESSION_ID.test(id);
  },

  /** The directory holding one folder per working directory. */
  projectsDir(home: string): string {
    return join(home, ".claude", "projects");
  },

  /** Where a session's parts are (or would be) under `home`. */
  sessionPaths(home: string, encodedCwd: string, id: string): SessionPaths {
    const layout = relativeLayout(encodedCwd, id);
    return {
      projectDir: join(home, layout.projectDir),
      mainLog: join(home, layout.mainLog),
      sidecarDir: join(home, layout.sidecarDir),
      fileHistoryDir: join(home, layout.fileHistoryDir),
    };
  },

  /** Where a session goes on a target, relative to the target's home. */
  layout: relativeLayout,

  /**
   * The working directory a session belongs to. Records carry a `cwd` field,
   * and it changes when the conversation moves between directories, so prefer
   * the one that encodes to the project folder name: that is the directory the
   * session has to be resumed from.
   */
  sessionCwd(logText: string, encodedCwd: string): { cwd: string; matchesFolder: boolean } | null {
    let first: string | null = null;
    const seen = new Set<string>();
    for (const line of logText.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const cwd = (record as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd !== "string" || cwd === "" || seen.has(cwd)) continue;
      seen.add(cwd);
      if (ClaudeCodeStore.encodeCwd(cwd) === encodedCwd) return { cwd, matchesFolder: true };
      first ??= cwd;
    }
    return first === null ? null : { cwd: first, matchesFolder: false };
  },

  /** How a session file is rewritten: JSONL logs, JSON metadata, plain-text tool results, or not at all. */
  fileKind(rel: string): FileKind {
    if (rel.endsWith(".jsonl")) return "jsonl";
    if (rel.endsWith(".json")) return "json";
    if (rel.endsWith(".txt")) return "text";
    return "other";
  },

  /**
   * Records point into the session's own folder (saved tool results), and that
   * folder's name encodes the cwd, so it changes whenever the cwd does. This
   * map sends the old folder to the new one; it is longer than a home map and
   * therefore wins over it.
   */
  selfMap(sourceProjectDir: string, targetHome: string, encodedTargetCwd: string): PathMap {
    return { from: sourceProjectDir, to: `${targetHome}/${relativeLayout(encodedTargetCwd, "x").projectDir}` };
  },

  parseVersion(text: string | undefined): string | null {
    return text?.match(/\d+\.\d+\.\d+[^\s()]*/)?.[0] ?? null;
  },

  /** Preflight: a machine's home directory and Claude Code version. */
  async inspect(machine: Target): Promise<Install> {
    const result = await machine.exec(INSPECT_SCRIPT);
    const values = parseKeyValues(result.stdout);
    const home = values.get("home");
    if (result.code !== 0 || !home) {
      throw new Error(`could not reach ${machine.label}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    const found = values.get("claude");
    return {
      home: normalizeDir(home),
      claude: found === "home" || found === "path" ? found : null,
      version: ClaudeCodeStore.parseVersion(values.get("version")),
    };
  },

  /** The log format is not stable across versions, so both sides must run the same one. */
  checkVersions(source: Install, target: Install): VersionCheck {
    if (source.version && source.version === target.version) {
      return { ok: true, summary: `Claude Code ${source.version} on both machines` };
    }
    const show = (version: string | null) => version ?? "not found";
    return { ok: false, problem: `Claude Code versions differ: source ${show(source.version)}, target ${show(target.version)}` };
  },

  /**
   * The command that continues a session, to be run from its working directory.
   * `expandHome` spells out the home directory, for when "~" would not mean the
   * machine's home (a `local:<dir>` target).
   */
  resumeCommand(install: Install, id: string, opts: { expandHome: boolean }): string {
    const inHome = opts.expandHome ? shellQuote(`${install.home}/.local/bin/claude`) : "~/.local/bin/claude";
    return `${install.claude === "path" ? "claude" : inHome} --resume ${id}`;
  },
};
