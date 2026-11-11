#!/usr/bin/env bun
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeCodeStore } from "./claude-code-store.ts";
import { copyToTarget, existingOnTarget, prepare, type FileReport, type Mode, type Prepared } from "./copy.ts";
import { compareGit, gitState } from "./git.ts";
import { LocateError, locateSession } from "./locate.ts";
import { mapPath, normalizeDir, parseMapArg, shellQuote, shellQuoteStrict, type PathMap } from "./paths.ts";
import { NotImplementedError } from "./rewrite.ts";
import { LocalTarget, parseKeyValues, parseTarget, type Target } from "./target.ts";

const USAGE = `Usage: sessmv <session-id> <ssh-host | local:<dir>> [options]

Copy a Claude Code session to another machine so that
"claude --resume <session-id>" continues it there.

Options:
  --map <from>=<to>   Map a source path prefix to a target path (repeatable).
                      Default: source $HOME -> target $HOME.
  --mode <mode>       rewrite (default): rewrite mapped paths in copies of the session files.
                      symlink: copy byte-for-byte and print the commands that make
                      the old paths exist on the target.
  --dry-run           Do everything except copy.
  --force             Proceed on a Claude Code version mismatch and replace an
                      existing copy of the session on the target.
  -h, --help          Show this help.
`;

class UsageError extends Error {}
class Refusal extends Error {}

interface Options {
  sessionId: string;
  target: string;
  maps: PathMap[];
  mode: Mode;
  dryRun: boolean;
  force: boolean;
}

function parseCli(argv: string[]): Options | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: "string", multiple: true },
        mode: { type: "string", default: "rewrite" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length !== 2) {
    throw new UsageError(`expected <session-id> and <target>, got ${positionals.length} argument(s)`);
  }
  if (values.mode !== "rewrite" && values.mode !== "symlink") {
    throw new UsageError(`--mode must be "rewrite" or "symlink", got "${values.mode}"`);
  }
  let maps: PathMap[];
  try {
    maps = (values.map ?? []).map(parseMapArg);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  return {
    sessionId: positionals[0]!,
    target: positionals[1]!,
    maps,
    mode: values.mode,
    dryRun: values["dry-run"],
    force: values.force,
  };
}

/** Drop no-op and repeated maps; reject two different targets for one source prefix. */
function cleanMaps(maps: readonly PathMap[]): PathMap[] {
  const out: PathMap[] = [];
  for (const map of maps) {
    if (map.from === map.to) continue;
    const prior = out.find((m) => m.from === map.from);
    if (prior && prior.to !== map.to) {
      throw new UsageError(`conflicting maps for ${map.from}: ${prior.to} and ${map.to}`);
    }
    if (!prior) out.push(map);
  }
  return out;
}

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = (text: string) => paint("1", text);

function say(line = ""): void {
  console.log(line);
}

function heading(title: string): void {
  say();
  say(bold(title));
}

