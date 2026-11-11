/** A path prefix mapping: anything at or below `from` on the source lives at `to` on the target. */
export interface PathMap {
  from: string;
  to: string;
}

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/** Parse one `--map /from=/to` argument. */
export function parseMapArg(arg: string): PathMap {
  const eq = arg.indexOf("=");
  if (eq < 0) throw new Error(`invalid --map "${arg}": expected /source/path=/target/path`);
  const from = stripTrailingSlashes(arg.slice(0, eq));
  const to = stripTrailingSlashes(arg.slice(eq + 1));
  if (!from.startsWith("/") || !to.startsWith("/")) {
    throw new Error(`invalid --map "${arg}": both sides must be absolute paths`);
  }
  if (from === "/") throw new Error(`invalid --map "${arg}": refusing to map the filesystem root`);
  return { from, to };
}

/** Normalise a home directory (or any directory) into the form used in maps. */
export function normalizeDir(path: string): string {
  return stripTrailingSlashes(path);
}

/**
 * Map one whole absolute path (not text containing paths; that is rewrite.ts).
 * The longest matching `from` wins. A path outside every map is returned unchanged.
 */
export function mapPath(path: string, maps: readonly PathMap[]): string {
  let best: PathMap | undefined;
  for (const map of maps) {
    const hit = path === map.from || path.startsWith(`${map.from}/`);
    if (hit && (!best || map.from.length > best.from.length)) best = map;
  }
  return best ? best.to + path.slice(best.from.length) : path;
}

/** Quote a string for a POSIX shell. Plain words are left bare so output stays readable. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Always-quoted variant, for values embedded in generated scripts. */
export function shellQuoteStrict(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
