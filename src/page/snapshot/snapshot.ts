/**
 * Host side of the snapshot: injects INPAGE_SCRIPT, recurses same-origin
 * iframes, renders, tracks diffs, resolves refs. See ./index.ts for the contract.
 *
 * TODO(snapshot-agent): implement.
 */
import type { ElementHandle, Frame, Page } from "puppeteer-core";
import type { SnapshotOptions, SnapshotState, TrackedSnapshot } from "./index.ts";

const STATE = new WeakMap<Page, SnapshotState>();

export function getSnapshotState(page: Page): SnapshotState {
  let s = STATE.get(page);
  if (!s) {
    s = { frames: new Map(), tracked: new Map() };
    STATE.set(page, s);
  }
  return s;
}

export async function snapshot(page: Page, opts: SnapshotOptions = {}): Promise<string | TrackedSnapshot> {
  void page;
  void opts;
  throw new Error("page.snapshot is not implemented yet");
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
