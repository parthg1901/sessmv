/**
 * Specification for src/rewrite.ts. Cases whose right answer is a judgement
 * call are marked "Decided" with the rule that was chosen.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KeyCollisionError, rewriteJsonl, rewriteString, rewriteValue, type PathMap } from "../src/rewrite.ts";
import { FIXTURE, LINUX_TO_MAC, MAC_TO_LINUX, parseJsonl, SESSION_ID } from "./helpers.ts";

const toLinux = (input: string) => rewriteString(input, MAC_TO_LINUX).value;
const toMac = (input: string) => rewriteString(input, LINUX_TO_MAC).value;

describe("rewriteString: macOS to Linux", () => {
  test("maps the prefix on its own", () => {
    expect(rewriteString("/Users/testuser", MAC_TO_LINUX)).toEqual({ value: "/home/tester", replacements: 1 });
  });

  test("maps a path below the prefix and keeps the rest of it", () => {
    expect(rewriteString("/Users/testuser/proj/app/src/main.ts", MAC_TO_LINUX)).toEqual({
      value: "/home/tester/proj/app/src/main.ts",
      replacements: 1,
    });
  });

  test("keeps a trailing slash", () => {
    expect(toLinux("/Users/testuser/")).toBe("/home/tester/");
  });

  test("returns the input unchanged when nothing matches", () => {
    expect(rewriteString("no paths in here", MAC_TO_LINUX)).toEqual({ value: "no paths in here", replacements: 0 });
    expect(rewriteString("", MAC_TO_LINUX)).toEqual({ value: "", replacements: 0 });
    expect(rewriteString("/opt/homebrew/bin/node", MAC_TO_LINUX)).toEqual({ value: "/opt/homebrew/bin/node", replacements: 0 });
  });

  test("with no maps nothing changes", () => {
    expect(rewriteString("/Users/testuser/proj", [])).toEqual({ value: "/Users/testuser/proj", replacements: 0 });
  });
});

describe("rewriteString: the end of the prefix must be a path boundary", () => {
  test.each([
    ["a longer name", "/Users/testuserx"],
    ["a longer name with a path below it", "/Users/testuserx/proj/file.ts"],
    ["a digit suffix", "/Users/testuser2/proj"],
    ["a dash suffix", "/Users/testuser-old/proj"],
    ["an underscore suffix", "/Users/testuser_backup/proj"],
    ["a dotted suffix", "/Users/testuser.bak/proj"],
    ["a non-ASCII letter suffix", "/Users/testuseré/proj"],
  ])("does not match %s", (_name, input) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: input, replacements: 0 });
  });

  test.each([
    ["a slash", "/Users/testuser/x", "/home/tester/x"],
    ["a space", "cd /Users/testuser && ls", "cd /home/tester && ls"],
    ["a double quote", 'HOME="/Users/testuser"', 'HOME="/home/tester"'],
    ["a single quote", "HOME='/Users/testuser'", "HOME='/home/tester'"],
    ["a backtick", "run `ls /Users/testuser`", "run `ls /home/tester`"],
    ["a colon", "/Users/testuser:/usr/bin", "/home/tester:/usr/bin"],
    ["a comma", "/Users/testuser, then", "/home/tester, then"],
    ["a semicolon", "cd /Users/testuser; ls", "cd /home/tester; ls"],
    ["a closing paren", "(in /Users/testuser)", "(in /home/tester)"],
    ["a closing bracket", "[/Users/testuser]", "[/home/tester]"],
    ["a closing brace", "{/Users/testuser}", "{/home/tester}"],
    ["an angle bracket", "<cwd>/Users/testuser</cwd>", "<cwd>/home/tester</cwd>"],
    ["a newline", "/Users/testuser\nnext line", "/home/tester\nnext line"],
    ["a tab", "/Users/testuser\tdrwxr-xr-x", "/home/tester\tdrwxr-xr-x"],
    ["a backslash", '{\\"home\\":\\"/Users/testuser\\"}', '{\\"home\\":\\"/home/tester\\"}'],
  ])("matches when followed by %s", (_name, input, expected) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: expected, replacements: 1 });
  });

  // Decided: dots after the prefix end the path unless a name or a slash follows them.
  test.each([
    ["at the end of a sentence", "I am in /Users/testuser.", "I am in /home/tester."],
    ["before the next sentence", "Open /Users/testuser. Then run ls.", "Open /home/tester. Then run ls."],
    ["in an ellipsis", "somewhere under /Users/testuser...", "somewhere under /home/tester..."],
    ["before a closing quote", 'It said "/Users/testuser".', 'It said "/home/tester".'],
    ["before a line break", "cwd is /Users/testuser.\nnext", "cwd is /home/tester.\nnext"],
  ])("matches when followed by a period %s", (_name, input, expected) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: expected, replacements: 1 });
  });

  test.each([
    ["an extension", "/Users/testuser.tar.gz"],
    ["a name after two dots", "/Users/testuser..old/proj"],
    ["a slash", "/Users/testuser./proj"],
    ["a non-ASCII name", "/Users/testuser.é"],
  ])("does not match when the period is followed by %s", (_name, input) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: input, replacements: 0 });
  });

  test("a period after a longer path is handled the same way", () => {
    expect(toLinux("Edited /Users/testuser/proj/a.ts. Done.")).toBe("Edited /home/tester/proj/a.ts. Done.");
  });
});

describe("rewriteString: the prefix must start a path", () => {
  test.each([
    ["inside a longer absolute path", "/Volumes/backup/Users/testuser/archive"],
    ["one level down", "/mnt/Users/testuser"],
    ["below a home shorthand", "~/Users/testuser/notes.md"],
    ["below a relative path", "./Users/testuser/notes.md"],
    ["below a parent reference", "../Users/testuser/notes.md"],
    ["glued to a word", "backup/Users/testuser/archive"],
  ])("does not match %s", (_name, input) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: input, replacements: 0 });
  });

  test.each([
    ["a space", "ls /Users/testuser/proj", "ls /home/tester/proj"],
    ["an equals sign", "HOME=/Users/testuser", "HOME=/home/tester"],
    ["a colon", "PATH=/usr/bin:/Users/testuser/bin", "PATH=/usr/bin:/home/tester/bin"],
    ["a double quote", '"/Users/testuser/a.ts"', '"/home/tester/a.ts"'],
    ["a single quote", "'/Users/testuser/a.ts'", "'/home/tester/a.ts'"],
    ["an opening paren", "(/Users/testuser/a.ts:3)", "(/home/tester/a.ts:3)"],
    ["an opening bracket", "[/Users/testuser/a.ts]", "[/home/tester/a.ts]"],
    ["an angle bracket", "<file>/Users/testuser/a.ts", "<file>/home/tester/a.ts"],
    ["a newline", "first\n/Users/testuser/a.ts", "first\n/home/tester/a.ts"],
    ["a tab", "1\t/Users/testuser/a.ts", "1\t/home/tester/a.ts"],
    ["an at sign", "@/Users/testuser/a.ts", "@/home/tester/a.ts"],
  ])("matches when preceded by %s", (_name, input, expected) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: expected, replacements: 1 });
  });

  test("matches inside a file URL", () => {
    expect(rewriteString("file:///Users/testuser/proj/a.ts", MAC_TO_LINUX)).toEqual({
      value: "file:///home/tester/proj/a.ts",
      replacements: 1,
    });
  });

  // Decided: a prefix glued to a name is the middle of another path; one after a bracket is not.
  test.each([
    ["a shell variable", "$ROOT/Users/testuser/notes.md"],
    ["a variable ending in a digit", "$DIR2/Users/testuser/notes.md"],
    ["a variable ending in an underscore", "$ROOT_/Users/testuser/notes.md"],
  ])("does not match after %s", (_name, input) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: input, replacements: 0 });
  });

  test.each([
    ["JSON output", '{"ok":true}/Users/testuser/proj', '{"ok":true}/home/tester/proj'],
    ["a closing paren", "(done)/Users/testuser/proj", "(done)/home/tester/proj"],
    ["a closing bracket", "[1/3]/Users/testuser/proj", "[1/3]/home/tester/proj"],
    // Accepted cost of the rule above: these cannot be told apart from output run together.
    ["a braced variable", "${ROOT}/Users/testuser/notes.md", "${ROOT}/home/tester/notes.md"],
    ["a command substitution", "$(pwd)/Users/testuser/notes.md", "$(pwd)/home/tester/notes.md"],
  ])("matches straight after %s", (_name, input, expected) => {
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: expected, replacements: 1 });
  });

  test("still matches a variable assignment and a path inside a substitution", () => {
    expect(toLinux("ROOT=/Users/testuser; ls $ROOT")).toBe("ROOT=/home/tester; ls $ROOT");
    expect(toLinux("$(cat /Users/testuser/a.txt)")).toBe("$(cat /home/tester/a.txt)");
  });
});

describe("rewriteString: several paths in one string", () => {
  test("rewrites every occurrence and counts each one", () => {
    expect(rewriteString("diff /Users/testuser/a.ts /Users/testuser/b.ts", MAC_TO_LINUX)).toEqual({
      value: "diff /home/tester/a.ts /home/tester/b.ts",
      replacements: 2,
    });
  });

  test("counts a repeated path once per occurrence", () => {
    const input = "/Users/testuser /Users/testuser /Users/testuser";
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: "/home/tester /home/tester /home/tester", replacements: 3 });
  });

  test("rewrites the matches and leaves the near-misses in the same string", () => {
    const input = [
      '1\timport { old } from "/Users/testuser/proj/app/src/old.ts";',
      "2\t// backup lives in /Volumes/backup/Users/testuser/archive",
      "3\t// not ours: /Users/testuserx/other/file.ts",
    ].join("\n");
    const expected = [
      '1\timport { old } from "/home/tester/proj/app/src/old.ts";',
      "2\t// backup lives in /Volumes/backup/Users/testuser/archive",
      "3\t// not ours: /Users/testuserx/other/file.ts",
    ].join("\n");
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({ value: expected, replacements: 1 });
  });

  test("handles colon-separated lists", () => {
    expect(rewriteString("/Users/testuser/bin:/Users/testuserx/bin:/Users/testuser/.local/bin", MAC_TO_LINUX)).toEqual({
      value: "/home/tester/bin:/Users/testuserx/bin:/home/tester/.local/bin",
      replacements: 2,
    });
  });

  test("handles multi-line tool output", () => {
    const input = "/Users/testuser/proj/app/src/main.ts:12: error\n/Users/testuser/proj/app/src/old.ts:3: warning\n";
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({
      value: "/home/tester/proj/app/src/main.ts:12: error\n/home/tester/proj/app/src/old.ts:3: warning\n",
      replacements: 2,
    });
  });

  test("rewrites paths inside JSON text that is itself a string", () => {
    const input = '{"cwd":"/Users/testuser/proj","files":["/Users/testuser/proj/a.ts"]}';
    expect(rewriteString(input, MAC_TO_LINUX)).toEqual({
      value: '{"cwd":"/home/tester/proj","files":["/home/tester/proj/a.ts"]}',
      replacements: 2,
    });
  });
});

describe("rewriteString: several maps", () => {
  const two: PathMap[] = [
    { from: "/Users/testuser", to: "/home/tester" },
    { from: "/Volumes/work", to: "/mnt/work" },
  ];

  test("applies independent maps in one string", () => {
    expect(rewriteString("cp /Volumes/work/data.csv /Users/testuser/proj/", two)).toEqual({
      value: "cp /mnt/work/data.csv /home/tester/proj/",
      replacements: 2,
    });
  });

  const nested: PathMap[] = [
    { from: "/Users/testuser", to: "/home/tester" },
    { from: "/Users/testuser/Library/Caches", to: "/var/cache/tester" },
  ];

  test("the longest matching prefix wins", () => {
    expect(rewriteString("/Users/testuser/Library/Caches/pip", nested).value).toBe("/var/cache/tester/pip");
    expect(rewriteString("/Users/testuser/Library/Fonts", nested).value).toBe("/home/tester/Library/Fonts");
    expect(rewriteString("/Users/testuser/Library/Cachesx", nested).value).toBe("/home/tester/Library/Cachesx");
  });

  test("the order the maps are given in does not matter", () => {
    const reversed = [...nested].reverse();
    expect(rewriteString("/Users/testuser/Library/Caches/pip", reversed).value).toBe("/var/cache/tester/pip");
    expect(rewriteString("/Users/testuser/Library/Fonts", reversed).value).toBe("/home/tester/Library/Fonts");
  });

  test("the session folder map beats the home map, as the CLI relies on", () => {
    const maps: PathMap[] = [
      { from: "/Users/testuser", to: "/home/tester" },
      { from: "/Users/testuser/.claude/projects/-Users-testuser-proj-app", to: "/home/tester/.claude/projects/-home-tester-proj-app" },
    ];
    const input = `saved to: /Users/testuser/.claude/projects/-Users-testuser-proj-app/${SESSION_ID}/tool-results/b1.txt`;
    expect(rewriteString(input, maps)).toEqual({
      value: `saved to: /home/tester/.claude/projects/-home-tester-proj-app/${SESSION_ID}/tool-results/b1.txt`,
      replacements: 1,
    });
  });

  test("output is not rewritten again by another map", () => {
    const chain: PathMap[] = [
      { from: "/data/a", to: "/data/b" },
      { from: "/data/b", to: "/data/c" },
    ];
    expect(rewriteString("/data/a/x", chain)).toEqual({ value: "/data/b/x", replacements: 1 });
    expect(rewriteString("/data/b/x", chain)).toEqual({ value: "/data/c/x", replacements: 1 });
  });

  test("two maps can swap a pair of paths", () => {
    const swap: PathMap[] = [
      { from: "/data/a", to: "/data/b" },
      { from: "/data/b", to: "/data/a" },
    ];
    expect(rewriteString("/data/a/x /data/b/y", swap)).toEqual({ value: "/data/b/x /data/a/y", replacements: 2 });
  });

  test("a target that contains its own source is applied once", () => {
    const into: PathMap[] = [{ from: "/home/tester", to: "/home/tester/sandbox" }];
    expect(rewriteString("/home/tester/proj", into)).toEqual({ value: "/home/tester/sandbox/proj", replacements: 1 });
  });
});

describe("rewriteString: paths are literal text, not patterns", () => {
  test("a dot in the source prefix matches only a dot", () => {
    const maps: PathMap[] = [{ from: "/Users/test.user", to: "/home/tester" }];
    expect(rewriteString("/Users/test.user/proj", maps)).toEqual({ value: "/home/tester/proj", replacements: 1 });
    expect(rewriteString("/Users/testXuser/proj", maps)).toEqual({ value: "/Users/testXuser/proj", replacements: 0 });
  });

  test("other pattern characters in the source prefix are literal", () => {
    const maps: PathMap[] = [{ from: "/Users/testuser/c++ (old) [1]", to: "/home/tester/cpp" }];
    expect(rewriteString("open /Users/testuser/c++ (old) [1]/main.cc", maps)).toEqual({
      value: "open /home/tester/cpp/main.cc",
      replacements: 1,
    });
  });

  test("dollar sequences in the target are literal", () => {
    const maps: PathMap[] = [{ from: "/Users/testuser", to: "/srv/$&/$1/$$" }];
    expect(rewriteString("/Users/testuser/proj", maps).value).toBe("/srv/$&/$1/$$/proj");
  });

  test("a source prefix may contain spaces", () => {
    const maps: PathMap[] = [{ from: "/Users/testuser/My Projects", to: "/home/tester/projects" }];
    expect(rewriteString("cd '/Users/testuser/My Projects/app'", maps)).toEqual({
      value: "cd '/home/tester/projects/app'",
      replacements: 1,
    });
    expect(rewriteString("/Users/testuser/My Projectsx", maps).replacements).toBe(0);
  });

  test("non-ASCII path segments and surrounding text survive", () => {
    expect(toLinux("открой /Users/testuser/Документы/файл.txt 🙂")).toBe("открой /home/tester/Документы/файл.txt 🙂");
  });
});

describe("rewriteString: Linux to macOS", () => {
  test("maps the prefix and paths below it", () => {
    expect(rewriteString("/home/tester", LINUX_TO_MAC)).toEqual({ value: "/Users/testuser", replacements: 1 });
    expect(rewriteString("/home/tester/proj/app/src/main.ts", LINUX_TO_MAC)).toEqual({
      value: "/Users/testuser/proj/app/src/main.ts",
      replacements: 1,
    });
  });

  test.each([
    ["a longer name", "/home/testers/proj"],
    ["a digit suffix", "/home/tester2/proj"],
    ["a dash suffix", "/home/tester-old/proj"],
    ["a nested home", "/var/home/tester/proj"],
    ["a different user", "/home/someone/proj"],
  ])("does not match %s", (_name, input) => {
    expect(rewriteString(input, LINUX_TO_MAC)).toEqual({ value: input, replacements: 0 });
  });

  test("rewrites several paths in a shell command", () => {
    expect(rewriteString("cd /home/tester/proj && cat /home/tester/.config/app.toml /etc/hosts", LINUX_TO_MAC)).toEqual({
      value: "cd /Users/testuser/proj && cat /Users/testuser/.config/app.toml /etc/hosts",
      replacements: 2,
    });
  });

  test("a deeper map moves one folder and leaves the rest of home alone", () => {
    const maps: PathMap[] = [{ from: "/home/tester/work", to: "/Users/testuser/Developer" }];
    expect(rewriteString("/home/tester/work/app /home/tester/notes", maps)).toEqual({
      value: "/Users/testuser/Developer/app /home/tester/notes",
      replacements: 1,
    });
  });

  test("going there and back restores the original text", () => {
    const original = 'ls "/Users/testuser/proj" /Users/testuserx /Volumes/backup/Users/testuser\n/Users/testuser';
    expect(toMac(toLinux(original))).toBe(original);
  });
});

describe("rewriteValue", () => {
  test("rewrites a bare string", () => {
    expect(rewriteValue("/Users/testuser/proj", MAC_TO_LINUX)).toEqual({ value: "/home/tester/proj", replacements: 1 });
  });

  test("rewrites strings in nested objects", () => {
    const input = { message: { role: "user", meta: { cwd: "/Users/testuser/proj", deeper: { file: "/Users/testuser/proj/a.ts" } } } };
    expect(rewriteValue(input, MAC_TO_LINUX)).toEqual({
      value: { message: { role: "user", meta: { cwd: "/home/tester/proj", deeper: { file: "/home/tester/proj/a.ts" } } } },
      replacements: 2,
    });
  });

  test("rewrites strings in arrays, nested arrays and arrays of objects", () => {
    const input = {
      files: ["/Users/testuser/a.ts", "/Users/testuserx/b.ts", ["/Users/testuser/c.ts", ["/Users/testuser"]]],
      content: [
        { type: "text", text: "see /Users/testuser/a.ts" },
        { type: "tool_use", input: { file_path: "/Users/testuser/a.ts", limit: 50 } },
      ],
    };
    expect(rewriteValue(input, MAC_TO_LINUX)).toEqual({
      value: {
        files: ["/home/tester/a.ts", "/Users/testuserx/b.ts", ["/home/tester/c.ts", ["/home/tester"]]],
        content: [
          { type: "text", text: "see /home/tester/a.ts" },
          { type: "tool_use", input: { file_path: "/home/tester/a.ts", limit: 50 } },
        ],
      },
      replacements: 5,
    });
  });

  test("rewrites a top-level array", () => {
    expect(rewriteValue(["/Users/testuser", 1, null], MAC_TO_LINUX)).toEqual({ value: ["/home/tester", 1, null], replacements: 1 });
  });

  test("leaves numbers, booleans, null and empty containers as they are", () => {
    const input = { n: 0, neg: -1.5, big: 1e21, yes: true, no: false, nothing: null, empty: "", obj: {}, arr: [] };
    expect(rewriteValue(input, MAC_TO_LINUX)).toEqual({ value: input, replacements: 0 });
    expect(rewriteValue(null, MAC_TO_LINUX)).toEqual({ value: null, replacements: 0 });
    expect(rewriteValue(42, MAC_TO_LINUX)).toEqual({ value: 42, replacements: 0 });
  });

  test("leaves ordinary keys alone", () => {
    const input = { cwd: "/Users/testuser/proj", Users: 1, testuser: 2 };
    const result = rewriteValue(input, MAC_TO_LINUX);
    expect(Object.keys(result.value)).toEqual(["cwd", "Users", "testuser"]);
    expect(result.replacements).toBe(1);
  });

  test("keeps keys in their original order", () => {
    const input = { zeta: "/Users/testuser/z", alpha: 1, mid: { y: "/Users/testuser/y", b: 2, a: "x" } };
    const { value } = rewriteValue(input, MAC_TO_LINUX);
    expect(Object.keys(value)).toEqual(["zeta", "alpha", "mid"]);
    expect(Object.keys(value.mid)).toEqual(["y", "b", "a"]);
    expect(JSON.stringify(value)).toBe('{"zeta":"/home/tester/z","alpha":1,"mid":{"y":"/home/tester/y","b":2,"a":"x"}}');
  });

  test("does not mutate its input", () => {
    const input = { cwd: "/Users/testuser/proj", list: ["/Users/testuser/a.ts"], nested: { p: "/Users/testuser" } };
    const before = structuredClone(input);
    const { value } = rewriteValue(input, MAC_TO_LINUX);
    expect(input).toEqual(before);
    expect(value).not.toBe(input);
    expect(value.list).not.toBe(input.list);
    expect(value.nested).not.toBe(input.nested);
  });

  test("handles deep nesting", () => {
    let input: unknown = "/Users/testuser/leaf";
    let expected: unknown = "/home/tester/leaf";
    for (let i = 0; i < 200; i++) {
      input = i % 2 ? [input] : { child: input };
      expected = i % 2 ? [expected] : { child: expected };
    }
    expect(rewriteValue(input, MAC_TO_LINUX)).toEqual({ value: expected, replacements: 1 });
  });

  test("works Linux to macOS", () => {
    const input = { cwd: "/home/tester/proj", argv: ["/home/tester/.local/bin/tool", "--config", "/home/tester2/c.toml"] };
    expect(rewriteValue(input, LINUX_TO_MAC)).toEqual({
      value: { cwd: "/Users/testuser/proj", argv: ["/Users/testuser/.local/bin/tool", "--config", "/home/tester2/c.toml"] },
      replacements: 2,
    });
  });
});

describe("rewriteValue: keys that are absolute paths", () => {
  const rewrite = (input: Record<string, unknown> | unknown[], maps: PathMap[] = MAC_TO_LINUX) => rewriteValue(input, maps);

  test("rewrites a key that is a path below a mapped prefix, and counts it", () => {
    const input = { "/Users/testuser/proj/a.ts": { realParentDir: "/Users/testuser/proj" } };
    expect(rewrite(input)).toEqual({ value: { "/home/tester/proj/a.ts": { realParentDir: "/home/tester/proj" } }, replacements: 2 });
  });

  test("rewrites a key that is the prefix itself", () => {
    expect(rewrite({ "/Users/testuser": 1 })).toEqual({ value: { "/home/tester": 1 }, replacements: 1 });
  });

  test.each([
    ["a relative path", "src/main.ts"],
    ["a dot-relative path", "./Users/testuser/a.ts"],
    ["a longer name", "/Users/testuserx/a.ts"],
    ["a path outside every map", "/opt/tool/a.ts"],
    ["a path that only contains the prefix", "/Volumes/backup/Users/testuser/a.ts"],
    ["text that mentions a path", "see /Users/testuser/a.ts"],
  ])("leaves a key that is %s", (_name, key) => {
    expect(rewrite({ [key]: 1 })).toEqual({ value: { [key]: 1 }, replacements: 0 });
  });

  test("a rewritten key keeps its position", () => {
    const { value } = rewrite({ b: 1, "/Users/testuser/z.ts": 2, a: 3, "/Users/testuser/y.ts": 4 });
    expect(Object.keys(value)).toEqual(["b", "/home/tester/z.ts", "a", "/home/tester/y.ts"]);
  });

  test("rewrites keys at any depth, including inside arrays", () => {
    const input = { snapshot: { trackedFileBackups: { "/Users/testuser/a.ts": { v: 1 } } }, list: [{ "/Users/testuser/b.ts": true }] };
    expect(rewrite(input)).toEqual({
      value: { snapshot: { trackedFileBackups: { "/home/tester/a.ts": { v: 1 } } }, list: [{ "/home/tester/b.ts": true }] },
      replacements: 2,
    });
  });

  test("the longest matching prefix wins for keys too", () => {
    const maps: PathMap[] = [
      { from: "/Users/testuser", to: "/home/tester" },
      { from: "/Users/testuser/work", to: "/srv/work" },
    ];
    expect(rewrite({ "/Users/testuser/work/a.ts": 1, "/Users/testuser/b.ts": 2 }, maps).value).toEqual({ "/srv/work/a.ts": 1, "/home/tester/b.ts": 2 });
    expect(rewrite({ "/Users/testuser/work/a.ts": 1 }, [...maps].reverse()).value).toEqual({ "/srv/work/a.ts": 1 });
  });

  test("works Linux to macOS", () => {
    expect(rewrite({ "/home/tester/a.ts": 1, "/home/tester2/a.ts": 2 }, LINUX_TO_MAC)).toEqual({
      value: { "/Users/testuser/a.ts": 1, "/home/tester2/a.ts": 2 },
      replacements: 1,
    });
  });

  test("keeps a __proto__ key as ordinary data", () => {
    const input = JSON.parse('{"__proto__":{"cwd":"/Users/testuser"},"a":1}');
    const { value } = rewriteValue(input, MAC_TO_LINUX);
    expect(Object.keys(value)).toEqual(["__proto__", "a"]);
    expect(JSON.stringify(value)).toBe('{"__proto__":{"cwd":"/home/tester"},"a":1}');
  });

  test("does not mutate the input's keys", () => {
    const input = { "/Users/testuser/a.ts": { n: 1 } };
    rewrite(input);
    expect(Object.keys(input)).toEqual(["/Users/testuser/a.ts"]);
  });

  const collide = (input: Record<string, unknown>, maps: PathMap[]): unknown => {
    try {
      rewriteValue(input, maps);
    } catch (err) {
      return err;
    }
    return null;
  };

  test("fails loudly when two keys map to the same path", () => {
    const maps: PathMap[] = [
      { from: "/Users/testuser", to: "/srv/shared" },
      { from: "/Volumes/work", to: "/srv/shared" },
    ];
    const err = collide({ "/Users/testuser/a.ts": 1, "/Volumes/work/a.ts": 2 }, maps);
    expect(err).toBeInstanceOf(KeyCollisionError);
    const collision = err as KeyCollisionError;
    expect([...collision.keys].sort()).toEqual(["/Users/testuser/a.ts", "/Volumes/work/a.ts"]);
    expect(collision.target).toBe("/srv/shared/a.ts");
    expect(collision.message).toContain("/Users/testuser/a.ts");
    expect(collision.message).toContain("/Volumes/work/a.ts");
    expect(collision.message).toContain("/srv/shared/a.ts");
  });

  test("fails loudly when a rewritten key lands on a key that was already there", () => {
    const err = collide({ "/Users/testuser/a.ts": 1, "/home/tester/a.ts": 2 }, MAC_TO_LINUX);
    expect(err).toBeInstanceOf(KeyCollisionError);
    expect((err as KeyCollisionError).target).toBe("/home/tester/a.ts");
    // The order of the two keys in the object must not matter.
    expect(collide({ "/home/tester/a.ts": 2, "/Users/testuser/a.ts": 1 }, MAC_TO_LINUX)).toBeInstanceOf(KeyCollisionError);
  });

  test("fails for a collision at any depth", () => {
    const input = { snapshot: { trackedFileBackups: { "/Users/testuser/a.ts": 1, "/home/tester/a.ts": 2 } } };
    expect(collide(input, MAC_TO_LINUX)).toBeInstanceOf(KeyCollisionError);
  });

  test("equal keys in different objects are not a collision", () => {
    const input = [{ "/Users/testuser/a.ts": 1 }, { "/home/tester/a.ts": 2 }];
    expect(rewrite(input)).toEqual({ value: [{ "/home/tester/a.ts": 1 }, { "/home/tester/a.ts": 2 }], replacements: 1 });
  });
});

describe("rewriteJsonl", () => {
  const user = (cwd: string, text: string) => JSON.stringify({ type: "user", cwd, message: { role: "user", content: text } });

  test("rewrites each record and reports counts", () => {
    const text = [user("/Users/testuser/proj", "open /Users/testuser/proj/a.ts"), '{"type":"mode","mode":"default"}', ""].join("\n");
    const result = rewriteJsonl(text, MAC_TO_LINUX);
    expect(result.text).toBe([user("/home/tester/proj", "open /home/tester/proj/a.ts"), '{"type":"mode","mode":"default"}', ""].join("\n"));
    expect(result).toMatchObject({ records: 2, rewritten: 1, replacements: 2, unparsed: 0 });
  });

  test("keeps records in order", () => {
    const lines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ type: "user", seq: i, cwd: i % 3 ? "/Users/testuser/p" : "/opt/p" }));
    const result = rewriteJsonl(lines.join("\n") + "\n", MAC_TO_LINUX);
    const records = parseJsonl(result.text);
    expect(records.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(records.map((r) => r.cwd)).toEqual(Array.from({ length: 25 }, (_, i) => (i % 3 ? "/home/tester/p" : "/opt/p")));
    expect(result).toMatchObject({ records: 25, rewritten: 16, replacements: 16 });
  });

  test("a record with nothing to rewrite comes out byte-for-byte", () => {
    const odd = '{"type":"cost-state","totalCostUSD":1.50, "big" : 12345678901234567890 ,"esc":"caf\\u00e9 \\/ ok","sp" :  [ 1,2 ]}';
    const result = rewriteJsonl(`${odd}\n`, MAC_TO_LINUX);
    expect(result.text).toBe(`${odd}\n`);
    expect(result).toMatchObject({ records: 1, rewritten: 0, replacements: 0 });
  });

  test("a rewritten record stays on one line, valid JSON, with every field in order", () => {
    const record = {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: 'cd "/Users/testuser/proj" &&\n\tls -la' } }] },
      uuid: "a-1",
      cwd: "/Users/testuser/proj",
      count: 3,
      flag: true,
      nothing: null,
    };
    const result = rewriteJsonl(JSON.stringify(record) + "\n", MAC_TO_LINUX);
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
    const out = JSON.parse(lines[0]!);
    expect(Object.keys(out)).toEqual(Object.keys(record));
    expect(out).toEqual({
      ...record,
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: 'cd "/home/tester/proj" &&\n\tls -la' } }] },
      cwd: "/home/tester/proj",
    });
  });

  test("keeps a trailing newline when there is one", () => {
    expect(rewriteJsonl('{"cwd":"/Users/testuser"}\n', MAC_TO_LINUX).text).toBe('{"cwd":"/home/tester"}\n');
  });

  test("does not add a trailing newline when there is none", () => {
    expect(rewriteJsonl('{"cwd":"/Users/testuser"}', MAC_TO_LINUX).text).toBe('{"cwd":"/home/tester"}');
  });

  test("handles empty input", () => {
    expect(rewriteJsonl("", MAC_TO_LINUX)).toEqual({ text: "", records: 0, rewritten: 0, replacements: 0, unparsed: 0 });
  });

  test("keeps blank lines where they are and does not count them", () => {
    const text = '{"cwd":"/Users/testuser"}\n\n{"cwd":"/Users/testuser/x"}\n';
    const result = rewriteJsonl(text, MAC_TO_LINUX);
    expect(result.text).toBe('{"cwd":"/home/tester"}\n\n{"cwd":"/home/tester/x"}\n');
    expect(result).toMatchObject({ records: 2, rewritten: 2, unparsed: 0 });
  });

  test("passes a line that is not JSON through untouched, even if it contains a mapped path", () => {
    const broken = '{"type":"user","cwd":"/Users/testuser/proj","message":{"content":"cut off mid-wri';
    const text = `{"cwd":"/Users/testuser"}\n${broken}\n`;
    const result = rewriteJsonl(text, MAC_TO_LINUX);
    expect(result.text).toBe(`{"cwd":"/home/tester"}\n${broken}\n`);
    expect(result).toMatchObject({ records: 1, rewritten: 1, replacements: 1, unparsed: 1 });
  });

  test("works on parsed values, so JSON escapes do not hide a path", () => {
    const text = ['{"a":"\\/Users\\/testuser\\/proj"}', '{"b":"/\\u0055sers/testuser/proj"}', ""].join("\n");
    const result = rewriteJsonl(text, MAC_TO_LINUX);
    expect(parseJsonl(result.text)).toEqual([{ a: "/home/tester/proj" }, { b: "/home/tester/proj" }]);
    expect(result).toMatchObject({ records: 2, rewritten: 2, replacements: 2 });
  });

  test("rewrites absolute-path keys and leaves relative ones", () => {
    const text =
      '{"trackedFileBackups":{"/Users/testuser/proj/a.ts":{"realParentDir":"/Users/testuser/proj"},"src/b.ts":{"realParentDir":"/Users/testuser/proj/src"}}}\n';
    const result = rewriteJsonl(text, MAC_TO_LINUX);
    const [record] = parseJsonl(result.text);
    expect(record).toEqual({
      trackedFileBackups: {
        "/home/tester/proj/a.ts": { realParentDir: "/home/tester/proj" },
        "src/b.ts": { realParentDir: "/home/tester/proj/src" },
      },
    });
    expect(Object.keys(record.trackedFileBackups)).toEqual(["/home/tester/proj/a.ts", "src/b.ts"]);
    expect(result).toMatchObject({ records: 1, rewritten: 1, replacements: 3 });
  });

  test("a record whose only change is a key counts as rewritten", () => {
    const result = rewriteJsonl('{"files":{"/Users/testuser/a.ts":1}}\n{"files":{"src/a.ts":1}}\n', MAC_TO_LINUX);
    expect(result.text).toBe('{"files":{"/home/tester/a.ts":1}}\n{"files":{"src/a.ts":1}}\n');
    expect(result).toMatchObject({ records: 2, rewritten: 1, replacements: 1 });
  });

  test("fails loudly on a key collision and says which line", () => {
    const text = '{"cwd":"/Users/testuser"}\n{"files":{"/Users/testuser/a.ts":1,"/home/tester/a.ts":2}}\n';
    let err: unknown = null;
    try {
      rewriteJsonl(text, MAC_TO_LINUX);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(KeyCollisionError);
    const collision = err as KeyCollisionError;
    expect(collision.line).toBe(2);
    expect(collision.target).toBe("/home/tester/a.ts");
    expect(collision.message).toContain("line 2");
  });

  test("escapes special characters again when writing a record back", () => {
    const record = { cwd: "/Users/testuser", text: 'quote " backslash \\ newline \n tab \t nul \u0000 sep   é 🙂' };
    const result = rewriteJsonl(JSON.stringify(record) + "\n", MAC_TO_LINUX);
    expect(result.text.split("\n")).toHaveLength(2);
    expect(JSON.parse(result.text)).toEqual({ ...record, cwd: "/home/tester" });
  });

  test("rewrites record types it has never heard of and keeps all their fields", () => {
    const record = { type: "future-record-type", payload: { deep: [{ where: "/Users/testuser/proj", depth: [1, [2, ["/Users/testuser"]]] }], flag: true, nothing: null, count: 3 } };
    const result = rewriteJsonl(JSON.stringify(record) + "\n", MAC_TO_LINUX);
    expect(parseJsonl(result.text)).toEqual([
      { type: "future-record-type", payload: { deep: [{ where: "/home/tester/proj", depth: [1, [2, ["/home/tester"]]] }], flag: true, nothing: null, count: 3 } },
    ]);
    expect(result).toMatchObject({ rewritten: 1, replacements: 2 });
  });

  test("works Linux to macOS", () => {
    const text = [user("/home/tester/proj", "see /home/tester/proj/a.ts and /home/tester2/b.ts"), ""].join("\n");
    const result = rewriteJsonl(text, LINUX_TO_MAC);
    expect(result.text).toBe([user("/Users/testuser/proj", "see /Users/testuser/proj/a.ts and /home/tester2/b.ts"), ""].join("\n"));
    expect(result).toMatchObject({ records: 1, rewritten: 1, replacements: 2 });
  });
});

describe("fields the caller asks to keep", () => {
  const keepBody = (_holder: object, key: string) => key === "body";

  test("rewriteValue passes a kept property through untouched and rewrites its siblings", () => {
    const input = { path: "/Users/testuser/a.txt", body: "see /Users/testuser/b.txt", note: "in /Users/testuser" };
    expect(rewriteValue(input, MAC_TO_LINUX, keepBody)).toEqual({
      value: { path: "/home/tester/a.txt", body: "see /Users/testuser/b.txt", note: "in /home/tester" },
      replacements: 2,
    });
  });

  test("a kept property is not looked into, whatever it holds", () => {
    const body = { lines: ["/Users/testuser/a"], "/Users/testuser/key": { deep: "/Users/testuser/b" } };
    const input = { body, list: [{ body: "/Users/testuser/c", path: "/Users/testuser/d" }] };
    const result = rewriteValue(input, MAC_TO_LINUX, keepBody);
    expect(result.value.body).toBe(body);
    expect(result).toEqual({ value: { body, list: [{ body: "/Users/testuser/c", path: "/home/tester/d" }] }, replacements: 1 });
  });

  test("the decision is made per object, so the same key can be kept in one place and rewritten in another", () => {
    const special = { body: "/Users/testuser/keep" };
    const input = { first: special, second: { body: "/Users/testuser/rewrite" } };
    const result = rewriteValue(input, MAC_TO_LINUX, (holder, key) => holder === special && key === "body");
    expect(result.value).toEqual({ first: { body: "/Users/testuser/keep" }, second: { body: "/home/tester/rewrite" } });
  });

  test("without a keep function nothing is kept", () => {
    expect(rewriteValue({ body: "/Users/testuser/a" }, MAC_TO_LINUX).value).toEqual({ body: "/home/tester/a" });
  });

  test("rewriteJsonl asks once per record and keeps what it is told to", () => {
    const text = '{"path":"/Users/testuser/a","body":"/Users/testuser/b"}\n{"body":"/Users/testuser/c"}\n{"path":"/Users/testuser/d"}\n';
    const seen: unknown[] = [];
    const result = rewriteJsonl(text, MAC_TO_LINUX, (record) => {
      seen.push(record);
      return keepBody;
    });
    expect(seen).toHaveLength(3);
    expect(result.text).toBe('{"path":"/home/tester/a","body":"/Users/testuser/b"}\n{"body":"/Users/testuser/c"}\n{"path":"/home/tester/d"}\n');
    expect(result).toMatchObject({ records: 3, rewritten: 2, replacements: 2 });
  });

  test("a record whose only paths are in kept fields comes out byte-for-byte and is not counted", () => {
    const line = '{"body" : "/Users/testuser/c", "n":1.50}';
    const result = rewriteJsonl(`${line}\n`, MAC_TO_LINUX, () => keepBody);
    expect(result.text).toBe(`${line}\n`);
    expect(result).toMatchObject({ records: 1, rewritten: 0, replacements: 0 });
  });

  test("a record may keep nothing", () => {
    const result = rewriteJsonl('{"body":"/Users/testuser/c"}\n', MAC_TO_LINUX, () => undefined);
    expect(result.text).toBe('{"body":"/home/tester/c"}\n');
  });
});

describe("rewriteJsonl on the fixture session", () => {
  const load = () => Bun.file(join(FIXTURE, "main.jsonl")).text();

  test("counts records, rewritten records and replaced paths", async () => {
    const result = rewriteJsonl(await load(), MAC_TO_LINUX);
    expect(result).toMatchObject({ records: 11, rewritten: 8, replacements: 19, unparsed: 0 });
  });

  test("keeps record order and every field name", async () => {
    const original = await load();
    const before = parseJsonl(original);
    const after = parseJsonl(rewriteJsonl(original, MAC_TO_LINUX).text);
    expect(after.map((r) => r.type)).toEqual(before.map((r) => r.type));
    expect(after.map((r) => Object.keys(r))).toEqual(before.map((r) => Object.keys(r)));
  });

  test("maps every cwd", async () => {
    const after = parseJsonl(rewriteJsonl(await load(), MAC_TO_LINUX).text);
    expect(after.filter((r) => r.cwd).map((r) => r.cwd)).toEqual([
      "/home/tester/proj/app",
      "/home/tester/proj/app",
      "/home/tester/proj/app",
      "/home/tester/proj/app",
      "/home/tester/proj/app/src",
    ]);
  });

  test("maps tool inputs, tool outputs and checkpoint keys, leaving near-misses", async () => {
    const after = parseJsonl(rewriteJsonl(await load(), MAC_TO_LINUX).text);
    expect(after[1].message.content).toBe("Fix the bug in /home/tester/proj/app/src/main.ts and compare it with /home/tester/proj/app/src/old.ts");
    expect(after[2].message.content[1].input).toEqual({ file_path: "/home/tester/proj/app/src/main.ts", limit: 50 });
    expect(after[3].message.content[0].content).toBe(
      '1\timport { old } from "/home/tester/proj/app/src/old.ts";\n2\t// backup lives in /Volumes/backup/Users/testuser/archive\n3\t// not ours: /Users/testuserx/other/file.ts',
    );
    expect(after[3].toolUseResult.file.filePath).toBe("/home/tester/proj/app/src/main.ts");
    expect(after[4].message.content[0].input.command).toBe("cd /home/tester/proj/app && ls -la src");
    expect(after[7].snapshot.trackedFileBackups).toEqual({
      "/home/tester/proj/app/src/main.ts": {
        backupFileName: "abc123@v1",
        version: 1,
        backupTime: "2026-01-05T10:00:07.000Z",
        realParentDir: "/home/tester/proj/app/src",
      },
    });
    expect(after[8].payload.deep).toEqual([{ where: "/home/tester/proj/app", depth: [1, [2, ["/home/tester"]]] }]);
  });

  test("records without paths are byte-identical", async () => {
    const original = await load();
    const before = original.split("\n");
    const after = rewriteJsonl(original, MAC_TO_LINUX).text.split("\n");
    expect(after).toHaveLength(before.length);
    for (const index of [0, 6, 9]) expect(after[index]).toBe(before[index]!);
  });

  test("with the session folder map, saved tool results point into the new folder", async () => {
    const maps: PathMap[] = [
      ...MAC_TO_LINUX,
      { from: "/Users/testuser/.claude/projects/-Users-testuser-proj-app", to: "/home/tester/.claude/projects/-home-tester-proj-app" },
    ];
    const result = rewriteJsonl(await load(), maps);
    const expected = `/home/tester/.claude/projects/-home-tester-proj-app/${SESSION_ID}/tool-results/b1.txt`;
    const record = parseJsonl(result.text)[5];
    expect(record.toolUseResult.persistedOutputPath).toBe(expected);
    expect(record.message.content[0].content).toBe(`Output too large (48.2KB). Full output saved to: ${expected}`);
    expect(result.replacements).toBe(19);
  });

  test("going there and back restores every record", async () => {
    const original = await load();
    const there = rewriteJsonl(original, MAC_TO_LINUX).text;
    const back = rewriteJsonl(there, LINUX_TO_MAC).text;
    expect(parseJsonl(back)).toEqual(parseJsonl(original));
  });
});
