import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeStore, type FileKind, type Layout } from "./claude-code-store.ts";
import type { LocatedSession } from "./locate.ts";
import { shellQuoteStrict, type PathMap } from "./paths.ts";
import { rewriteJsonl, rewriteString, rewriteValue } from "./rewrite.ts";
import type { Target } from "./target.ts";

export type Mode = "rewrite" | "symlink";

export interface FileReport {
  /** Path relative to the project folder, e.g. `<id>/subagents/agent-1.jsonl`. */
  rel: string;
  kind: FileKind;
  bytes: number;
  /** JSONL only. */
  records?: number;
  /** JSONL: records changed. Other kinds: 1 if the file changed, else 0. */
  rewritten: number;
  /** Path prefixes replaced. */
  replacements: number;
  /** Why a file was copied verbatim although its kind is normally rewritten. */
  note?: string;
}

/** What will be uploaded. In rewrite mode the log and sidecar are rewritten copies in a temp dir. */
export interface Prepared {
  mainLog: string;
  sidecarDir: string | null;
  fileHistoryDir: string | null;
  files: FileReport[];
  fileHistory: { files: number; bytes: number };
  cleanup(): Promise<void>;
}

/** Regular files under `dir`, as sorted paths relative to it. Symlinks are followed, as scp does. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const info = await stat(join(dir, entry.name)).catch(() => null);
      isDir = info?.isDirectory() ?? false;
      isFile = info?.isFile() ?? false;
    }
    if (isDir) out.push(...(await walk(join(dir, entry.name), rel)));
    else if (isFile) out.push(rel);
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Rewrite one file from `src` into `dest`. The source is only ever read. */
async function rewriteFile(src: string, dest: string, rel: string, maps: readonly PathMap[]): Promise<FileReport> {
  const kind = ClaudeCodeStore.fileKind(rel);
  const bytes = new Uint8Array(await Bun.file(src).arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  const verbatim = async (note?: string): Promise<FileReport> => {
    await Bun.write(dest, bytes);
    return { rel, kind, bytes: bytes.byteLength, rewritten: 0, replacements: 0, ...(note ? { note } : {}) };
  };

  if (kind === "other") return verbatim();
  const text = decodeUtf8(bytes);
  if (text === null) return verbatim("not valid UTF-8, copied as-is");

  if (kind === "jsonl") {
    const result = rewriteJsonl(text, maps);
    await Bun.write(dest, result.text);
    return {
      rel,
      kind,
      bytes: Buffer.byteLength(result.text),
      records: result.records,
      rewritten: result.rewritten,
      replacements: result.replacements,
      ...(result.unparsed ? { note: `${result.unparsed} unparseable line(s) kept as-is` } : {}),
    };
  }

  if (kind === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return verbatim("not valid JSON, copied as-is");
    }
    const result = rewriteValue(parsed, maps);
    if (result.replacements === 0) return verbatim();
    const indent = text.match(/^[[{]\r?\n([ \t]+)/)?.[1];
    const out = JSON.stringify(result.value, null, indent) + (text.endsWith("\n") ? "\n" : "");
    await Bun.write(dest, out);
    return { rel, kind, bytes: Buffer.byteLength(out), rewritten: 1, replacements: result.replacements };
  }

  const result = rewriteString(text, maps);
  if (result.replacements === 0) return verbatim();
  await Bun.write(dest, result.value);
  return { rel, kind, bytes: Buffer.byteLength(result.value), rewritten: 1, replacements: result.replacements };
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

/**
 * Step 4. In rewrite mode, write rewritten copies of the log and sidecar files
 * to a temp dir. In symlink mode nothing is written: the originals are
 * uploaded byte-for-byte. Checkpoints are copies of the user's own files and
 * are never rewritten.
 */
export async function prepare(session: LocatedSession, mode: Mode, maps: readonly PathMap[]): Promise<Prepared> {
  const logName = `${session.id}.jsonl`;
  const sidecarFiles = session.sidecarDir ? await walk(session.sidecarDir) : [];

  const fileHistory = { files: 0, bytes: 0 };
  if (session.fileHistoryDir) {
    for (const rel of await walk(session.fileHistoryDir)) {
      fileHistory.files += 1;
      fileHistory.bytes += await sizeOf(join(session.fileHistoryDir, rel));
    }
  }

  if (mode === "symlink") {
    const files: FileReport[] = [
      { rel: logName, kind: "jsonl", bytes: await sizeOf(session.mainLog), rewritten: 0, replacements: 0 },
    ];
    for (const rel of sidecarFiles) {
      const bytes = await sizeOf(join(session.sidecarDir!, rel));
      files.push({ rel: `${session.id}/${rel}`, kind: ClaudeCodeStore.fileKind(rel), bytes, rewritten: 0, replacements: 0 });
    }
    return {
      mainLog: session.mainLog,
      sidecarDir: session.sidecarDir,
      fileHistoryDir: session.fileHistoryDir,
      files,
      fileHistory,
      cleanup: async () => {},
    };
  }

  // Session logs hold secrets; mkdtemp creates the directory with mode 0700.
  const stage = await mkdtemp(join(tmpdir(), "sessmv-"));
  const cleanup = () => rm(stage, { recursive: true, force: true });
  try {
    const files: FileReport[] = [await rewriteFile(session.mainLog, join(stage, logName), logName, maps)];
    if (session.sidecarDir) {
      await mkdir(join(stage, session.id), { recursive: true });
      for (const rel of sidecarFiles) {
        const staged = `${session.id}/${rel}`;
        files.push(await rewriteFile(join(session.sidecarDir, rel), join(stage, staged), staged, maps));
      }
    }
    return {
      mainLog: join(stage, logName),
      sidecarDir: session.sidecarDir ? join(stage, session.id) : null,
      fileHistoryDir: session.fileHistoryDir,
      files,
      fileHistory,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Which parts of the session already exist on the target (paths relative to its home). */
export async function existingOnTarget(target: Target, layout: Layout): Promise<string[]> {
  const paths = [layout.mainLog, layout.sidecarDir, layout.fileHistoryDir];
  const script = `
cd "$HOME" 2>/dev/null || exit 0
for p in ${paths.map(shellQuoteStrict).join(" ")}; do
  if [ -e "$p" ]; then printf 'exists=%s\\n' "$p"; fi
done
`;
  const result = await target.exec(script);
  if (result.code !== 0) {
    throw new Error(`could not check for an existing session on ${target.label}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("exists="))
    .map((line) => line.slice("exists=".length));
}

/**
 * Step 5. `replace` removes the target's existing copy first so the result is
 * exactly the source session, not a merge of two. The main log goes last, so
 * an interrupted run never leaves a log whose sidecar files are missing.
 */
export async function copyToTarget(
  target: Target,
  prepared: Prepared,
  layout: Layout,
  opts: { replace: boolean },
): Promise<{ files: number }> {
  const q = shellQuoteStrict;
  const setup = `
set -e
cd "$HOME"
${opts.replace ? `rm -rf ${q(layout.mainLog)} ${q(layout.sidecarDir)} ${q(layout.fileHistoryDir)}` : ":"}
mkdir -p ${q(layout.projectDir)}${prepared.fileHistoryDir ? ` ${q(layout.fileHistoryRoot)}` : ""}
`;
  const made = await target.exec(setup);
  if (made.code !== 0) {
    throw new Error(`could not prepare ${layout.projectDir} on ${target.label}: ${made.stderr.trim() || `exit ${made.code}`}`);
  }

  if (prepared.sidecarDir) await target.upload(prepared.sidecarDir, layout.projectDir);
  if (prepared.fileHistoryDir) await target.upload(prepared.fileHistoryDir, layout.fileHistoryRoot);
  await target.upload(prepared.mainLog, layout.projectDir);

  const expectedFiles = prepared.files.length + prepared.fileHistory.files;
  const expectedBytes = await sizeOf(prepared.mainLog);
  const present = [layout.mainLog, ...(prepared.sidecarDir ? [layout.sidecarDir] : []), ...(prepared.fileHistoryDir ? [layout.fileHistoryDir] : [])];
  const verify = `
cd "$HOME" || exit 1
[ -f ${q(layout.mainLog)} ] || { echo "log=missing"; exit 0; }
printf 'bytes=%s\\n' "$(wc -c < ${q(layout.mainLog)} | tr -d ' ')"
printf 'files=%s\\n' "$(find ${present.map(q).join(" ")} -type f 2>/dev/null | wc -l | tr -d ' ')"
`;
  const checked = await target.exec(verify);
  const bytes = Number(checked.stdout.match(/^bytes=(\d+)$/m)?.[1] ?? NaN);
  const files = Number(checked.stdout.match(/^files=(\d+)$/m)?.[1] ?? NaN);
  if (checked.code !== 0 || bytes !== expectedBytes || files !== expectedFiles) {
    throw new Error(
      `copy to ${target.label} could not be verified: expected ${expectedFiles} files and a ${expectedBytes}-byte log, ` +
        `found ${Number.isNaN(files) ? "no" : files} files and ${Number.isNaN(bytes) ? "no log" : `a ${bytes}-byte log`}`,
    );
  }
  return { files };
}
