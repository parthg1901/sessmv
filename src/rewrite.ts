/**
 * Path rewriting for session files.
 *
 * Rules:
 *  - String values change wherever they contain a mapped path. Numbers,
 *    booleans and null never change.
 *  - An object key changes only when the whole key is an absolute path at or
 *    below a mapped prefix (checkpoint records key their entries by file
 *    path). Relative paths and other text used as keys are left alone. A
 *    rewritten key keeps its position and counts as one replacement.
 *  - If two keys of one object end up equal, that is a KeyCollisionError:
 *    one entry would silently replace the other.
 *  - A map applies where its `from` is a path prefix: it starts at a path
 *    start (not in the middle of a longer path) and ends at a path boundary
 *    (/Users/testuser matches /Users/testuser and /Users/testuser/x, never
 *    /Users/testuserx).
 *  - When several maps match at the same position the longest `from` wins,
 *    whatever order the maps are given in.
 *  - Output is never scanned again, so /a -> /b plus /b -> /c turns /a/x into /b/x.
 *  - Inputs are never mutated.
 */
import { mapPath, type PathMap } from "./paths.ts";

export type { PathMap };

/** Two keys of one object map to the same path, so one entry would overwrite the other. */
export class KeyCollisionError extends Error {
  constructor(
    /** The two keys as they were before rewriting. */
    readonly keys: readonly [string, string],
    /** The key both of them become. */
    readonly target: string,
    /** 1-based line of the record in a JSONL file, when known. */
    readonly line?: number,
  ) {
    super(`keys "${keys[0]}" and "${keys[1]}" both map to "${target}"${line === undefined ? "" : ` (line ${line})`}`);
    this.name = "KeyCollisionError";
  }
}

export interface StringRewrite {
  value: string;
  /** Number of path prefixes replaced. */
  replacements: number;
}

export interface ValueRewrite<T> {
  value: T;
  replacements: number;
}

export interface JsonlRewrite {
  text: string;
  /** Lines that parsed as JSON. */
  records: number;
  /** Records in which at least one string or key changed. */
  rewritten: number;
  /** Total path prefixes replaced across all records. */
  replacements: number;
  /** Non-empty lines that are not valid JSON; they are passed through untouched. */
  unparsed: number;
}

/** A letter, digit, underscore or dash: a character that continues a file or directory name. */
const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/** The character that ends just before `index`, or "" at the start of the string. */
function charBefore(text: string, index: number): string {
  // Two UTF-16 units back is enough to hold one whole character.
  return Array.from(text.slice(Math.max(0, index - 2), index)).pop() ?? "";
}

/** The character that starts at `index`, or "" at the end of the string. */
function charAt(text: string, index: number): string {
  const code = text.codePointAt(index);
  return code === undefined ? "" : String.fromCodePoint(code);
}

/**
 * Can a path begin at `index`? Not if the text just before it makes this the
 * middle of some other path: a name (/backup/Users/x, $ROOT/Users/x) or a
 * relative or home prefix (./Users/x, ~/Users/x). Brackets and other
 * punctuation do not glue: output such as `{"ok":true}/Users/x` is JSON
 * followed by a real path.
 */
function startsPath(text: string, index: number): boolean {
  const before = charBefore(text, index);
  if (before === "") return true;
  // After a slash we are inside a longer path, unless the slashes belong to a URL scheme (file:///Users/x).
  if (before === "/") return text.slice(0, index).endsWith("://");
  return !NAME_CHAR.test(before) && before !== "." && before !== "~";
}

/**
 * Does a path prefix end at `index`? Yes at the end of the string, at a slash,
 * and at anything that cannot continue a name. A dot is ambiguous: it ends a
 * sentence ("in /Users/x.") but also starts an extension (/Users/x.bak), so
 * dots end the path only when no name or slash follows them.
 */
function endsPath(text: string, index: number): boolean {
  let next = charAt(text, index);
  if (next !== ".") return next === "" || next === "/" || !NAME_CHAR.test(next);
  let afterDots = index;
  while (text[afterDots] === ".") afterDots++;
  next = charAt(text, afterDots);
  return next !== "/" && !NAME_CHAR.test(next);
}

/** Usable maps, longest `from` first, so the first one that matches is the most specific. */
function longestFirst(maps: readonly PathMap[]): PathMap[] {
  return maps.filter((map) => map.from !== "" && map.from !== map.to).sort((a, b) => b.from.length - a.from.length);
}

