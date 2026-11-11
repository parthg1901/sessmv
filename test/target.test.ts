import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalTarget, parseTarget, SshTarget } from "../src/target.ts";
import { cleanupTempDirs, snapshot, tempDir } from "./helpers.ts";

afterAll(cleanupTempDirs);

describe("parseTarget", () => {
  test("local:<dir> is a local target, anything else an ssh host", () => {
    expect(parseTarget("local:/tmp/fake-home")).toBeInstanceOf(LocalTarget);
    expect(parseTarget("myserver")).toBeInstanceOf(SshTarget);
    expect(parseTarget("me@example.com")).toBeInstanceOf(SshTarget);
  });

  test("rejects an empty local dir and hosts that could be read as options", () => {
    expect(() => parseTarget("local:")).toThrow(/needs a directory/);
    expect(() => parseTarget("-oProxyCommand=evil")).toThrow(/invalid ssh host/);
    expect(() => parseTarget("")).toThrow(/invalid ssh host/);
  });
});

describe("resumeCommand", () => {
  test("ssh: one command the user can paste", () => {
    expect(new SshTarget("myserver").resumeCommand("/home/tester/proj/app", "~/.local/bin/tool --resume abc")).toBe(
      "ssh -t myserver 'cd /home/tester/proj/app && ~/.local/bin/tool --resume abc'",
    );
  });

  test("ssh: a cwd with spaces survives both shells", () => {
    expect(new SshTarget("myserver").resumeCommand("/home/tester/my proj", "tool --resume abc")).toBe(
      `ssh -t myserver 'cd '\\''/home/tester/my proj'\\'' && tool --resume abc'`,
    );
  });

  test("local: runs the command with the fake home", () => {
    expect(new LocalTarget("/tmp/fake-home").resumeCommand("/tmp/fake-home/proj", "tool --resume abc")).toBe(
      "cd /tmp/fake-home/proj && HOME=/tmp/fake-home tool --resume abc",
    );
  });
});

describe("LocalTarget", () => {
  test("exec runs sh with HOME set to the fake home", async () => {
    const home = await tempDir();
    const result = await new LocalTarget(home).exec('printf "%s" "$HOME"; exit 3');
    expect(result).toEqual({ code: 3, stdout: home, stderr: "" });
  });

  test("upload copies a file or a directory into a directory under home", async () => {
    const home = await tempDir();
    const src = await tempDir();
    await mkdir(join(src, "dir", "nested"), { recursive: true });
    await writeFile(join(src, "dir", "nested", "a.txt"), "a");
    await writeFile(join(src, "one.txt"), "one");
    const target = new LocalTarget(home);
    await target.upload(join(src, "dir"), "dest");
    await target.upload(join(src, "one.txt"), "dest");
    expect(await snapshot(join(home, "dest"))).toEqual({ "dir/nested/a.txt": "a", "one.txt": "one" });
  });
});
