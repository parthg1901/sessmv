import { cp, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { shellQuote, shellQuoteStrict } from "./paths.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A machine a session can be copied to. Everything the tool does on the
 * target goes through these three operations.
 */
export interface Target {
  readonly kind: "ssh" | "local";
  /** Name used in messages. */
  readonly label: string;
  /** Run a POSIX sh script on the target with the target's $HOME. */
  exec(script: string): Promise<ExecResult>;
  /**
   * Copy a local file or directory into `destDir`, keeping its name.
   * `destDir` is relative to the target's home and must already exist.
   */
  upload(localPath: string, destDir: string): Promise<void>;
  /** Wrap a harness's resume command so it runs on the target, in `cwd`. */
  resumeCommand(cwd: string, command: string): string;
}

async function run(cmd: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}): Promise<ExecResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ?? process.env,
    });
  } catch (err) {
    return { code: 127, stdout: "", stderr: `${cmd[0]}: ${(err as Error).message}` };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A directory on this machine acting as a home: the source side, or a `local:<dir>` test target. */
export class LocalTarget implements Target {
  readonly kind = "local";
  readonly home: string;
  readonly label: string;

  constructor(home: string) {
    this.home = resolve(home);
    this.label = `local:${this.home}`;
  }

  exec(script: string): Promise<ExecResult> {
    return run(["sh", "-s"], { stdin: script, env: { ...process.env, HOME: this.home } });
  }

  async upload(localPath: string, destDir: string): Promise<void> {
    const dest = join(this.home, destDir);
    await mkdir(dest, { recursive: true });
    await cp(localPath, join(dest, basename(localPath)), { recursive: true, force: true, dereference: true, preserveTimestamps: true });
  }

  resumeCommand(cwd: string, command: string): string {
    return `cd ${shellQuote(cwd)} && HOME=${shellQuote(this.home)} ${command}`;
  }
}

/** A remote machine reached with the system ssh and scp, so host aliases and keys from ~/.ssh/config apply. */
export class SshTarget implements Target {
  readonly kind = "ssh";
  readonly label: string;

  constructor(readonly host: string) {
    if (host === "" || host.startsWith("-") || /[\s:]/.test(host)) {
      throw new Error(`invalid ssh host "${host}"`);
    }
    this.label = host;
  }

  exec(script: string): Promise<ExecResult> {
    // The script travels on stdin, so nothing has to survive the remote login shell's quoting rules.
    return run(["ssh", this.host, "sh -s"], { stdin: script });
  }

  async upload(localPath: string, destDir: string): Promise<void> {
    // scp resolves relative remote paths against the remote home in both its
    // legacy and SFTP modes. -r, -p and -q exist in every OpenSSH scp.
    const result = await run(["scp", "-q", "-r", "-p", localPath, `${this.host}:${destDir}/`]);
    if (result.code !== 0) {
      throw new Error(`scp to ${this.host}:${destDir}/ failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
  }

  resumeCommand(cwd: string, command: string): string {
    return `ssh -t ${shellQuote(this.host)} ${shellQuoteStrict(`cd ${shellQuote(cwd)} && ${command}`)}`;
  }
}

/** Parse the CLI's target argument: `local:<dir>` or an ssh host. */
export function parseTarget(arg: string): Target {
  if (arg.startsWith("local:")) {
    const dir = arg.slice("local:".length);
    if (dir === "") throw new Error("local: target needs a directory, e.g. local:/tmp/fake-home");
    return new LocalTarget(dir);
  }
  return new SshTarget(arg);
}

/** Split `key=value` lines as printed by the tool's shell scripts. */
export function parseKeyValues(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return out;
}
