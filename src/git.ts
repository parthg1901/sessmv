import { shellQuoteStrict } from "./paths.ts";
import { parseKeyValues, type Target } from "./target.ts";

export type GitState =
  | { kind: "missing-dir" }
  | { kind: "no-git" }
  | { kind: "not-a-repo" }
  | { kind: "repo"; remote: string; branch: string; head: string; dirty: boolean };

/** One portable script, run unchanged on the source and on the target. */
function gitScript(cwd: string): string {
  return `
cd ${shellQuoteStrict(cwd)} 2>/dev/null || { echo state=missing-dir; exit 0; }
command -v git >/dev/null 2>&1 || { echo state=no-git; exit 0; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo state=not-a-repo; exit 0; }
echo state=repo
remote=$(git config --get remote.origin.url 2>/dev/null)
if [ -z "$remote" ]; then
  first=$(git remote 2>/dev/null | head -n 1)
  [ -n "$first" ] && remote=$(git config --get "remote.$first.url" 2>/dev/null)
fi
printf 'remote=%s\\n' "$remote"
printf 'branch=%s\\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
printf 'head=%s\\n' "$(git rev-parse HEAD 2>/dev/null)"
if [ -n "$(git status --porcelain 2>/dev/null | head -n 1)" ]; then echo dirty=1; else echo dirty=0; fi
`;
}

export function parseGitState(stdout: string): GitState {
  const values = parseKeyValues(stdout);
  const state = values.get("state");
  if (state === "missing-dir" || state === "no-git" || state === "not-a-repo") return { kind: state };
  if (state !== "repo") throw new Error(`unexpected git check output: ${stdout.trim() || "(empty)"}`);
  return {
    kind: "repo",
    remote: values.get("remote") ?? "",
    branch: values.get("branch") ?? "",
    head: values.get("head") ?? "",
    dirty: values.get("dirty") === "1",
  };
}

export async function gitState(machine: Target, cwd: string): Promise<GitState> {
  const result = await machine.exec(gitScript(cwd));
  if (result.code !== 0) {
    throw new Error(`git check failed on ${machine.label}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return parseGitState(result.stdout);
}

/**
 * Reduce a remote URL to host/path so the same repository cloned over SSH on
 * one machine and HTTPS on the other still compares equal.
 */
export function normalizeRemote(url: string): string {
  let rest = url.trim();
  const scheme = rest.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
  } else if (!rest.startsWith("/") && /^[^/]+:/.test(rest)) {
    // scp-like form: git@github.com:owner/repo.git
    rest = rest.replace(":", "/");
  }
  rest = rest.replace(/^[^/@]+@/, "");
  rest = rest.replace(/\/+$/, "").replace(/\.git$/, "");
  const slash = rest.indexOf("/");
  return slash < 0 ? rest.toLowerCase() : rest.slice(0, slash).toLowerCase() + rest.slice(slash);
}

export interface GitComparison {
  /** "skipped" when the source side is not a repo, so there is nothing to compare. */
  status: "match" | "mismatch" | "skipped";
  /** One-line description of each side, for the summary. */
  source: string;
  target: string;
  warnings: string[];
}

export function describeGit(state: GitState): string {
  switch (state.kind) {
    case "missing-dir":
      return "directory does not exist";
    case "no-git":
      return "git is not installed";
    case "not-a-repo":
      return "not a git repository";
    case "repo":
      return `${state.branch || "(no branch)"} @ ${state.head.slice(0, 12) || "(no commits)"}${state.dirty ? " (dirty)" : ""}  ${state.remote || "(no remote)"}`;
  }
}

/** Compare the session's working directory on both machines. Never blocks; only produces warnings. */
export function compareGit(source: GitState, target: GitState, sourceCwd: string, targetCwd: string): GitComparison {
  const warnings: string[] = [];
  const base = { source: describeGit(source), target: describeGit(target) };

  if (target.kind === "missing-dir") {
    warnings.push(`${targetCwd} does not exist on the target; create it (or clone the repo there) before resuming`);
  }
  if (source.kind !== "repo") {
    return { ...base, status: warnings.length ? "mismatch" : "skipped", warnings };
  }
  if (source.dirty) {
    warnings.push(`source has uncommitted changes in ${sourceCwd}; they are not part of the move`);
  }
  if (target.kind !== "repo") {
    if (target.kind !== "missing-dir") {
      warnings.push(`source is a git repository but ${targetCwd} on the target is not (${describeGit(target)})`);
    }
    return { ...base, status: "mismatch", warnings };
  }

  if (normalizeRemote(source.remote) !== normalizeRemote(target.remote)) {
    warnings.push(`remote differs: source ${source.remote || "(none)"}, target ${target.remote || "(none)"}`);
  }
  if (source.branch !== target.branch) {
    warnings.push(`branch differs: source ${source.branch || "(none)"}, target ${target.branch || "(none)"}`);
  }
  if (source.head !== target.head) {
    warnings.push(`HEAD differs: source ${source.head.slice(0, 12) || "(none)"}, target ${target.head.slice(0, 12) || "(none)"}`);
  }
  if (target.dirty) {
    warnings.push(`target has uncommitted changes in ${targetCwd}`);
  }
  return { ...base, status: warnings.length ? "mismatch" : "match", warnings };
}
