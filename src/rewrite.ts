/**
 * Path rewriting for session files.
 *
 * STUB: the three functions below are not implemented. Their contract is
 * pinned down by test/rewrite.test.ts and test/e2e-rewrite.test.ts, which fail
 * until they are.
 *
 * Shared rules:
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
import type { PathMap } from "./paths.ts";

export type { PathMap };

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (src/rewrite.ts is a stub)`);
    this.name = "NotImplementedError";
  }
}

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
  /** Records in which at least one string changed. */
  rewritten: number;
  /** Total path prefixes replaced across all records. */
  replacements: number;
  /** Non-empty lines that are not valid JSON; they are passed through untouched. */
  unparsed: number;
}

/**
 * Replace every mapped path prefix inside one string. Also used directly on
 * tool-results/*.txt, where the whole file is one string.
 */
export function rewriteString(input: string, maps: readonly PathMap[]): StringRewrite {
  void input;
  void maps;
  throw new NotImplementedError("rewriteString");
}

/**
 * Deep-copy a parsed JSON value with rewriteString applied to every string
 * value at any depth, and absolute-path keys mapped. Key order is preserved.
 * Throws KeyCollisionError when two keys of one object become equal. Also used
 * on *.meta.json.
 */
export function rewriteValue<T>(value: T, maps: readonly PathMap[]): ValueRewrite<T> {
  void value;
  void maps;
  throw new NotImplementedError("rewriteValue");
}

/**
 * Rewrite a JSONL document record by record: parse each line, rewriteValue it,
 * serialise it back on one line. Record order, every field, blank lines and the
 * presence or absence of a trailing newline are preserved. A record with no
 * replacements is emitted byte-for-byte as it came in, and so is a line that
 * does not parse. The text is never search-and-replaced as a whole. A key
 * collision is rethrown as a KeyCollisionError carrying the record's line.
 */
export function rewriteJsonl(text: string, maps: readonly PathMap[]): JsonlRewrite {
  void text;
  void maps;
  throw new NotImplementedError("rewriteJsonl");
}
