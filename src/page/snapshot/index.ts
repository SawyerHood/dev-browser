/**
 * ARIA snapshot with refs. PUBLIC CONTRACT — implemented in ./snapshot.ts.
 *
 * Design (settled):
 * - An in-page script (INPAGE_SCRIPT from ./inpage.ts) runs in Puppeteer's
 *   ISOLATED realm of a frame (`frame.isolatedRealm()`, where custom query
 *   handlers execute; invisible to page scripts) and installs `window.__doobie` with:
 *     snapshot(opts) -> { yaml: string, refs: number, truncated: boolean, iframes: Array<{ ref: string }> }
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
 *   { full, incremental } where incremental is a unified-style diff of changed
 *   lines against the previous snapshot with that name ("(no changes)" when equal).
 * - `boxes: true` appends ` [box=x,y,w,h]` after [ref=...] for ref'd elements.
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
}

export interface TrackedSnapshot {
  full: string;
  incremental: string;
}

export interface SnapshotState {
  /** fN -> Frame from the latest snapshot. */
  frames: Map<string, Frame>;
  /** track name -> last full snapshot. */
  tracked: Map<string, string>;
}

export const REF_RE = /^(f\d+)?e\d+$/;
export const REF_SELECTOR_PREFIX = "ref/";

export { snapshot, resolveRef, resolveRefFrame, getSnapshotState } from "./snapshot.ts";
export { registerRefQueryHandler } from "./ref-handler.ts";
export type { ElementHandle };
