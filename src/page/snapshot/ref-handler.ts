/**
 * Puppeteer custom query handler so `ref/e5` works as a selector in
 * page.$ / click / type / hover / focus / select / $eval / $$eval.
 *
 * The handler runs inside the page (serialized), in the MAIN realm for
 * page.$-style calls. It reads the ref map installed by the in-page
 * snapshot script (window.__doobie). Frame-prefixed refs (f1e5) are not
 * handled here: extend.ts routes them to the right frame first.
 */
import { Puppeteer } from "puppeteer-core";

let registered = false;

export function registerRefQueryHandler(): void {
  if (registered) return;
  registered = true;
  Puppeteer.registerCustomQueryHandler("ref", {
    queryOne: (node: Node, selector: string) => {
      const doc = (node.nodeType === 9 ? node : node.ownerDocument) as Document | null;
      const win = doc?.defaultView as (Window & { __doobie?: { ref(id: string): Element | null } }) | null;
      const api = win?.__doobie;
      if (!api) return null;
      const el = api.ref(selector);
      if (!el) return null;
      if (node.nodeType !== 9 && !(node as Element).contains(el)) return null;
      return el;
    },
    queryAll: (node: Node, selector: string) => {
      const doc = (node.nodeType === 9 ? node : node.ownerDocument) as Document | null;
      const win = doc?.defaultView as (Window & { __doobie?: { ref(id: string): Element | null } }) | null;
      const api = win?.__doobie;
      if (!api) return [];
      const el = api.ref(selector);
      if (!el) return [];
      if (node.nodeType !== 9 && !(node as Element).contains(el)) return [];
      return [el];
    },
  });
}
