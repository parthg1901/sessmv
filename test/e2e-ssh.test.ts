/**
 * The ssh target, end to end, without a network: `ssh` and `scp` on PATH are
 * replaced by stand-ins that act on a fake remote home and log how they were
 * called. This checks what the tool asks ssh and scp to do, not OpenSSH itself.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDirs, FIXTURE, makeSourceHome, makeTargetHome, runCli, SESSION_ID, snapshot, tempDir } from "./helpers.ts";

afterAll(cleanupTempDirs);

const TARGET_FOLDER = "-home-tester-proj-app";

/** Fake `ssh <host> <command>` and `scp [flags] <src> <host>:<dir>/` that operate on $FAKE_REMOTE_HOME. */
async function installFakeSsh(): Promise<{ env: (remoteHome: string) => Record<string, string>; calls: () => Promise<string[]> }> {
  const dir = await tempDir("sessmv-bin-");
  const log = join(dir, "calls.log");
  const ssh = `#!/bin/sh
echo "ssh $*" >> "${log}"
shift
cd "$FAKE_REMOTE_HOME" && HOME="$FAKE_REMOTE_HOME" exec sh -c "$*"
`;
  const scp = `#!/bin/sh
echo "scp $*" >> "${log}"
for arg in "$@"; do last=$arg; done
dest="$FAKE_REMOTE_HOME/\${last#*:}"
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    "$last") ;;
    *) cp -R -p "$arg" "$dest" || exit 1 ;;
  esac
done
`;
  await mkdir(dir, { recursive: true });
  for (const [name, body] of [["ssh", ssh], ["scp", scp]] as const) {
    await writeFile(join(dir, name), body);
    await chmod(join(dir, name), 0o755);
  }
  return {
    env: (remoteHome) => ({ PATH: `${dir}:/usr/bin:/bin`, FAKE_REMOTE_HOME: remoteHome }),
    calls: async () => (await Bun.file(log).text()).trim().split("\n"),
  };
}

describe("ssh target", () => {
  test("copies the session with ssh and scp and prints the ssh resume command", async () => {
    const source = await makeSourceHome();
    const remote = await makeTargetHome();
    const fake = await installFakeSsh();

    const result = await runCli([SESSION_ID, "fakehost", "--map", "/Users/testuser=/home/tester", "--mode", "symlink"], source, fake.env(remote));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const fixture = await snapshot(FIXTURE);
    expect(await snapshot(join(remote, ".claude"))).toEqual({
      [`projects/${TARGET_FOLDER}/${SESSION_ID}.jsonl`]: fixture["main.jsonl"]!,
      [`projects/${TARGET_FOLDER}/${SESSION_ID}/subagents/agent-a1.jsonl`]: fixture["subagents/agent-a1.jsonl"]!,
      [`projects/${TARGET_FOLDER}/${SESSION_ID}/subagents/agent-a1.meta.json`]: fixture["subagents/agent-a1.meta.json"]!,
      [`projects/${TARGET_FOLDER}/${SESSION_ID}/tool-results/b1.txt`]: fixture["tool-results/b1.txt"]!,
      [`file-history/${SESSION_ID}/abc123@v1`]: fixture["file-history/abc123@v1"]!,
    });
    expect(result.stdout).toContain(`target folder  ${remote}/.claude/projects/${TARGET_FOLDER}`);
    expect(result.stdout).toContain(`ssh -t fakehost 'cd /home/tester/proj/app && ~/.local/bin/claude --resume ${SESSION_ID}'`);
  });

  test("sends scripts on stdin and uploads to paths relative to the remote home, log last", async () => {
    const source = await makeSourceHome();
    const remote = await makeTargetHome();
    const fake = await installFakeSsh();
    await runCli([SESSION_ID, "fakehost", "--map", "/Users/testuser=/home/tester", "--mode", "symlink"], source, fake.env(remote));

    const calls = await fake.calls();
    expect(calls.filter((c) => c.startsWith("ssh ")).every((c) => c === "ssh fakehost sh -s")).toBe(true);
    const sourceFolder = join(source, ".claude", "projects", "-Users-testuser-proj-app");
    expect(calls.filter((c) => c.startsWith("scp "))).toEqual([
      `scp -q -r -p ${sourceFolder}/${SESSION_ID} fakehost:.claude/projects/${TARGET_FOLDER}/`,
      `scp -q -r -p ${join(source, ".claude", "file-history", SESSION_ID)} fakehost:.claude/file-history/`,
      `scp -q -r -p ${sourceFolder}/${SESSION_ID}.jsonl fakehost:.claude/projects/${TARGET_FOLDER}/`,
    ]);
  });

  test("--dry-run runs no scp", async () => {
    const source = await makeSourceHome();
    const remote = await makeTargetHome();
    const fake = await installFakeSsh();
    const result = await runCli([SESSION_ID, "fakehost", "--map", "/Users/testuser=/home/tester", "--mode", "symlink", "--dry-run"], source, fake.env(remote));
    expect(result.code).toBe(0);
    expect((await fake.calls()).some((c) => c.startsWith("scp "))).toBe(false);
    expect(await snapshot(join(remote, ".claude"))).toEqual({});
  });

  test("reports an unreachable host clearly", async () => {
    const source = await makeSourceHome();
    const dir = await tempDir("sessmv-bin-");
    await writeFile(join(dir, "ssh"), '#!/bin/sh\necho "ssh: Could not resolve hostname nowhere" >&2\nexit 255\n');
    await chmod(join(dir, "ssh"), 0o755);
    const result = await runCli([SESSION_ID, "nowhere", "--mode", "symlink"], source, { PATH: `${dir}:/usr/bin:/bin` });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not reach nowhere: ssh: Could not resolve hostname nowhere");
  });
});
