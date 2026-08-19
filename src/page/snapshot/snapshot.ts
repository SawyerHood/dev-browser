/**
 * Host side of the snapshot: injects INPAGE_SCRIPT, recurses same-origin
 * iframes, renders, tracks diffs, resolves refs. See ./index.ts for the contract.
 */
import type { ElementHandle, Frame, Page } from "puppeteer-core";
import { DEFAULTS } from "../../shared/config.ts";
import type { SnapshotOptions, SnapshotState, TrackedSnapshot } from "./index.ts";
import { INPAGE_SCRIPT } from "./inpage.ts";

const STATE = new WeakMap<Page, SnapshotState>();

/** Max iframe nesting depth (main frame = 0). */
const MAX_FRAME_DEPTH = 3;

export function getSnapshotState(page: Page): SnapshotState {
  let s = STATE.get(page);
  if (!s) {
    s = { frames: new Map(), tracked: new Map() };
    STATE.set(page, s);
  }
  return s;
}

interface InPageResult {
  yaml: string;
  refs: number;
  truncated: boolean;
  droppedLines: number;
  iframes: Array<{ ref: string; line: number }>;
}

interface InPageOptions {
  scope?: string;
  interactive?: boolean;
  depth?: number;
  boxes?: boolean;
  maxChars?: number;
  refPrefix?: string;
}

/**
 * The in-page script lives in Puppeteer's isolated world ("utility world"),
 * not the page's main world: Puppeteer 25 runs custom query handlers
 * (`ref/e5`) there (ElementHandle methods are @bindIsolatedHandle), and the
 * isolated world persists per document exactly like the main world. This
 * also keeps `window.__doobie` invisible to page scripts.
 */
interface Realm {
  evaluate(expr: string): Promise<unknown>;
  evaluateHandle(expr: string): Promise<unknown>;
}
function homeRealm(frame: Frame): Realm {
  // @internal in the public types, stable in practice (used by Locator/QueryHandler internally).
  return (frame as unknown as { isolatedRealm(): Realm }).isolatedRealm();
}

/** One CDP round trip: install the in-page script if missing, then snapshot. */
async function evaluateSnapshot(frame: Frame, opts: InPageOptions): Promise<InPageResult> {
  const expr = `${INPAGE_SCRIPT};\nwindow.__doobie.snapshot(${JSON.stringify(opts)})`;
  return (await homeRealm(frame).evaluate(expr)) as InPageResult;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "about:" || u.protocol === "blob:") return null; // inherits
    if (u.protocol === "data:" || u.protocol === "javascript:") return "null";
    return u.origin;
  } catch {
    return "null";
  }
}

/** Same-origin check by URL (about:blank / srcdoc inherit the parent origin). */
function isSameOrigin(parent: Frame, child: Frame): boolean {
  const p = originOf(parent.url());
  const c = originOf(child.url());
  if (c === null) return true;
  if (p === null) return c !== "null";
  return p === c;
}

interface Ctx {
  frames: Map<string, Frame>;
  nextFrame: number;
  inPageOpts: InPageOptions;
  includeFrames: boolean;
  droppedLines: number;
  timings: number[];
}

/** Snapshot one frame and nest its same-origin iframes. Returns YAML lines (unindented). */
async function snapshotFrame(frame: Frame, refPrefix: string, scope: string | undefined, frameDepth: number, ctx: Ctx): Promise<string[]> {
  const t0 = performance.now();
  const res = await evaluateSnapshot(frame, { ...ctx.inPageOpts, refPrefix, scope });
  ctx.timings.push(performance.now() - t0);
  if (res.truncated) ctx.droppedLines += res.droppedLines;
  const lines = res.yaml ? res.yaml.split("\n") : [];
  if (!ctx.includeFrames || !res.iframes.length) return lines;

  // Process iframes in reverse so line indexes stay valid while inserting.
  const inserts: Array<{ line: number; suffix: string; child: string[] }> = [];
  for (const info of res.iframes) {
    const local = info.ref.replace(/^f\d+/, "");
    let handle: ElementHandle<Element> | null = null;
    let child: string[] = [];
    let suffix = "";
    try {
      const js = `window.__doobie ? window.__doobie.ref(${JSON.stringify(local)}) : null`;
      const h = (await homeRealm(frame).evaluateHandle(js)) as unknown as ElementHandle<HTMLIFrameElement>;
      const el = h.asElement();
      if (!el) {
        await h.dispose().catch(() => {});
        continue;
      }
      handle = el as ElementHandle<Element>;
      const contentFrame = await (el as ElementHandle<HTMLIFrameElement>).contentFrame();
      if (!contentFrame || !isSameOrigin(frame, contentFrame)) {
        suffix = " [cross-origin]";
      } else if (frameDepth >= MAX_FRAME_DEPTH) {
        suffix = "";
      } else {
        const key = `f${++ctx.nextFrame}`;
        ctx.frames.set(key, contentFrame);
        try {
          child = await snapshotFrame(contentFrame, key, undefined, frameDepth + 1, ctx);
        } catch {
          suffix = " [cross-origin]";
          ctx.frames.delete(key);
          child = [];
        }
      }
    } catch {
      suffix = " [cross-origin]";
    } finally {
      await handle?.dispose().catch(() => {});
    }
    inserts.push({ line: info.line, suffix, child });
  }
  for (let i = inserts.length - 1; i >= 0; i--) {
    const ins = inserts[i]!;
    const line = lines[ins.line];
    if (line === undefined) continue;
    const indent = /^\s*/.exec(line)![0] + "  ";
    let head = line.endsWith(":") ? line.slice(0, -1) : line;
    head += ins.suffix;
    if (ins.child.length) head += ":";
    lines.splice(ins.line, 1, head, ...ins.child.map((l) => indent + l));
  }
  return lines;
}

