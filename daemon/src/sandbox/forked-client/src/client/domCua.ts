// @ts-nocheck
import { domCuaRegister, domCuaWalker } from "./domCuaInjected";
import { TimeoutError } from "./errors";
import type { Frame } from "./frame";
import type { Page } from "./page";

const MAIN_FRAME_ELEMENT_BUDGET = 200;
const CHILD_FRAME_ELEMENT_BUDGET = 50;
const MAX_LINES = 200;
const MAX_CHARS = 20_000;
const FRAME_TRUNCATION_MARKER = "<!-- output truncated: frame element budget reached -->";
const SNAPSHOT_TRUNCATION_MARKER = "<!-- output truncated: snapshot budget reached -->";
// Each fresh document seeds its node_id counter from a block this wide (see
// #registrationCount below) — sized well above MAX_LINES/the per-frame
// element budgets so one document's ids can never spill into the next
// document's block.
const SEED_HINT_BLOCK_SIZE = 10_000;

function frameKey(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  const indexPath: number[] = [];
  let current = frame;
  for (let parent = current.parentFrame(); parent; parent = current.parentFrame()) {
    indexPath.unshift(parent.childFrames().indexOf(current));
    current = parent;
  }
  return `${frame.url()}@${indexPath.join(".")}`;
}

// domCua's stale-node failure has four distinct root causes that all used to
// collapse into one "stale or missing" message. Splitting them lets an agent
// tell "the page navigated" from "the element was actually removed" from
// "it's just slow to scroll to" — each message below says what to do next.

function unknownNodeIdError(nodeId: number): Error {
  return new Error(
    `DOM node ${nodeId} is not a known node_id — either a navigation/reload reset the page's ` +
      `tracked elements, or this id was never returned by getVisibleDom(). Re-run ` +
      `page.domCua.getVisibleDom() and use one of its node_id values.`
  );
}

function frameGoneError(nodeId: number): Error {
  return new Error(
    `DOM node ${nodeId} belonged to a frame that no longer exists on the page (the iframe was ` +
      `likely removed or replaced). Re-run page.domCua.getVisibleDom() to get node_id values for ` +
      `the frames that are still present.`
  );
}

function elementGoneError(nodeId: number): Error {
  return new Error(
    `DOM node ${nodeId} is no longer present (its element was removed/replaced, or the frame it ` +
      `lived in navigated internally, wiping its tracked elements). Re-run ` +
      `page.domCua.getVisibleDom() and act on the fresh node_id for that element.`
  );
}

function scrollTimeoutError(nodeId: number): Error {
  return new Error(
    `DOM node ${nodeId} did not finish scrolling into view within 3s — it may be hidden, ` +
      `non-scrollable, or inside a slow-loading container, rather than actually gone. Retry the ` +
      `action, or call page.domCua.scroll({ nodeId }) first to bring it into view.`
  );
}

function blockedStateError(): Error {
  return new Error("this page blocks domCua state — domCua cannot track elements here");
}