function replacePaths(input: string, ordered: readonly PathMap[]): StringRewrite {
  // Most strings contain no mapped prefix at all, and most characters cannot start one.
  // These two checks only skip work; they do not change the result.
  if (!ordered.some((m) => input.includes(m.from))) return { value: input, replacements: 0 };
  const firstChars = new Set(ordered.map((m) => m.from[0]));

  let output = "";
  let copied = 0; // everything in `input` before this is already in `output`
  let replacements = 0;
  let index = 0;
  while (index < input.length) {
    const map = firstChars.has(input[index])
      ? ordered.find((m) => input.startsWith(m.from, index) && endsPath(input, index + m.from.length))
      : undefined;
    if (!map || !startsPath(input, index)) {
      index++;
      continue;
    }
    output += input.slice(copied, index) + map.to;
    // Carry on after the match in the input, not in the output, so replaced text is never matched again.
    index += map.from.length;
    copied = index;
    replacements++;
  }
  return replacements === 0 ? { value: input, replacements } : { value: output + input.slice(copied), replacements };
}

function rewriteNode(node: unknown, ordered: readonly PathMap[], count: { replacements: number }): unknown {
  if (typeof node === "string") {
    const result = replacePaths(node, ordered);
    count.replacements += result.replacements;
    return result.value;
  }
  if (Array.isArray(node)) return node.map((item) => rewriteNode(item, ordered, count));
  if (node === null || typeof node !== "object") return node;

  const entries: [string, unknown][] = [];
  const originalOf = new Map<string, string>(); // new key -> the key it came from
  for (const [key, child] of Object.entries(node)) {
    // A key is treated as one whole path, never as text that might contain paths.
    const newKey = mapPath(key, ordered);
    const earlier = originalOf.get(newKey);
    if (earlier !== undefined) throw new KeyCollisionError([earlier, key], newKey);
    originalOf.set(newKey, key);
    if (newKey !== key) count.replacements++;
    entries.push([newKey, rewriteNode(child, ordered, count)]);
  }
  // fromEntries keeps the order and, unlike assignment, stores a "__proto__" key as plain data.
  return Object.fromEntries(entries);
}

/**
 * Replace every mapped path prefix inside one string. Also used directly on
 * tool-results/*.txt, where the whole file is one string.
 */
export function rewriteString(input: string, maps: readonly PathMap[]): StringRewrite {
  return replacePaths(input, longestFirst(maps));
}

/**
 * Deep-copy a parsed JSON value with rewriteString applied to every string
 * value at any depth, and absolute-path keys mapped. Key order is preserved.
 * Throws KeyCollisionError when two keys of one object become equal. Also used
 * on *.meta.json.
 */
export function rewriteValue<T>(value: T, maps: readonly PathMap[]): ValueRewrite<T> {
  const count = { replacements: 0 };
  const rewritten = rewriteNode(value, longestFirst(maps), count) as T;
  return { value: rewritten, replacements: count.replacements };
}

/**
 * Rewrite a JSONL document record by record: parse each line, rewrite it,
 * serialise it back on one line. Record order, every field, blank lines and the
 * presence or absence of a trailing newline are preserved. A record with no
 * replacements is emitted byte-for-byte as it came in, and so is a line that
 * does not parse. The text is never search-and-replaced as a whole. A key
 * collision is rethrown as a KeyCollisionError carrying the record's line.
 */
export function rewriteJsonl(text: string, maps: readonly PathMap[]): JsonlRewrite {
  const ordered = longestFirst(maps);
  const totals = { records: 0, rewritten: 0, replacements: 0, unparsed: 0 };

  const lines = text.split("\n").map((line, index) => {
    if (line.trim() === "") return line;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      totals.unparsed++;
      return line;
    }
    totals.records++;

    const count = { replacements: 0 };
    let rewritten: unknown;
    try {
      rewritten = rewriteNode(record, ordered, count);
    } catch (err) {
      if (err instanceof KeyCollisionError) throw new KeyCollisionError(err.keys, err.target, index + 1);
      throw err;
    }
    // Re-serialising can change number formatting and escapes, so untouched records keep their original bytes.
    if (count.replacements === 0) return line;
    totals.rewritten++;
    totals.replacements += count.replacements;
    return JSON.stringify(rewritten);
  });

  return { text: lines.join("\n"), ...totals };
}
