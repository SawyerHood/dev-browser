/**
 * ARIA snapshot with refs. PUBLIC CONTRACT — implemented in ./snapshot.ts.
 *
 * Design (settled):
 * - An in-page script (INPAGE_SCRIPT from ./inpage.ts) runs in Puppeteer's
 *   ISOLATED realm of a frame (`frame.isolatedRealm()`, where custom query
 *   handlers execute; invisible to page scripts) and installs `window.__devBrowser` with:
 *     snapshot(opts) -> { yaml: string, refs: number, truncated: boolean, iframes: Array<{ ref: string, line: number, origin: [x, y] }> }
 *     ref(id)        -> Element | null          (id like "e12", stable within a document)
 *     box(id)        -> [x, y, w, h] | null     (viewport-relative CSS px)
 *   Refs are assigned to visible elements that receive pointer events, reused
 *   for the same element across calls (stored in a WeakMap/expando), and reset
 *   when the document changes. The script is idempotent: re-evaluating it is a no-op.
 * - Frames: the main frame is snapshotted first; same-origin iframes are
 *   recursed via Puppeteer `ElementHandle.contentFrame()` and rendered nested
 *   under their iframe line, with refs prefixed `f<N>` (f1e5). The mapping
 *   fN -> Frame is stored on the page for resolveRef(). Cross-origin iframes
 *   render as `- iframe [ref=e9] [cross-origin]`.
 * - Output is YAML in the Playwright/do-browser grammar:
 *     - role "name" [checked] [disabled] [expanded] [active] [level=N] [pressed] [selected] [ref=e5] [cursor=pointer]: text
 *     - /url: ...   - /placeholder: ...   - text: ...
 *   Token reducers: collapse nameless generics with one child, inline single text,
 *   `[cursor=pointer]` only on the outermost pointer element, name==text dedupe,
 *   names > 900 chars dropped.
 * - Budget: `maxChars` (default 20000). When exceeded the YAML is cut at a line
 *   boundary and a final line is appended:
 *     # ... truncated at 20000 chars (N more lines). Narrow with snapshot({ scope: 'eN' }) or snapshot({ interactive: true }).
 * - `interactive: true` keeps only interactive elements (link, button, textbox,
 *   checkbox, radio, combobox, listbox, option, menuitem, tab, switch, slider,
 *   searchbox, spinbutton, elements with click handlers/cursor=pointer) plus the
 *   landmark/heading ancestors needed for context.
 * - `scope` is a ref id ("e12") or a CSS selector; the snapshot starts at that element.
 * - `depth` limits tree depth.
 * - `track: name` stores the full snapshot on the page under `name` and returns
 *   { full, incremental }. incremental is: the full snapshot on the first call
 *   with that name (nothing to diff against; print .full OR .incremental, not
 *   both); "(no changes)" when equal; otherwise a line diff ("+ "/"- " lines,
 *   one "  " context line before each hunk, "…" between hunks). When the diff
 *   exceeds 60% of the new snapshot's lines (navigation, re-render) it is
 *   "(page changed substantially; showing full snapshot)\n" + full.
 * - `boxes: true` appends ` [box=x,y,w,h]` after [ref=...] for ref'd elements;
 *   coordinates are MAIN-viewport CSS px (iframe offsets applied), for page.mouse.
 * - `urls: false` drops the `- /url: ...` lines under links (default true).
 * - Frame keys fN are stable per Frame object for the life of the page; a key
 *   is never reused for a different frame, so old f1e5 refs cannot act in the
 *   wrong frame.
 * - `depth`-cut nodes carry a trailing ` […]` marker (scope into them to see more).
 */
import type { ElementHandle, Frame, Page } from "puppeteer-core";

export interface SnapshotOptions {
  scope?: string;
  interactive?: boolean;
  depth?: number;
  track?: string;
  boxes?: boolean;
  maxChars?: number;
  /** Include same-origin iframes. Default true. */
  frames?: boolean;
  /** Include `- /url: ...` lines under links. Default true. */
  urls?: boolean;
}

export interface TrackedSnapshot {
  full: string;
  incremental: string;
}

export interface SnapshotState {
  /** fN -> Frame for every live frame seen by any snapshot of this page (detached frames are pruned). */
  frames: Map<string, Frame>;
  /** Frame -> fN: stable key per Frame object. */
  frameKeys: WeakMap<Frame, string>;
  /** Last allocated frame key number; never reset while the page lives. */
  nextFrameKey: number;
  /** track name -> last full snapshot. */
  tracked: Map<string, string>;
}

export const REF_RE = /^(f\d+)?e\d+$/;
export const REF_SELECTOR_PREFIX = "ref/";

export { snapshot, resolveRef, resolveRefFrame, getSnapshotState } from "./snapshot.ts";
export { registerRefQueryHandler } from "./ref-handler.ts";
export type { ElementHandle };