export class DomCua {
  #page: Page;
  // Counts calls to getVisibleDom() on this Page. domCua's node_id counter
  // normally lives in the page's own JS realm (browser-side) and, for
  // same-origin navigations, in sessionStorage — both keep ids small and
  // sequential across repeated snapshots. But a genuinely fresh document (the
  // very first load, or any navigation onto an origin sessionStorage has
  // never seen — most notably a cross-origin navigation, where
  // sessionStorage cannot carry a counter forward) has no such history to
  // consult. For that case only, domCuaRegister falls back to a hint derived
  // from this always-increasing, browser-navigation-proof counter instead of
  // a large random base: each fresh document gets its own
  // SEED_HINT_BLOCK_SIZE-wide block, so ids stay small (matching this tool's
  // own --help examples) while two different documents viewed by the same
  // Page can never hand out overlapping node_id values — a stale id from
  // before a navigation reliably fails instead of silently resolving to the
  // wrong element on the new document.
  #registrationCount = 0;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * Snapshot the visible interactive elements of every frame as pseudo-HTML
   * lines with `node_id=N` attributes. Ids are only valid against the latest
   * snapshot of the current document — re-run after any navigation.
   */
  async getVisibleDom(): Promise<string> {
    const mainFrame = this.#page.mainFrame();
    const frames = [mainFrame, ...this.#page.frames().filter((frame) => frame !== mainFrame)];
    const snapshots: Array<{
      key: string;
      docToken: string;
      entries: Array<{ ref: number; line: string }>;
      truncated: boolean;
    }> = [];
    for (const frame of frames) {
      const isMain = frame === mainFrame;
      let result;
      try {
        result = await frame.evaluate(domCuaWalker, {
          maxElements: isMain ? MAIN_FRAME_ELEMENT_BUDGET : CHILD_FRAME_ELEMENT_BUDGET,
        });
      } catch (error) {
        if (isMain) throw error;
        continue;
      }
      if (result.blocked) {
        if (isMain) throw blockedStateError();
        continue;
      }
      snapshots.push({
        key: frameKey(frame),
        docToken: result.docToken,
        entries: result.entries,
        truncated: result.truncated,
      });
    }

    this.#registrationCount += 1;
    const seedHint = 1 + (this.#registrationCount - 1) * SEED_HINT_BLOCK_SIZE;
    const registration = await mainFrame.evaluate(domCuaRegister, {
      seedHint,
      frames: snapshots.map((snapshot) => ({
        key: snapshot.key,
        docToken: snapshot.docToken,
        refs: snapshot.entries.map((entry) => entry.ref),
      })),
    });
    if (registration.blocked) throw blockedStateError();

    const lines: string[] = [];
    let chars = 0;
    let budgetExceeded = false;
    for (let i = 0; i < snapshots.length && !budgetExceeded; i++) {
      const snapshot = snapshots[i];
      const ids = registration.ids[i];
      for (let j = 0; j < snapshot.entries.length; j++) {
        const line = snapshot.entries[j].line.replace(/node_id=\d+/, `node_id=${ids[j]}`);
        if (lines.length >= MAX_LINES || chars + line.length > MAX_CHARS) {
          budgetExceeded = true;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
      }
      if (!budgetExceeded && snapshot.truncated) lines.push(FRAME_TRUNCATION_MARKER);
    }
    if (budgetExceeded) lines.push(SNAPSHOT_TRUNCATION_MARKER);
    return lines.join("\n");
  }

  async click({
    nodeId,
    button = "left",
    modifiers = [],
    waitForNavigation = false,
  }: {
    nodeId: number | string;
    button?: "left" | "middle" | "right";
    modifiers?: string[];
    waitForNavigation?: boolean;
  }): Promise<void> {
    const { x, y } = await this.#resolveNodeCenter(nodeId);
    await this.#page.cua.click({ x, y, button, modifiers, waitForNavigation });
  }

  async doubleClick({
    nodeId,
    waitForNavigation = false,
  }: {
    nodeId: number | string;
    waitForNavigation?: boolean;
  }): Promise<void> {
    const { x, y } = await this.#resolveNodeCenter(nodeId);
    await this.#page.cua.click({ x, y, clickCount: 2, waitForNavigation });
  }

  async scroll({
    scrollX = 0,
    scrollY = 0,
    nodeId,
  }: {
    scrollX?: number;
    scrollY?: number;
    nodeId?: number | string;
  }): Promise<void> {
    let x: number;
    let y: number;
    if (nodeId !== undefined) {
      ({ x, y } = await this.#resolveNodeCenter(nodeId));
    } else {
      const [width, height] = await this.#page.evaluate(() => [innerWidth, innerHeight]);
      x = width / 2;
      y = height / 2;
    }
    await this.#page.cua.scroll({ x, y, scrollX, scrollY });
  }

  async type({ text }: { text: string }): Promise<void> {
    await this.#page.cua.type({ text });
  }

  async keypress({ keys }: { keys: string[] }): Promise<void> {
    await this.#page.cua.keypress({ keys });
  }

  async #resolveNodeCenter(nodeId: number | string): Promise<{ x: number; y: number }> {
    if (typeof nodeId === "string" && /^\d+$/.test(nodeId)) nodeId = Number(nodeId);
    if (typeof nodeId !== "number")
      throw new Error("domCua requires a numeric nodeId from getVisibleDom()");
    const target = await this.#page
      .mainFrame()
      .evaluate(
        (id) => globalThis.__devBrowserDomCua?.actionableByPublicId?.get(id) ?? null,
        nodeId
      );
    if (!target) throw unknownNodeIdError(nodeId);
    const frame = this.#page.frames().find((candidate) => frameKey(candidate) === target.frameKey);
    if (!frame) throw frameGoneError(nodeId);
    const handle = await frame.evaluateHandle(
      (ref) => globalThis.__devBrowserDomCua?.refToElement?.get(ref) ?? null,
      target.ref
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw elementGoneError(nodeId);
    }
    try {
      try {
        await element.scrollIntoViewIfNeeded({ timeout: 3000 });
      } catch (error) {
        if (error instanceof TimeoutError) throw scrollTimeoutError(nodeId);
        throw error;
      }
      const box = await element.boundingBox();
      if (!box) throw elementGoneError(nodeId);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    } finally {
      await element.dispose();
    }
  }
}
