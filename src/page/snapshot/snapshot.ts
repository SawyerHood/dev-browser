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
    s = { frames: new Map(), frameKeys: new WeakMap(), nextFrameKey: 0, tracked: new Map() };
    STATE.set(page, s);
  }
  return s;
}

interface InPageResult {
  yaml: string;
  refs: number;
  truncated: boolean;
  droppedLines: number;
  /** origin: the iframe's content-box origin in main-viewport px (for nested [box=...] offsets). */
  iframes: Array<{ ref: string; line: number; origin?: [number, number] }>;
}

interface InPageOptions {
  scope?: string;
  interactive?: boolean;
  depth?: number;
  boxes?: boolean;
  urls?: boolean;
  maxChars?: number;
  refPrefix?: string;
  /** Added to every [box=...]: the frame's viewport origin in main-viewport px. */
  boxOffset?: [number, number];
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
  state: SnapshotState;
  inPageOpts: InPageOptions;
  includeFrames: boolean;
  droppedLines: number;
  timings: number[];
}

/**
 * Frame keys (f1, f2, ...) are stable per Frame object for the life of the page: a frame keeps its key across
 * snapshots (scoped or not) and new frames get fresh keys; a key is never reused for a different frame.
 */
function frameKeyFor(state: SnapshotState, frame: Frame): string {
  let key = state.frameKeys.get(frame);
  if (!key) {
    key = `f${++state.nextFrameKey}`;
    state.frameKeys.set(frame, key);
  }
  state.frames.set(key, frame);
  return key;
}

function pruneDetachedFrames(state: SnapshotState): void {
  for (const [key, frame] of state.frames) if (frame.detached) state.frames.delete(key);
}

