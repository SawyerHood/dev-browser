/**
 * page.fill(selector, text): clear an input/textarea/contenteditable and
 * type the new value. Works with React-controlled inputs (native setter +
 * input/change events) and with ref/ selectors.
 */
import type { ElementHandle, Page, Frame } from "puppeteer-core";

export async function fill(scope: Page | Frame, selector: string, text: string, opts: { delay?: number } = {}): Promise<void> {
  if (typeof text !== "string") text = String(text);
  const el = (await scope.$(selector)) as ElementHandle<Element> | null;
  if (!el) throw new Error(`fill: no element matches ${JSON.stringify(selector)}`);
  try {
    await el.focus();
    await el.evaluate((node) => {
      const e = node as HTMLElement;
      const tag = e.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(e, "");
        else (e as HTMLInputElement).value = "";
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (e.isContentEditable) {
        const sel = e.ownerDocument.getSelection();
        const range = e.ownerDocument.createRange();
        range.selectNodeContents(e);
        sel?.removeAllRanges();
        sel?.addRange(range);
        e.ownerDocument.execCommand("delete");
      } else {
        throw new Error(`fill: element <${tag.toLowerCase()}> is not an input, textarea, or contenteditable`);
      }
    });
    if (text.length > 0) await el.type(text, { delay: opts.delay ?? 0 });
  } finally {
    await el.dispose().catch(() => {});
  }
}
