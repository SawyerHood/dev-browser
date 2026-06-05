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

function staleNodeError(nodeId: number): Error {
  return new Error(`DOM node ${nodeId} is stale or missing — re-run getVisibleDom()`);
}

function blockedStateError(): Error {
  return new Error("this page blocks domCua state — domCua cannot track elements here");
}

export class DomCua {
  #page: Page;

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

    const registration = await mainFrame.evaluate(domCuaRegister, {
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
    waitForNavigation = true,
  }: {
    nodeId: number | string;
    button?: "left" | "middle" | "right";
    modifiers?: string[];
    waitForNavigation?: boolean;
  }): Promise<void> {
    const { x, y } = await this.#resolveNodeCenter(nodeId);
    await this.#page.cua.click({ x, y, button, modifiers, waitForNavigation });
  }

  async doubleClick({ nodeId }: { nodeId: number | string }): Promise<void> {
    const { x, y } = await this.#resolveNodeCenter(nodeId);
    await this.#page.cua.click({ x, y, clickCount: 2 });
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
    if (!target) throw staleNodeError(nodeId);
    const frame = this.#page.frames().find((candidate) => frameKey(candidate) === target.frameKey);
    if (!frame) throw staleNodeError(nodeId);
    const handle = await frame.evaluateHandle(
      (ref) => globalThis.__devBrowserDomCua?.refToElement?.get(ref) ?? null,
      target.ref
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw staleNodeError(nodeId);
    }
    try {
      try {
        await element.scrollIntoViewIfNeeded({ timeout: 3000 });
      } catch (error) {
        if (error instanceof TimeoutError) throw staleNodeError(nodeId);
        throw error;
      }
      const box = await element.boundingBox();
      if (!box) throw staleNodeError(nodeId);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    } finally {
      await element.dispose();
    }
  }
}