/** Snapshot one frame and nest its same-origin iframes. Returns YAML lines (unindented). */
async function snapshotFrame(frame: Frame, refPrefix: string, scope: string | undefined, frameDepth: number, ctx: Ctx, boxOffset: [number, number]): Promise<string[]> {
  const t0 = performance.now();
  const res = await evaluateSnapshot(frame, { ...ctx.inPageOpts, refPrefix, scope, boxOffset });
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
        const key = frameKeyFor(ctx.state, contentFrame);
        try {
          child = await snapshotFrame(contentFrame, key, undefined, frameDepth + 1, ctx, info.origin ?? boxOffset);
        } catch {
          suffix = " [cross-origin]";
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

/** Hint tailored to the options already in use (no point suggesting interactive mode when it is on). */
function truncateHint(opts: SnapshotOptions): string {
  if (!opts.interactive) return "Narrow with snapshot({ scope: 'eN' }) or snapshot({ interactive: true }).";
  const more: string[] = ["snapshot({ scope: 'eN' })"];
  if (opts.urls !== false) more.push("urls: false");
  if (!opts.depth) more.push("depth: N");
  more.push(`a larger maxChars`);
  return `Narrow with ${more.join(", ")}.`;
}

function truncateText(text: string, maxChars: number, extraDropped: number, opts: SnapshotOptions): string {
  const TRUNCATE_HINT = truncateHint(opts);
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
  pruneDetachedFrames(state);
  const ctx: Ctx = {
    state,
    inPageOpts: { interactive: !!opts.interactive, depth: opts.depth, boxes: !!opts.boxes, urls: opts.urls !== false, maxChars },
    includeFrames: opts.frames !== false,
    droppedLines: 0,
    timings: [],
  };

  let lines: string[];
  const scopeFrame = opts.scope ? /^(f\d+)(e\d+)$/.exec(opts.scope) : null;
  if (scopeFrame) {
    // Scope inside a previously snapshotted iframe: render that subtree (frame keys stay as they are).
    const key = scopeFrame[1]!;
    const frame = state.frames.get(key);
    if (!frame || frame.detached) throw new Error(`Frame ${key} from ref "${opts.scope}" is gone. Take a new page.snapshot().`);
    const origin = opts.boxes ? await frameViewportOrigin(frame) : [0, 0];
    lines = await snapshotFrame(frame, key, scopeFrame[2], 1, ctx, origin as [number, number]);
  } else {
    lines = await snapshotFrame(page.mainFrame(), "", opts.scope, 0, ctx, [0, 0]);
  }

  const full = truncateText(lines.join("\n"), maxChars, ctx.droppedLines, opts);
  lastTimings.frames = ctx.timings;
  lastTimings.totalMs = performance.now() - t0;

  if (typeof opts.track === "string") {
    const prev = state.tracked.get(opts.track);
    state.tracked.set(opts.track, full);
    return { full, incremental: incrementalFor(prev, full, maxChars, opts) };
  }
  return full;
}

/**
 * The incremental view of a tracked snapshot:
 * - first call with a name: the full snapshot (there is nothing to diff against);
 * - unchanged: "(no changes)";
 * - otherwise a line diff with one line of unchanged context before each hunk; when the diff would be
 *   more than 60% of the new snapshot's lines (navigation, big re-render) the full snapshot is returned
 *   with a note instead, so incremental never costs more than full.
 */
export const SUBSTANTIAL_CHANGE_NOTE = "(page changed substantially; showing full snapshot)";

function incrementalFor(prev: string | undefined, full: string, maxChars: number, opts: SnapshotOptions): string {
  if (prev === undefined) return full;
  if (prev === full) return "(no changes)";
  const fullLines = full.split("\n");
  const diff = diffLines(prev.split("\n"), fullLines);
  const changed = diff.split("\n").filter((l) => l.startsWith("+ ") || l.startsWith("- ")).length;
  if (changed > 0.6 * fullLines.length) return `${SUBSTANTIAL_CHANGE_NOTE}\n${full}`;
  return truncateText(diff, maxChars, 0, opts);
}

/** Main-viewport origin of a frame's viewport: sum of iframe element content-box offsets up the same-origin chain. */
async function frameViewportOrigin(frame: Frame): Promise<[number, number]> {
  let x = 0;
  let y = 0;
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement().catch(() => null);
    if (!el) break;
    try {
      const [dx, dy] = await el.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [r.left + (e as HTMLElement).clientLeft, r.top + (e as HTMLElement).clientTop];
      });
      x += dx!;
      y += dy!;
    } finally {
      await el.dispose().catch(() => {});
    }
  }
  return [Math.round(x), Math.round(y)];
}

/**
 * Compact line diff (LCS based): "+ "/"- " prefixed lines in document order. Each run of changes (hunk) is
 * preceded by one unchanged context line ("  " prefix, the nearest line above, usually the parent or previous
 * sibling) and hunks are separated by a lone "\u2026" line.
 */
export function diffLines(a: string[], b: string[]): string {
  type Op = ["=" | "-" | "+", string];
  const ops: Op[] = [];
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
  if (start > 0) ops.push(["=", a[start - 1]!]);
  const n = xs.length;
  const m = ys.length;
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    // Degenerate or too large: plain replace.
    for (const l of xs) ops.push(["-", l]);
    for (const l of ys) ops.push(["+", l]);
    return renderOps(ops);
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
      ops.push(["=", xs[i]!]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      ops.push(["-", xs[i]!]);
      i++;
    } else {
      ops.push(["+", ys[j]!]);
      j++;
    }
  }
  while (i < n) ops.push(["-", xs[i++]!]);
  while (j < m) ops.push(["+", ys[j++]!]);
  return renderOps(ops);

  function renderOps(ops: Op[]): string {
    const out: string[] = [];
    let lastEqual: string | null = null; // unchanged line directly above the current position
    let inHunk = false;
    let hunks = 0;
    for (const [op, line] of ops) {
      if (op === "=") {
        lastEqual = line;
        inHunk = false;
        continue;
      }
      if (!inHunk) {
        if (hunks > 0) out.push("\u2026");
        if (lastEqual !== null) out.push("  " + lastEqual);
        inHunk = true;
        hunks++;
      }
      out.push(op + " " + line);
    }
    return out.join("\n");
  }
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
