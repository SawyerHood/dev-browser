import { test, expect, describe } from "bun:test";
import { parseArgs, UsageError } from "../../src/cli/args.ts";

describe("parseArgs", () => {
  test("no args -> script from stdin, defaults", () => {
    const p = parseArgs([]);
    expect(p.command).toEqual({ kind: "script" });
    expect(p.flags).toEqual({ json: false, quietPage: false, noCap: false, help: false, version: false });
  });

  test("every global flag", () => {
    const p = parseArgs([
      "--browser", "work",
      "--headless",
      "--timeout", "12",
      "--json",
      "--idle-timeout", "5m",
      "--quiet-page",
      "--no-cap",
      "-e", "1+1",
    ]);
    expect(p.flags.browser).toBe("work");
    expect(p.flags.headless).toBe(true);
    expect(p.flags.timeout).toBe(12);
    expect(p.flags.json).toBe(true);
    expect(p.flags.idleTimeout).toBe("5m");
    expect(p.flags.quietPage).toBe(true);
    expect(p.flags.noCap).toBe(true);
    expect(p.flags.eval).toBe("1+1");
    expect(p.command).toEqual({ kind: "script" });
  });

  test("short flags", () => {
    const p = parseArgs(["-b", "x", "-t", "3", "-e", "code"]);
    expect(p.flags.browser).toBe("x");
    expect(p.flags.timeout).toBe(3);
    expect(p.flags.eval).toBe("code");
    expect(parseArgs(["-h"]).flags.help).toBe(true);
    expect(parseArgs(["-V"]).flags.version).toBe(true);
    expect(parseArgs(["--help"]).flags.help).toBe(true);
    expect(parseArgs(["--version"]).flags.version).toBe(true);
  });

  test("--headed overrides --headless", () => {
    expect(parseArgs(["--headless", "--headed"]).flags.headless).toBe(false);
  });

  test("--flag=value form", () => {
    const p = parseArgs(["--browser=work", "--timeout=7", "--idle-timeout=0", "--eval=2*2"]);
    expect(p.flags.browser).toBe("work");
    expect(p.flags.timeout).toBe(7);
    expect(p.flags.idleTimeout).toBe("0");
    expect(p.flags.eval).toBe("2*2");
  });

  test("--connect without value -> auto", () => {
    expect(parseArgs(["--connect"]).flags.connect).toBe("auto");
    expect(parseArgs(["-c"]).flags.connect).toBe("auto");
  });

  test("--connect with url / port / host:port / unix:", () => {
    expect(parseArgs(["--connect", "http://127.0.0.1:9222"]).flags.connect).toBe("http://127.0.0.1:9222");
    expect(parseArgs(["--connect", "ws://127.0.0.1:9222/devtools/browser/abc"]).flags.connect).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
    expect(parseArgs(["--connect", "9333"]).flags.connect).toBe("9333");
    expect(parseArgs(["--connect", "localhost:9222"]).flags.connect).toBe("localhost:9222");
    expect(parseArgs(["--connect", "unix:/tmp/x.sock"]).flags.connect).toBe("unix:/tmp/x.sock");
    expect(parseArgs(["--connect=auto"]).flags.connect).toBe("auto");
    expect(parseArgs(["--connect=9222"]).flags.connect).toBe("9222");
  });

  test("--connect before a subcommand does not eat the subcommand", () => {
    let p = parseArgs(["--connect", "pages"]);
    expect(p.flags.connect).toBe("auto");
    expect(p.command).toEqual({ kind: "pages" });
    p = parseArgs(["--connect", "run", "x.js"]);
    expect(p.flags.connect).toBe("auto");
    expect(p.command).toEqual({ kind: "script", file: "x.js" });
    p = parseArgs(["--connect", "-e", "1"]);
    expect(p.flags.connect).toBe("auto");
    expect(p.flags.eval).toBe("1");
    p = parseArgs(["--connect", "stop"]);
    expect(p.command).toEqual({ kind: "stop", name: undefined });
  });

  test("--connect with value before a subcommand", () => {
    const p = parseArgs(["--connect", "9222", "pages"]);
    expect(p.flags.connect).toBe("9222");
    expect(p.command).toEqual({ kind: "pages" });
  });

  test("run FILE", () => {
    expect(parseArgs(["run", "scripts/a.js"]).command).toEqual({ kind: "script", file: "scripts/a.js" });
    expect(parseArgs(["--headless", "run", "a.js", "--json"]).flags.json).toBe(true);
    expect(() => parseArgs(["run"])).toThrow(UsageError);
  });

  test("stop [NAME]", () => {
    expect(parseArgs(["stop"]).command).toEqual({ kind: "stop", name: undefined });
    expect(parseArgs(["stop", "work"]).command).toEqual({ kind: "stop", name: "work" });
    expect(parseArgs(["stop", "--json"]).command).toEqual({ kind: "stop", name: undefined });
    expect(parseArgs(["stop", "--json"]).flags.json).toBe(true);
  });

  test("simple subcommands", () => {
    expect(parseArgs(["pages"]).command).toEqual({ kind: "pages" });
    expect(parseArgs(["browsers"]).command).toEqual({ kind: "browsers" });
    expect(parseArgs(["status"]).command).toEqual({ kind: "status" });
    expect(parseArgs(["daemon"]).command).toEqual({ kind: "daemon" });
    expect(parseArgs(["migrate-from-doobie"]).command).toEqual({ kind: "migrate-from-doobie" });
    expect(parseArgs(["help"]).command).toEqual({ kind: "help", topic: undefined });
    expect(parseArgs(["help", "connect"]).command).toEqual({ kind: "help", topic: "connect" });
  });

  test("subcommands with passthrough args", () => {
    expect(parseArgs(["install"]).command).toEqual({ kind: "install", args: [] });
    expect(parseArgs(["install-skill", "--claude", "--codex"]).command).toEqual({
      kind: "install-skill",
      args: ["--claude", "--codex"],
    });
    expect(parseArgs(["chrome", "--profile", "p", "--port", "9222", "https://x.test"]).command).toEqual({
      kind: "chrome",
      args: ["--profile", "p", "--port", "9222", "https://x.test"],
    });
    // flags after the subcommand are passed through, not parsed globally
    const p = parseArgs(["chrome", "--json"]);
    expect(p.flags.json).toBe(false);
    expect(p.command).toEqual({ kind: "chrome", args: ["--json"] });
  });

  test("unknown flag -> UsageError", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["-x"])).toThrow(UsageError);
    expect(() => parseArgs(["--bogus=1"])).toThrow(UsageError);
  });

  test("unknown command -> UsageError", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("missing values -> UsageError", () => {
    expect(() => parseArgs(["--browser"])).toThrow(UsageError);
    expect(() => parseArgs(["--browser", "--json"])).toThrow(UsageError);
    expect(() => parseArgs(["-e"])).toThrow(UsageError);
    expect(() => parseArgs(["--timeout"])).toThrow(UsageError);
    expect(() => parseArgs(["--idle-timeout"])).toThrow(UsageError);
  });

  test("--timeout validation", () => {
    expect(() => parseArgs(["--timeout", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["--timeout", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--timeout", "-5"])).toThrow(UsageError);
    expect(parseArgs(["--timeout", "1.5"]).flags.timeout).toBe(1.5);
  });

  test("-e accepts code starting with a dash", () => {
    expect(parseArgs(["-e", "-1"]).flags.eval).toBe("-1");
    expect(parseArgs(["--eval=-1"]).flags.eval).toBe("-1");
    expect(() => parseArgs(["-e"])).toThrow(UsageError);
  });

  test("-- ends flag parsing", () => {
    const p = parseArgs(["install-skill", "--", "--claude"]);
    expect(p.command).toEqual({ kind: "install-skill", args: ["--", "--claude"] });
  });
});

describe("parseArgs: global flags after a subcommand", () => {
  test("status/pages/browsers/stop accept --json after the subcommand", () => {
    expect(parseArgs(["status", "--json"]).flags.json).toBe(true);
    expect(parseArgs(["pages", "--json", "--connect", "9222"]).flags).toMatchObject({ json: true, connect: "9222" });
    expect(parseArgs(["browsers", "--json"]).flags.json).toBe(true);
    expect(parseArgs(["stop", "work", "--json"]).command).toEqual({ kind: "stop", name: "work" });
  });

  test("stray positional after a simple subcommand is a usage error", () => {
    expect(() => parseArgs(["pages", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["stop", "a", "b"])).toThrow(UsageError);
    expect(() => parseArgs(["run", "a.js", "b.js"])).toThrow(UsageError);
  });
});
