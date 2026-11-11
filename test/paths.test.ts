import { describe, expect, test } from "bun:test";
import { mapPath, parseMapArg, shellQuote, shellQuoteStrict } from "../src/paths.ts";

describe("parseMapArg", () => {
  test("splits on the first equals sign", () => {
    expect(parseMapArg("/Users/testuser=/home/tester")).toEqual({ from: "/Users/testuser", to: "/home/tester" });
  });

  test("drops trailing slashes", () => {
    expect(parseMapArg("/Users/testuser/=/home/tester//")).toEqual({ from: "/Users/testuser", to: "/home/tester" });
  });

  test("rejects malformed maps", () => {
    expect(() => parseMapArg("/Users/testuser")).toThrow(/expected/);
    expect(() => parseMapArg("Users/testuser=/home/tester")).toThrow(/absolute/);
    expect(() => parseMapArg("/Users/testuser=home/tester")).toThrow(/absolute/);
    expect(() => parseMapArg("/=/home/tester")).toThrow(/root/);
  });
});

describe("mapPath", () => {
  const maps = [{ from: "/Users/testuser", to: "/home/tester" }];

  test("maps the prefix itself and anything below it", () => {
    expect(mapPath("/Users/testuser", maps)).toBe("/home/tester");
    expect(mapPath("/Users/testuser/proj/app", maps)).toBe("/home/tester/proj/app");
  });

  test("leaves sibling names and unrelated paths alone", () => {
    expect(mapPath("/Users/testuserx/proj", maps)).toBe("/Users/testuserx/proj");
    expect(mapPath("/opt/tools", maps)).toBe("/opt/tools");
  });

  test("longest prefix wins regardless of order", () => {
    const two = [
      { from: "/Users/testuser", to: "/home/tester" },
      { from: "/Users/testuser/work", to: "/srv/work" },
    ];
    expect(mapPath("/Users/testuser/work/app", two)).toBe("/srv/work/app");
    expect(mapPath("/Users/testuser/work/app", [...two].reverse())).toBe("/srv/work/app");
    expect(mapPath("/Users/testuser/other", two)).toBe("/home/tester/other");
  });
});

describe("shellQuote", () => {
  test("leaves plain words bare and quotes the rest", () => {
    expect(shellQuote("/home/tester/proj")).toBe("/home/tester/proj");
    expect(shellQuote("/home/tester/my proj")).toBe("'/home/tester/my proj'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuoteStrict("plain")).toBe("'plain'");
  });
});
