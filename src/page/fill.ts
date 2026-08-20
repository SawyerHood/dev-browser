/**
 * page.fill(selector, text): clear an input/textarea/contenteditable and
 * type the new value. Works with React-controlled inputs (native setter +
 * input/change events) and with ref/ selectors.
 *
 * Inputs whose value is not produced by keystrokes (date, time, color,
 * range, number, ...) get the value through the native setter instead of
 * typing. Readonly/disabled controls and non-text inputs throw.
 */
import type { ElementHandle, Page, Frame } from "puppeteer-core";

/** Input types that take the value verbatim instead of via keystrokes. */
const VALUE_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range", "number"]);
/** Input types that have no text value at all. */
const NON_TEXT_TYPES = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "hidden"]);

export async function fill(scope: Page | Frame, selector: string, text: string, opts: { delay?: number } = {}): Promise<void> {
  if (typeof text !== "string") text = String(text);
  const el = (await scope.$(selector)) as ElementHandle<Element> | null;
  if (!el) throw new Error(`fill: no element matches ${JSON.stringify(selector)}`);
  try {
    await el.focus();
    const mode = await el.evaluate(
      (node, value, valueTypes, nonTextTypes) => {
        const e = node as HTMLElement;
        const tag = e.tagName;
        const fire = () => {
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
        };
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const input = e as HTMLInputElement;
          const type = tag === "INPUT" ? (input.type || "text").toLowerCase() : "textarea";
          if (nonTextTypes.includes(type)) {
            throw new Error(`fill: <input type=${type}> has no text value (use page.click() for checkboxes/radios, ElementHandle.uploadFile() for files)`);
          }
          if (input.disabled) throw new Error(`fill: element is disabled`);
          if (input.readOnly) throw new Error(`fill: element is readonly`);
          const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const set = (v: string) => {
            if (setter) setter.call(e, v);
            else input.value = v;
          };
          if (valueTypes.includes(type)) {
            set(value);
            if (input.value !== value && value !== "") {
              throw new Error(`fill: <input type=${type}> rejected ${JSON.stringify(value)} (expects a value like ${type === "date" ? "2024-01-31" : type === "time" ? "13:45" : type === "color" ? "#rrggbb" : type === "month" ? "2024-01" : type === "week" ? "2024-W05" : type === "datetime-local" ? "2024-01-31T13:45" : "a number"})`);
            }
            fire();
            return "set";
          }
          set("");
          fire();
          return "type";
        }
        if (tag === "SELECT") throw new Error(`fill: <select> cannot be filled; use page.select(selector, value)`);
        if (e.isContentEditable) {
          const sel = e.ownerDocument.getSelection();
          const range = e.ownerDocument.createRange();
          range.selectNodeContents(e);
          sel?.removeAllRanges();
          sel?.addRange(range);
          e.ownerDocument.execCommand("delete");
          return "type";
        }
        throw new Error(`fill: element <${tag.toLowerCase()}> is not an input, textarea, or contenteditable`);
      },
      text,
      [...VALUE_TYPES],
      [...NON_TEXT_TYPES],
    );
    if (mode === "type" && text.length > 0) await el.type(text, { delay: opts.delay ?? 0 });
  } finally {
    await el.dispose().catch(() => {});
  }
}
