# sessmv

Copy a Claude Code session from one machine to another over SSH, so that
`claude --resume <session-id>` on the target continues the same conversation.

It moves sessions between machines only. It does not convert a session to
another coding agent's format.

## Status

Developed and tested on Linux, including real sessions moved between two
Linux containers over SSH and resumed there in both modes. It uses only `ssh`,
`scp` and POSIX `sh` features that macOS also ships, but it has not been run on
macOS yet.

## Requirements

- [Bun](https://bun.sh) on the machine you run it from
- `ssh` and `scp` (OpenSSH), with the target reachable non-interactively
- The same Claude Code version on both machines

## Install

```sh
bun install
ln -s "$PWD/src/cli.ts" ~/.local/bin/sessmv   # or run it as: bun src/cli.ts
```

## Usage

```
sessmv <session-id> <ssh-host | local:<dir>> [--map <from>=<to> ...] [--mode rewrite|symlink] [--dry-run] [--force]
```

Send a session from a Mac to a server known to SSH as `myserver`:

```sh
sessmv 6f1c2a9e-0d3b-4c57-9e21-7b5a4d8c1f02 myserver --dry-run   # look first
sessmv 6f1c2a9e-0d3b-4c57-9e21-7b5a4d8c1f02 myserver
```

The last lines of the output are the command to continue the conversation:

```sh
ssh -t myserver 'cd /home/tester/proj && ~/.local/bin/claude --resume 6f1c2a9e-0d3b-4c57-9e21-7b5a4d8c1f02'
```

| Option | Meaning |
| --- | --- |
| `--map <from>=<to>` | Map a source path prefix to a target path. Repeatable. Default: source `$HOME` to target `$HOME`. Passing any `--map` replaces the default, so include the home pair if you still want it. |
| `--mode rewrite` | Default. Rewrite mapped paths in copies of the session files. |
| `--mode symlink` | Copy byte-for-byte and print the commands that make the old paths exist on the target. |
| `--dry-run` | Do everything except copy, and print the summary. |
| `--force` | Continue when the Claude Code versions differ, and replace a copy of the session that already exists on the target. |

Exit status is 0 on success, 1 when the move is refused or fails, 2 on a usage error.

### What it does

1. Finds the session by id across all project folders under `~/.claude/projects`.
   It stops if the id is missing or appears in more than one folder. It warns
   if the session was written to in the last two minutes, because a session
   that is still open keeps growing on the source after the copy.
2. Reads the target's `$HOME` and Claude Code version. Claude Code is called as
   `~/.local/bin/claude`, falling back to `claude` on `PATH`, because
   `~/.local/bin` is not on `PATH` in a non-interactive SSH session. It stops
   if the versions differ, unless `--force`.
3. Compares the session's working directory on both machines: remote URL,
   branch, HEAD commit and uncommitted changes. Differences, a missing
   repository and a missing directory are printed as warnings. They never block.
4. Handles paths according to the mode (below).
5. Copies the session into the target's `~/.claude`. An existing copy is never
   overwritten unless `--force`, which removes it first.
6. Prints a summary and the resume command.

What is copied:

| Source | Contents |
| --- | --- |
| `~/.claude/projects/<encoded-cwd>/<id>.jsonl` | Main log |
| `~/.claude/projects/<encoded-cwd>/<id>/subagents/` | Subagent logs and metadata |
| `~/.claude/projects/<encoded-cwd>/<id>/tool-results/` | Saved tool output |
| `~/.claude/file-history/<id>/` | File checkpoints |

`<encoded-cwd>` is the working directory with every non-alphanumeric character
replaced by `-`, so the folder name changes when the working directory does:
`/Users/testuser/proj` is `-Users-testuser-proj`, `/home/tester/proj` is
`-home-tester-proj`. The session is placed in the folder for the mapped
working directory.

## Modes

### rewrite (default)

Each record of each JSONL file is parsed, and mapped path prefixes are replaced
inside string values, at path boundaries: `/Users/testuser` matches
`/Users/testuser/proj` but never `/Users/testuserx`. The files are never
search-and-replaced as text. The same is applied to subagent logs, their
metadata files and saved tool results. Record order and every field are kept.

Object keys are left alone unless the whole key is an absolute path under a
mapped prefix. Checkpoint records key their entries by file path, and those
keys have to follow the files. If two keys of one object would become the same
path, the run stops before copying anything and names the file and line.

Rewritten copies are written to a temporary directory and uploaded from there.
The originals are not modified. File checkpoints are copies of your own files
and are copied unchanged.

Besides the maps you give, one map is added automatically: the session's own
folder on the source to its folder on the target. Logs refer to saved tool
results by absolute path, and that folder's name changes with the working
directory.

#### How the rewrite works

A session log is JSON, so a path can be written with escapes (`\/Users\/testuser`)
and can sit next to text that only looks like it; a plain find-and-replace
would miss the first and damage the second. `sessmv` therefore parses every
record, changes the strings inside it and writes the record back, and a record
with nothing to change is copied byte-for-byte. Inside a string, a mapped
prefix is replaced only where it is a whole path prefix: no name, `.` or `~`
may come right before it (so `/Volumes/backup/Users/testuser` and
`~/Users/testuser` are left alone), and after it must come a slash, the end of
the text or punctuation (so `/Users/testuserx` and `/Users/testuser.bak` are
left alone, while a period that ends a sentence is fine). When two maps could
apply at the same spot the longer prefix wins, which is what lets the session's
own folder take its new name while everything else under home follows the home
map. Replaced text is never looked at again, so one map's output cannot be
picked up by another. Object keys change only when the whole key is an absolute
path under a mapped prefix, because checkpoint records use file paths as keys.
If two keys of the same object would end up identical, `sessmv` stops with an
error naming the file and line rather than let one entry overwrite the other.

### symlink

Files are copied byte-for-byte. The old paths then have to exist on the
target, so `sessmv` prints the commands that create them and leaves running
them to you:

```sh
sudo mkdir -p /Users
sudo ln -s /home/tester /Users/testuser
```

It first checks the target and says so if the path already resolves to the
right place or is taken by something else.

## Testing without SSH

`local:<dir>` treats `<dir>` as the target's home directory on the same
machine, so the whole flow runs without a network:

```sh
sessmv <session-id> local:/tmp/fake-home --dry-run
```

```sh
bun test            # unit and end-to-end tests
bun run typecheck
```

The tests build a fake source home from small hand-written fixtures in
`test/fixtures` and run the CLI against `local:` targets. Fixtures are
synthetic. Do not add real session files: they contain secrets.

## Limitations

- **One-way.** The session is copied, not synchronised. After you resume on the
  target, the two copies diverge and there is no merge.
- **The prompt cache never carries over.** The system prompt and tool list
  differ per machine, so the first resumed turn is a full-price cache miss.
- **Only the conversation moves.** The working tree, uncommitted changes,
  project memory and the rest of `~/.claude` stay where they are. Use the git
  check's output to bring the target's repository to the same state.
- **Some paths are left as written.** A path glued to a word, such as the
  compiler flag `-I/Users/testuser/include`, is not recognised, and neither are
  relative paths or paths of temporary files outside the mapped prefixes. They
  only appear in old tool output, so the conversation still resumes.
- **Symlink mode** needs root on the target, and paths that point into the
  session's own folder (saved tool results) do not resolve there, because the
  folder is renamed. On a macOS target `/home` is managed by the system, so a
  Linux home path cannot simply be created; use rewrite mode.
- **Same version only.** The log format is undocumented and changes between
  Claude Code releases. `--force` skips the check, not the risk.

## Layout

| File | Role |
| --- | --- |
| `src/cli.ts` | Argument parsing, the six steps, the summary |
| `src/claude-code-store.ts` | Everything specific to Claude Code: storage layout, the encoded-cwd rule, version check, resume command |
| `src/locate.ts` | Finds a session on the source |
| `src/target.ts` | One `Target` interface with `ssh` and `local` implementations |
| `src/git.ts` | Git state on each side and their comparison |
| `src/rewrite.ts` | Path rewriting |
| `src/copy.ts` | Staging, upload and verification |
| `src/paths.ts` | Path maps and shell quoting |
