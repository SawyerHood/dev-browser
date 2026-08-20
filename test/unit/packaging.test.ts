/**
 * npm packaging: scripts/download-binary.cjs (download + checksum + mirror +
 * relinkGlobal gating), the bin/doobie.cjs shim's self-heal path, postinstall
 * messages, and the published file list.
 */
import { test as bunTest, expect, describe, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { startServer, type FixtureServer } from "../helpers/server.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
// The shim and postinstall are Node scripts (npm runs them); skip those tests where node/npm are absent
// (e.g. a dev Mac with only bun). CI has both.
const HAS_NODE = !!Bun.which("node");
const HAS_NPM = !!Bun.which("npm");
const test = Object.assign((name: string, fn: () => void | Promise<unknown>, t?: number) => bunTest.skipIf(!HAS_NODE || !HAS_NPM)(name, fn, t), bunTest);
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dl = require(path.join(ROOT, "scripts/download-binary.cjs")) as {
  VERSION: string;
  REPO: string;
  binPath: string;
  shimPath: string;
  devEntry: string;
  defaultBase(): string;
  downloadBase(): string;
  platformAsset(): { asset?: string; error?: string };
  findChecksum(sums: string, asset: string): string | null;
  downloadBinary(opts?: { base?: string; dest?: string; log?: (m: string) => void }): Promise<{ dest: string }>;
  relinkGlobal(opts?: {
    env?: Record<string, string | undefined>;
    prefix?: string;
    dest?: string;
    shim?: string;
    log?: (m: string) => void;
  }): boolean;
  manualHint(): string;
};

const sha256 = (b: Buffer | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const ASSET = dl.platformAsset().asset!;
/** The published package has no src/, so messages must not promise a bun/TypeScript fallback. */
const NO_BUN_FALLBACK = /fall ?back to bun|TypeScript entry|runs? .*with bun|DOOBIE_SKIP_DOWNLOAD=1 npm rebuild/i;
const FAKE_BIN = Buffer.from(`#!/bin/sh\necho "fake-doobie $*"\nexit 0\n`);
const tmpDirs: string[] = [];
function tmp(prefix = "doobie-pkg-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

let srv: FixtureServer;
let goodBase: string;
let badSumBase: string;
beforeAll(async () => {
  srv = await startServer({
    // good release: asset + matching sums (sha256sum-style, with a second unrelated line)
    [`/good/${ASSET}`]: () => new Response(FAKE_BIN, { headers: { "content-type": "application/octet-stream" } }),
    "/good/SHA256SUMS": () => `${sha256("other")}  doobie-other-thing\n${sha256(FAKE_BIN)}  ${ASSET}\n`,
    // bad release: sums do not match the asset
    [`/bad/${ASSET}`]: () => new Response(FAKE_BIN),
    "/bad/SHA256SUMS": () => `${"0".repeat(64)}  ${ASSET}\n`,
    // sums without an entry for our asset
    [`/nosum/${ASSET}`]: () => new Response(FAKE_BIN),
    "/nosum/SHA256SUMS": () => `${sha256(FAKE_BIN)}  doobie-plan9-mips\n`,
    // redirecting release (GitHub redirects release assets to a CDN)
    [`/redir/${ASSET}`]: () => Response.redirect(`http://127.0.0.1:${srv.port}/good/${ASSET}`, 302),
    "/redir/SHA256SUMS": () => Response.redirect(`http://127.0.0.1:${srv.port}/good/SHA256SUMS`, 302),
  });
  goodBase = srv.url("/good");
  badSumBase = srv.url("/bad");
});
afterAll(async () => {
  await srv.stop();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("download-binary module", () => {
  test("platformAsset names a supported asset on this CI platform", () => {
    expect(ASSET).toMatch(/^doobie-(linux|darwin)-(x64|arm64)$/);
  });

  test("default base is the GitHub release URL for package.json version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(dl.VERSION).toBe(pkg.version);
    expect(dl.defaultBase()).toBe(`https://github.com/${dl.REPO}/releases/download/v${pkg.version}`);
  });

  test("DOOBIE_DOWNLOAD_BASE overrides the base (trailing slash stripped)", () => {
    const prev = process.env.DOOBIE_DOWNLOAD_BASE;
    try {
      process.env.DOOBIE_DOWNLOAD_BASE = "http://mirror.example/doobie/v1/";
      expect(dl.downloadBase()).toBe("http://mirror.example/doobie/v1");
      delete process.env.DOOBIE_DOWNLOAD_BASE;
      expect(dl.downloadBase()).toBe(dl.defaultBase());
    } finally {
      if (prev === undefined) delete process.env.DOOBIE_DOWNLOAD_BASE;
      else process.env.DOOBIE_DOWNLOAD_BASE = prev;
    }
  });

  test("findChecksum accepts text and binary (*) sha256sum lines", () => {
    const h = "a".repeat(64);
    expect(dl.findChecksum(`${h}  ${ASSET}\n`, ASSET)).toBe(h);
    expect(dl.findChecksum(`${h} *${ASSET}\r\n`, ASSET)).toBe(h);
    expect(dl.findChecksum(`${h}  ${ASSET}.sig\n`, ASSET)).toBeNull();
    expect(dl.findChecksum("", ASSET)).toBeNull();
  });

  test("downloads, verifies and installs the binary (mode 755, atomic)", async () => {
    const dest = path.join(tmp(), "bin", "doobie-bin");
    const logs: string[] = [];
    const r = await dl.downloadBinary({ base: goodBase, dest, log: (m) => logs.push(m) });
    expect(r.dest).toBe(dest);
    expect(fs.readFileSync(dest)).toEqual(FAKE_BIN);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["doobie-bin"]); // no leftover .tmp
    expect(logs.join("\n")).toContain(`downloading ${ASSET} v${dl.VERSION} from ${goodBase}`);
  });

  test("follows redirects", async () => {
    const dest = path.join(tmp(), "doobie-bin");
    await dl.downloadBinary({ base: srv.url("/redir"), dest });
    expect(fs.readFileSync(dest)).toEqual(FAKE_BIN);
  });

  test("refuses a checksum mismatch and leaves nothing behind", async () => {
    const dir = tmp();
    const dest = path.join(dir, "doobie-bin");
    await expect(dl.downloadBinary({ base: badSumBase, dest })).rejects.toThrow(/checksum mismatch/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("refuses when SHA256SUMS has no entry for the asset", async () => {
    const dest = path.join(tmp(), "doobie-bin");
    await expect(dl.downloadBinary({ base: srv.url("/nosum"), dest })).rejects.toThrow(/no entry/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test("404 and connection errors reject with a useful message", async () => {
    const dest = path.join(tmp(), "doobie-bin");
    await expect(dl.downloadBinary({ base: srv.url("/missing"), dest })).rejects.toThrow(/HTTP 404/);
    await expect(dl.downloadBinary({ base: "http://127.0.0.1:1/nothing", dest })).rejects.toThrow(/ECONNREFUSED|connect/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test("DOOBIE_DOWNLOAD_BASE env drives downloadBinary when no base is given", async () => {
    const prev = process.env.DOOBIE_DOWNLOAD_BASE;
    const dest = path.join(tmp(), "doobie-bin");
    try {
      process.env.DOOBIE_DOWNLOAD_BASE = goodBase + "/";
      await dl.downloadBinary({ dest });
      expect(fs.readFileSync(dest)).toEqual(FAKE_BIN);
    } finally {
      if (prev === undefined) delete process.env.DOOBIE_DOWNLOAD_BASE;
      else process.env.DOOBIE_DOWNLOAD_BASE = prev;
    }
  });
});

describe("relinkGlobal", () => {
  /** prefix/bin/doobie -> prefix/lib/node_modules/doobie/bin/doobie.cjs (npm's global layout). */
  function fakeGlobal() {
    const prefix = tmp("doobie-prefix-");
    const pkgBin = path.join(prefix, "lib", "node_modules", "doobie", "bin");
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.mkdirSync(path.join(prefix, "bin"));
    const shim = path.join(pkgBin, "doobie.cjs");
    fs.writeFileSync(shim, "// shim\n");
    const dest = path.join(pkgBin, "doobie-bin");
    fs.writeFileSync(dest, FAKE_BIN, { mode: 0o755 });
    const link = path.join(prefix, "bin", "doobie");
    fs.symlinkSync(path.relative(path.dirname(link), shim), link);
    return { prefix, shim, dest, link };
  }

  test("does nothing for a project-local install (npm_config_global unset)", () => {
    const g = fakeGlobal();
    // npm sets npm_config_prefix to the *global* prefix even for local installs.
    const env = { npm_config_prefix: g.prefix };
    expect(dl.relinkGlobal({ env, dest: g.dest, shim: g.shim })).toBe(false);
    expect(fs.realpathSync(g.link)).toBe(fs.realpathSync(g.shim));
    expect(dl.relinkGlobal({ env: { ...env, npm_config_global: "false" }, dest: g.dest, shim: g.shim })).toBe(false);
    expect(fs.realpathSync(g.link)).toBe(fs.realpathSync(g.shim));
  });

  test("relinks for a global install whose link points at this package", () => {
    const g = fakeGlobal();
    const logs: string[] = [];
    const env = { npm_config_global: "true", npm_config_prefix: g.prefix };
    expect(dl.relinkGlobal({ env, dest: g.dest, shim: g.shim, log: (m) => logs.push(m) })).toBe(true);
    expect(fs.lstatSync(g.link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(g.link)).toBe(g.dest);
    expect(logs[0]).toContain("points directly at the binary");
  });

  test("does not hijack a global link that points at a different doobie package", () => {
    const g = fakeGlobal();
    // "this" package lives elsewhere (e.g. a project's node_modules) but the env says global.
    const other = tmp("doobie-other-");
    fs.mkdirSync(path.join(other, "bin"));
    const otherShim = path.join(other, "bin", "doobie.cjs");
    fs.writeFileSync(otherShim, "// other shim\n");
    const otherDest = path.join(other, "bin", "doobie-bin");
    fs.writeFileSync(otherDest, FAKE_BIN);
    const env = { npm_config_global: "true", npm_config_prefix: g.prefix };
    expect(dl.relinkGlobal({ env, dest: otherDest, shim: otherShim })).toBe(false);
    expect(fs.realpathSync(g.link)).toBe(fs.realpathSync(g.shim));
  });

  test("ignores a missing link or a non-symlink", () => {
    const g = fakeGlobal();
    fs.unlinkSync(g.link);
    const env = { npm_config_global: "true", npm_config_prefix: g.prefix };
    expect(dl.relinkGlobal({ env, dest: g.dest, shim: g.shim })).toBe(false);
    fs.writeFileSync(g.link, "#!/bin/sh\n");
    expect(dl.relinkGlobal({ env, dest: g.dest, shim: g.shim })).toBe(false);
    expect(fs.lstatSync(g.link).isSymbolicLink()).toBe(false);
  });
});

/** A published-package lookalike: shim + scripts + package.json, no src/, no binary. */
function fakePackage(): string {
  const dir = tmp("doobie-npmpkg-");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "bin/doobie.cjs"), path.join(dir, "bin/doobie.cjs"));
  fs.copyFileSync(path.join(ROOT, "scripts/postinstall.cjs"), path.join(dir, "scripts/postinstall.cjs"));
  fs.copyFileSync(path.join(ROOT, "scripts/download-binary.cjs"), path.join(dir, "scripts/download-binary.cjs"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  return dir;
}

async function runNode(
  script: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "HOME"]) if (process.env[k]) base[k] = process.env[k]!;
  const proc = Bun.spawn(["node", script, ...args], {
    cwd,
    env: { ...base, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("bin/doobie.cjs shim", () => {
  test("self-heals: downloads the binary on first run, then runs it; second run does not download", async () => {
    const pkg = fakePackage();
    const shim = path.join(pkg, "bin/doobie.cjs");
    const hitsBefore = srv.hits.length;
    const r1 = await runNode(shim, ["--version", "--x"], { DOOBIE_DOWNLOAD_BASE: goodBase }, pkg);
    expect(r1.stderr).toContain(`doobie: downloading binary v${dl.VERSION}...`);
    expect(r1.stdout.trim()).toBe("fake-doobie --version --x");
    expect(r1.code).toBe(0);
    expect(fs.existsSync(path.join(pkg, "bin/doobie-bin"))).toBe(true);
    expect(srv.hits.slice(hitsBefore)).toEqual(expect.arrayContaining([`GET /good/${ASSET}`, "GET /good/SHA256SUMS"]));
    const hitsMid = srv.hits.length;
    const r2 = await runNode(shim, ["pages"], { DOOBIE_DOWNLOAD_BASE: goodBase }, pkg);
    expect(r2.stderr).toBe("");
    expect(r2.stdout.trim()).toBe("fake-doobie pages");
    expect(srv.hits.length).toBe(hitsMid);
  });

  test("passes the binary's exit code through", async () => {
    const pkg = fakePackage();
    fs.writeFileSync(path.join(pkg, "bin/doobie-bin"), "#!/bin/sh\necho err >&2\nexit 124\n", { mode: 0o755 });
    const r = await runNode(path.join(pkg, "bin/doobie.cjs"), [], {}, pkg);
    expect(r.code).toBe(124);
    expect(r.stderr.trim()).toBe("err");
  });

  test("offline / unreachable mirror: clear error, exit 1, no bun advice", async () => {
    const pkg = fakePackage();
    const r = await runNode(path.join(pkg, "bin/doobie.cjs"), ["--version"], { DOOBIE_DOWNLOAD_BASE: "http://127.0.0.1:1/x" }, pkg);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("doobie: downloading binary");
    expect(r.stderr).toContain("could not download the binary");
    expect(r.stderr).toContain("npm rebuild -g doobie");
    expect(r.stderr).toContain("http://127.0.0.1:1/x");
    expect(r.stderr).not.toMatch(NO_BUN_FALLBACK);
    expect(fs.existsSync(path.join(pkg, "bin/doobie-bin"))).toBe(false);
  });

  test("checksum mismatch refuses the binary", async () => {
    const pkg = fakePackage();
    const r = await runNode(path.join(pkg, "bin/doobie.cjs"), ["--version"], { DOOBIE_DOWNLOAD_BASE: badSumBase }, pkg);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("checksum mismatch");
    expect(fs.existsSync(path.join(pkg, "bin/doobie-bin"))).toBe(false);
  });

  test("DOOBIE_SKIP_DOWNLOAD: does not download, explains how to fix", async () => {
    const pkg = fakePackage();
    const hits = srv.hits.length;
    const r = await runNode(path.join(pkg, "bin/doobie.cjs"), ["--version"], { DOOBIE_DOWNLOAD_BASE: goodBase, DOOBIE_SKIP_DOWNLOAD: "1" }, pkg);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DOOBIE_SKIP_DOWNLOAD is set");
    expect(r.stderr).toContain("npm rebuild -g doobie");
    expect(r.stderr).not.toMatch(NO_BUN_FALLBACK);
    expect(srv.hits.length).toBe(hits);
  });

  test("dev checkout: the real shim in this repo runs src/cli/main.ts with bun when no binary exists", async () => {
    // bin/doobie-bin is never present in the checkout; the shim must mention bun only here.
    expect(fs.existsSync(dl.devEntry)).toBe(true);
    if (fs.existsSync(dl.binPath)) return; // someone ran postinstall with a real binary; skip
    const r = await runNode(path.join(ROOT, "bin/doobie.cjs"), ["--version"], { PATH: process.env.PATH! }, ROOT);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`doobie ${dl.VERSION}`);
  });
});

describe("scripts/postinstall.cjs", () => {
  test("installs from DOOBIE_DOWNLOAD_BASE and does not touch a global link for a local install", async () => {
    const pkg = fakePackage();
    const prefix = tmp("doobie-prefix-");
    fs.mkdirSync(path.join(prefix, "bin"));
    const link = path.join(prefix, "bin", "doobie");
    fs.symlinkSync(path.join(pkg, "bin/doobie.cjs"), link);
    const r = await runNode(path.join(pkg, "scripts/postinstall.cjs"), [], { DOOBIE_DOWNLOAD_BASE: goodBase, npm_config_prefix: prefix }, pkg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("installed binary at");
    expect(fs.readFileSync(path.join(pkg, "bin/doobie-bin"))).toEqual(FAKE_BIN);
    expect(fs.readlinkSync(link)).toBe(path.join(pkg, "bin/doobie.cjs")); // untouched
    expect(r.stdout).not.toContain("points directly");
  });

  test("global install relinks the global `doobie` symlink at the binary", async () => {
    const pkg = fakePackage();
    const prefix = tmp("doobie-prefix-");
    fs.mkdirSync(path.join(prefix, "bin"));
    const link = path.join(prefix, "bin", "doobie");
    fs.symlinkSync(path.join(pkg, "bin/doobie.cjs"), link);
    const r = await runNode(
      path.join(pkg, "scripts/postinstall.cjs"),
      [],
      { DOOBIE_DOWNLOAD_BASE: goodBase, npm_config_prefix: prefix, npm_config_global: "true" },
      pkg,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("points directly at the binary");
    expect(fs.realpathSync(fs.readlinkSync(link))).toBe(fs.realpathSync(path.join(pkg, "bin/doobie-bin")));
  });

  test("download failure: exit 0, message recommends npm rebuild / manual download, never bun", async () => {
    const pkg = fakePackage();
    const r = await runNode(path.join(pkg, "scripts/postinstall.cjs"), [], { DOOBIE_DOWNLOAD_BASE: srv.url("/missing") }, pkg);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("could not download the binary (HTTP 404");
    expect(r.stderr).toContain("retry the download on first run");
    expect(r.stderr).toContain("npm rebuild -g doobie");
    expect(r.stderr).toContain(`${srv.url("/missing")} to `);
    expect(r.stderr).toContain("bin/doobie-bin");
    expect(r.stderr).not.toMatch(NO_BUN_FALLBACK);
  });

  test("DOOBIE_SKIP_DOWNLOAD skips; dev checkout (src/ present) is a no-op", async () => {
    const pkg = fakePackage();
    const r = await runNode(path.join(pkg, "scripts/postinstall.cjs"), [], { DOOBIE_SKIP_DOWNLOAD: "1", DOOBIE_DOWNLOAD_BASE: goodBase }, pkg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DOOBIE_SKIP_DOWNLOAD set");
    expect(fs.existsSync(path.join(pkg, "bin/doobie-bin"))).toBe(false);
    const r2 = await runNode(path.join(ROOT, "scripts/postinstall.cjs"), [], { DOOBIE_DOWNLOAD_BASE: "http://127.0.0.1:1/x" }, ROOT);
    expect(r2.code).toBe(0);
    expect(r2.stdout + r2.stderr).toBe("");
  });
});

describe("package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

  test("ships no runtime dependencies (the binary bundles everything)", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const d of ["puppeteer-core", "@puppeteer/browsers", "acorn", "yauzl"]) expect(pkg.devDependencies[d]).toBeDefined();
  });

  test("files whitelist is the shim, the install scripts and docs only", () => {
    expect(pkg.files).toEqual([
      "bin/doobie.cjs",
      "scripts/postinstall.cjs",
      "scripts/download-binary.cjs",
      "README.md",
      "LICENSE",
      "docs/help.md",
      "skills/",
    ]);
    expect(pkg.bin).toEqual({ doobie: "./bin/doobie.cjs" });
    expect(pkg.scripts.postinstall).toBe("node scripts/postinstall.cjs");
  });

  test("npm pack --dry-run lists exactly the published files", async () => {
    const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return; // npm not usable here; covered in release.yml
    const [info] = JSON.parse(out) as [{ files: { path: string }[] }];
    const files = info.files.map((f) => f.path).sort();
    expect(files).toEqual(
      [
        "LICENSE",
        "README.md",
        "bin/doobie.cjs",
        "docs/help.md",
        "package.json",
        "scripts/download-binary.cjs",
        "scripts/postinstall.cjs",
        "skills/doobie/SKILL.md",
      ].sort(),
    );
  });
});