const warningsSeen: string[] = [];
function warn(message: string): void {
  warningsSeen.push(message);
  say(paint("1;33", `  WARNING: ${message}`));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeFile(file: FileReport): string {
  if (file.kind === "jsonl" && file.records !== undefined) {
    return `${plural(file.records, "record")}, ${file.rewritten} rewritten, ${plural(file.replacements, "path")} replaced`;
  }
  return `${plural(file.replacements, "path")} replaced`;
}

function printFiles(prepared: Prepared, mode: Mode, logName: string): void {
  heading("Files");
  const shown = prepared.files.filter((f) => f.rel === logName || f.replacements > 0 || f.note);
  const width = Math.max(...shown.map((f) => f.rel.length));
  for (const file of shown) {
    const detail = mode === "rewrite" ? describeFile(file) : formatBytes(file.bytes);
    say(`  ${file.rel.padEnd(width)}  ${detail}${file.note ? `  [${file.note}]` : ""}`);
  }
  const rest = prepared.files.length - shown.length;
  if (rest > 0) {
    say(`  ${plural(rest, "other file")} ${mode === "rewrite" ? "with nothing to rewrite" : "copied byte-for-byte"}`);
  }
  if (prepared.fileHistory.files > 0) {
    say(`  checkpoints: ${plural(prepared.fileHistory.files, "file")}, ${formatBytes(prepared.fileHistory.bytes)} (never rewritten)`);
  }
  const totalBytes = prepared.files.reduce((sum, f) => sum + f.bytes, 0) + prepared.fileHistory.bytes;
  const totalFiles = prepared.files.length + prepared.fileHistory.files;
  if (mode === "rewrite") {
    const records = prepared.files.reduce((sum, f) => sum + (f.kind === "jsonl" ? f.rewritten : 0), 0);
    const paths = prepared.files.reduce((sum, f) => sum + f.replacements, 0);
    say(`  total: ${plural(totalFiles, "file")}, ${formatBytes(totalBytes)}, ${plural(records, "record")} rewritten, ${plural(paths, "path")} replaced`);
  } else {
    say(`  total: ${plural(totalFiles, "file")}, ${formatBytes(totalBytes)}`);
  }
}

/** Symlink mode: say what has to exist on the target for the old paths to resolve. Nothing is run. */
async function printSymlinkPlan(target: Target, maps: readonly PathMap[]): Promise<void> {
  heading("Symlinks needed on the target");
  if (maps.length === 0) {
    say("  none: source and target paths are identical");
    return;
  }
  const script = maps
    .map(
      (map, i) => `
from=${shellQuoteStrict(map.from)}; to=${shellQuoteStrict(map.to)}
if [ -e "$from" ] || [ -L "$from" ]; then
  a=$(cd "$from" 2>/dev/null && pwd -P); b=$(cd "$to" 2>/dev/null && pwd -P)
  if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "link${i}=ok"; else echo "link${i}=conflict"; fi
else
  echo "link${i}=missing"
fi`,
    )
    .join("\n");
  const states = parseKeyValues((await target.exec(script)).stdout);
  const commands: string[] = [];
  maps.forEach((map, i) => {
    const state = states.get(`link${i}`);
    if (state === "ok") {
      say(`  ${map.from} already resolves to ${map.to}`);
    } else if (state === "conflict") {
      warn(`${map.from} already exists on the target and is not ${map.to}; paths in this session will point at the wrong files`);
    } else {
      const parent = dirname(map.from);
      if (parent !== "/") commands.push(`sudo mkdir -p ${shellQuote(parent)}`);
      commands.push(`sudo ln -s ${shellQuote(map.to)} ${shellQuote(map.from)}`);
    }
  });
  if (commands.length > 0) {
    say("  Run these on the target (sessmv does not run them):");
    for (const command of [...new Set(commands)]) say(`    ${command}`);
  }
}

async function run(opts: Options): Promise<void> {
  const sourceHome = process.env.HOME;
  if (!sourceHome) throw new Refusal("HOME is not set, so the source ~/.claude cannot be found");
  const source = new LocalTarget(sourceHome);
  const target = parseTarget(opts.target);

  // Step 1: locate.
  const session = await locateSession(source.home, opts.sessionId);

  // Step 2: preflight.
  const [here, there] = await Promise.all([ClaudeCodeStore.inspect(source), ClaudeCodeStore.inspect(target)]);

  const maps = cleanMaps(opts.maps.length > 0 ? opts.maps : [{ from: normalizeDir(source.home), to: there.home }]);
  const targetCwd = mapPath(session.cwd, maps);
  const encodedTargetCwd = ClaudeCodeStore.encodeCwd(targetCwd);
  const layout = ClaudeCodeStore.layout(encodedTargetCwd, session.id);

  // The session's own folder is renamed by the move, so rewrite mode maps it too.
  const rewriteMaps = [...maps];
  const storage = ClaudeCodeStore.selfMap(session.projectDir, there.home, encodedTargetCwd);
  const storageDerived = opts.mode === "rewrite" && storage.from !== storage.to && !maps.some((m) => m.from === storage.from);
  if (storageDerived) rewriteMaps.push(storage);

  say(bold(`sessmv ${session.id} -> ${target.label}`) + `  (${opts.mode} mode${opts.dryRun ? ", dry run" : ""})`);

  heading("Session");
  say(`  source cwd     ${session.cwd}`);
  say(`  target cwd     ${targetCwd}`);
  say(`  source folder  ${session.projectDir}`);
  say(`  target folder  ${there.home}/${layout.projectDir}`);
  if (!session.cwdMatchesFolder) {
    warn(`no record's cwd encodes to the folder name ${session.encodedCwd}; using the first cwd in the log`);
  }

  heading("Path maps");
  if (maps.length === 0) say("  none: source and target paths are identical");
  for (const map of maps) say(`  ${map.from} -> ${map.to}`);
  if (storageDerived) say(`  ${storage.from} -> ${storage.to}  (session folder, added automatically)`);
  if (targetCwd === session.cwd && maps.length > 0) {
    say(`  note: no map covers ${session.cwd}; the same path is used on the target`);
  }

  heading("Version check");
  const versions = ClaudeCodeStore.checkVersions(here, there);
  if (versions.ok) {
    say(`  ok: ${versions.summary}`);
  } else if (opts.force) {
    warn(`${versions.problem} (continuing because of --force)`);
  } else {
    throw new Refusal(`${versions.problem}. Session formats change between versions; rerun with --force to copy anyway.`);
  }

  // Step 3: git.
  heading("Git check");
  const [sourceGit, targetGit] = await Promise.all([gitState(source, session.cwd), gitState(target, targetCwd)]);
  const git = compareGit(sourceGit, targetGit, session.cwd, targetCwd);
  say(`  source  ${git.source}`);
  say(`  target  ${git.target}`);
  if (git.status === "match") say("  ok: same remote, branch and commit, both clean");
  if (git.status === "skipped") say("  skipped: the source directory is not a git repository");
  for (const warning of git.warnings) warn(warning);

  const existing = await existingOnTarget(target, layout);
  if (existing.length > 0 && !opts.force && !opts.dryRun) {
    throw new Refusal(
      `session ${session.id} already exists on ${target.label} (${existing.map((p) => `~/${p}`).join(", ")}). ` +
        "Rerun with --force to replace it.",
    );
  }

  // Step 4: path handling.
  const prepared = await prepare(session, opts.mode, rewriteMaps);
  try {
    printFiles(prepared, opts.mode, `${session.id}.jsonl`);
    if (opts.mode === "symlink") await printSymlinkPlan(target, maps);

    // Step 5: copy.
    heading(opts.dryRun ? "Dry run" : "Copy");
    if (existing.length > 0) {
      const what = existing.map((p) => `~/${p}`).join(", ");
      if (opts.dryRun && !opts.force) warn(`the target already has this session (${what}); a real run needs --force`);
      else say(`  ${opts.dryRun ? "would replace" : "replacing"} the existing copy on the target (${what})`);
    }
    if (opts.dryRun) {
      say("  nothing was copied");
    } else {
      const copied = await copyToTarget(target, prepared, layout, { replace: existing.length > 0 });
      say(`  copied and verified ${plural(copied.files, "file")} under ${target.label}:~/${layout.projectDir}`);
    }
  } finally {
    await prepared.cleanup();
  }

  // Step 6: summary.
  if (warningsSeen.length > 0) {
    heading(plural(warningsSeen.length, "warning"));
    for (const warning of warningsSeen) say(paint("1;33", `  - ${warning}`));
  }
  heading(opts.dryRun ? "After a real run, resume with" : "Resume with");
  if (!there.claude) say(`  (${ClaudeCodeStore.name} was not found on the target; install it first)`);
  say(`  ${target.resumeCommand(targetCwd, ClaudeCodeStore.resumeCommand(there, session.id, { expandHome: target.kind === "local" }))}`);
}

export async function main(argv: string[]): Promise<number> {
  let opts: Options | "help";
  try {
    opts = parseCli(argv);
  } catch (err) {
    console.error(`sessmv: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts === "help") {
    console.log(USAGE);
    return 0;
  }
  try {
    await run(opts);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`sessmv: ${err.message}`);
      return 2;
    }
    if (err instanceof NotImplementedError) {
      console.error(`sessmv: ${err.message}. Rewrite mode needs it; --mode symlink works without it.`);
      return 1;
    }
    if (err instanceof Refusal || err instanceof LocateError) {
      console.error(`sessmv: ${err.message}`);
      return 1;
    }
    console.error(`sessmv: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