const TRUNCATE_HINT = "Narrow with snapshot({ scope: 'eN' }) or snapshot({ interactive: true }).";

function truncateText(text: string, maxChars: number, extraDropped: number): string {
  if (text.length <= maxChars) {
    if (extraDropped > 0) return `${text}\n# ... truncated at ${maxChars} chars (${extraDropped} more lines). ${TRUNCATE_HINT}`;
    return text;
  }
  let cut = text.lastIndexOf("\n", maxChars);
  if (cut <= 0) cut = maxChars;
  const head = text.slice(0, cut);
  const rest = text.slice(cut);
  let dropped = extraDropped;
  for (let i = 0; i < rest.length; i++) if (rest.charCodeAt(i) === 10) dropped++;
  return `${head}\n# ... truncated at ${maxChars} chars (${dropped} more lines). ${TRUNCATE_HINT}`;
}

/** Last measured per-frame in-page evaluate timings (ms); for benchmarks/tests. */
export const lastTimings: { frames: number[]; totalMs: number } = { frames: [], totalMs: 0 };

export async function snapshot(page: Page, opts: SnapshotOptions = {}): Promise<string | TrackedSnapshot> {
  const t0 = performance.now();
  const maxChars = opts.maxChars && opts.maxChars > 0 ? Math.floor(opts.maxChars) : DEFAULTS.snapshotMaxChars;
  const state = getSnapshotState(page);
  const ctx: Ctx = {
    frames: new Map(),
    nextFrame: 0,
    inPageOpts: { interactive: !!opts.interactive, depth: opts.depth, boxes: !!opts.boxes, maxChars },
    includeFrames: opts.frames !== false,
    droppedLines: 0,
    timings: [],
  };

  let lines: string[];
  const scopeFrame = opts.scope ? /^(f\d+)(e\d+)$/.exec(opts.scope) : null;
  if (scopeFrame) {
    // Scope inside a previously snapshotted iframe: keep the existing frame map and render that subtree.
    const key = scopeFrame[1]!;
    const frame = state.frames.get(key);
    if (!frame || frame.detached) throw new Error(`Frame ${key} from ref "${opts.scope}" is gone. Take a new page.snapshot().`);
    ctx.frames = state.frames;
    ctx.nextFrame = Math.max(0, ...[...state.frames.keys()].map((k) => Number(k.slice(1)) || 0));
    lines = await snapshotFrame(frame, key, scopeFrame[2], 1, ctx);
  } else {
    lines = await snapshotFrame(page.mainFrame(), "", opts.scope, 0, ctx);
    state.frames = ctx.frames;
  }

  const full = truncateText(lines.join("\n"), maxChars, ctx.droppedLines);
  lastTimings.frames = ctx.timings;
  lastTimings.totalMs = performance.now() - t0;

  if (typeof opts.track === "string") {
    const prev = state.tracked.get(opts.track);
    state.tracked.set(opts.track, full);
    let incremental: string;
    if (prev === undefined) incremental = full;
    else if (prev === full) incremental = "(no changes)";
    else incremental = truncateText(diffLines(prev.split("\n"), full.split("\n")), maxChars, 0);
    return { full, incremental };
  }
  return full;
}

/** Compact line diff: "+ "/"- " prefixed lines in document order (LCS based). */
export function diffLines(a: string[], b: string[]): string {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const xs = a.slice(start, endA);
  const ys = b.slice(start, endB);
  const out: string[] = [];
  const n = xs.length;
  const m = ys.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    // Degenerate or too large: plain replace.
    for (const l of xs) out.push("- " + l);
    for (const l of ys) out.push("+ " + l);
    return out.join("\n");
  }
  // LCS table (n+1)*(m+1)
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const xi = xs[i];
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = xi === ys[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push("- " + xs[i]);
      i++;
    } else {
      out.push("+ " + ys[j]);
      j++;
    }
  }
  while (i < n) out.push("- " + xs[i++]);
  while (j < m) out.push("+ " + ys[j++]);
  return out.join("\n");
}

/** Split "f2e5" into { frameKey: "f2", local: "e5" }; "e5" -> { frameKey: null, local: "e5" }. */
export function splitRef(ref: string): { frameKey: string | null; local: string } {
  const m = /^(f\d+)?(e\d+)$/.exec(ref);
  if (!m) throw new Error(`Invalid ref "${ref}". Refs look like e12 or f1e12 and come from page.snapshot().`);
  return { frameKey: m[1] ?? null, local: m[2]! };
}

/** Frame that owns a ref ("f2e5" -> frame f2 from the last snapshot; "e5" -> main frame). */
export function resolveRefFrame(page: Page, ref: string): Frame {
  const { frameKey } = splitRef(ref);
  if (!frameKey) return page.mainFrame();
  const frame = getSnapshotState(page).frames.get(frameKey);
  if (!frame || frame.detached) {
    throw new Error(`Frame ${frameKey} from ref "${ref}" is gone. Take a new page.snapshot().`);
  }
  return frame;
}

export async function resolveRef(page: Page, ref: string): Promise<ElementHandle<Element>> {
  const { local } = splitRef(ref);
  const frame = resolveRefFrame(page, ref);
  const handle = (await frame.$(`ref/${local}`)) as ElementHandle<Element> | null;
  if (!handle) {
    throw new Error(`Ref "${ref}" is stale or unknown. Take a new page.snapshot() and use a fresh ref.`);
  }
  return handle;
}
