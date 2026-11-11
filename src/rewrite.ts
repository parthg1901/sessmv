/**
 * Path rewriting for session files.
 *
 * STUB: the three functions below are not implemented. Their contract is
 * pinned down by test/rewrite.test.ts and test/e2e-rewrite.test.ts, which fail
 * until they are.
 *
 * Shared rules:
 *  - Only string VALUES change. Object keys, numbers, booleans and null never do.
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
 * value at any depth. Key order is preserved. Also used on *.meta.json.
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
 * does not parse. The text is never search-and-replaced as a whole.
 */
export function rewriteJsonl(text: string, maps: readonly PathMap[]): JsonlRewrite {
  void text;
  void maps;
  throw new NotImplementedError("rewriteJsonl");
}
