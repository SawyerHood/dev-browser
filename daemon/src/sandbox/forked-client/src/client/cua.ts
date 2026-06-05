// @ts-nocheck
import { normalizeKeys } from "./cuaKeys";
import type { Page } from "./page";

const SUPPORTED_BUTTONS = ["left", "middle", "right"];

function assertButton(button: string): void {
  if (!SUPPORTED_BUTTONS.includes(button)) {
    throw new Error(
      `Unsupported mouse button "${button}" — must be one of "left", "middle", or "right"`
    );
  }
}

export class Cua {
  #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * Click at viewport coordinates. By default waits for a click-triggered
   * navigation (a ~1s grace period is paid on every non-navigating click);
   * pass `waitForNavigation: false` to skip the wait in tight loops.
   */
  async click({
    x,
    y,
    button = "left",
    clickCount = 1,
    modifiers = [],
    waitForNavigation = true,
  }: {
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    clickCount?: number;
    modifiers?: string[];
    waitForNavigation?: boolean;
  }): Promise<void> {
    assertButton(button);
    const act = () =>
      this.#withModifiers(modifiers, () => this.#page.mouse.click(x, y, { button, clickCount }));
    if (waitForNavigation) await this.#actAndSettle(act);
    else await act();
  }

  async doubleClick({
    x,
    y,
    modifiers = [],
  }: {
    x: number;
    y: number;
    modifiers?: string[];
  }): Promise<void> {
    await this.click({ x, y, clickCount: 2, modifiers });
  }

  async drag({
    path,
    modifiers = [],
  }: {
    path: Array<{ x: number; y: number }>;
    modifiers?: string[];
  }): Promise<void> {
    if (!Array.isArray(path) || path.length === 0)
      throw new Error("cua.drag requires a non-empty path of {x, y} points");
    await this.#withModifiers(modifiers, async () => {
      await this.#page.mouse.move(path[0].x, path[0].y);
      await this.#page.mouse.down();
      try {
        for (const point of path.slice(1))
          await this.#page.mouse.move(point.x, point.y, { steps: 10 });
      } finally {
        await this.#page.mouse.up();
      }
    });
  }

  async move({ x, y }: { x: number; y: number }): Promise<void> {
    await this.#page.mouse.move(x, y);
  }

  async scroll({
    x,
    y,
    scrollX = 0,
    scrollY = 0,
    modifiers = [],
  }: {
    x: number;
    y: number;
    scrollX?: number;
    scrollY?: number;
    modifiers?: string[];
  }): Promise<void> {
    await this.#withModifiers(modifiers, async () => {
      await this.#page.mouse.move(x, y);
      await this.#page.mouse.wheel(scrollX, scrollY);
    });
  }

  async keypress({ keys }: { keys: string[] }): Promise<void> {
    const normalized = normalizeKeys(keys);
    if (normalized.length === 0) return;
    const held = normalized.slice(0, -1);
    const pressed: string[] = [];
    try {
      for (const key of held) {
        await this.#page.keyboard.down(key);
        pressed.push(key);
      }
      await this.#page.keyboard.press(normalized[normalized.length - 1]);
    } finally {
      for (const key of pressed.reverse()) await this.#page.keyboard.up(key);
    }
  }

  async type({ text }: { text: string }): Promise<void> {
    await this.#page.keyboard.type(text);
  }

  /**
   * Save a JPEG screenshot whose pixels map 1:1 onto cua coordinates
   * (CSS pixels at any DPR). Never derive click coordinates from a
   * `fullPage` image — scroll, then take a viewport screenshot instead.
   */
  async screenshot({
    name,
    fullPage,
    clip,
  }: {
    name?: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  } = {}): Promise<{ path: string; width: number; height: number }> {
    const buffer = await this.#page.screenshot({
      type: "jpeg",
      quality: 80,
      scale: "css",
      fullPage,
      clip,
    });
    const save = globalThis.saveScreenshot;
    if (typeof save !== "function")
      throw new Error("saveScreenshot() is not available in the QuickJS sandbox");
    const path = await save(buffer, (name ?? `cua-${this.#page._guid}`) + ".jpeg");
    let width: number;
    let height: number;
    if (clip) {
      width = clip.width;
      height = clip.height;
    } else if (fullPage) {
      [width, height] = await this.#page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
      ]);
    } else {
      [width, height] = await this.#page.evaluate(() => [innerWidth, innerHeight]);
    }
    return { path, width, height };
  }

  async #withModifiers(modifiers: string[], act: () => Promise<void>): Promise<void> {
    const keys = normalizeKeys(modifiers ?? []);
    const pressed: string[] = [];
    try {
      for (const key of keys) {
        await this.#page.keyboard.down(key);
        pressed.push(key);
      }
      await act();
    } finally {
      for (const key of pressed.reverse()) await this.#page.keyboard.up(key);
    }
  }

  async #actAndSettle(act: () => Promise<void>): Promise<void> {
    const nav = this.#page
      .waitForEvent("framenavigated", {
        predicate: (frame) => frame === this.#page.mainFrame(),
        timeout: 1000,
      })
      .catch(() => null);
    await act();
    if (await nav)
      await this.#page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  }
}
