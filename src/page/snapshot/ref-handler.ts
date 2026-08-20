/**
 * Puppeteer custom query handler so `ref/e5` works as a selector in
 * page.$ / click / type / hover / focus / select / $eval / $$eval.
 *
 * The handler runs inside the page (serialized) in Puppeteer's ISOLATED
 * realm (`frame.isolatedRealm()`), which is where the snapshot installs the
 * ref map (window.__doobie) — invisible to page scripts. Frame-prefixed refs
 * (f1e5) are not handled here: extend.ts routes them to the right frame first.
 */
import { Puppeteer } from "puppeteer-core";

let registered = false;

// NOTE: queryOne/queryAll are serialized (Function.toString) and evaluated in the page: they must be
// self-contained (no closure over module helpers).

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
      // composed-tree containment: root.contains(el) crossing open shadow roots (host chain)
      if (node.nodeType !== 9) {
        let inside = false;
        for (let n: Node | null = el; n; ) {
          if (n === node) { inside = true; break; }
          const p: Node | null = n.parentNode;
          n = p && p.nodeType === 11 ? (p as ShadowRoot).host : p;
        }
        if (!inside) return null;
      }
      return el;
    },
    queryAll: (node: Node, selector: string) => {
      const doc = (node.nodeType === 9 ? node : node.ownerDocument) as Document | null;
      const win = doc?.defaultView as (Window & { __doobie?: { ref(id: string): Element | null } }) | null;
      const api = win?.__doobie;
      if (!api) return [];
      const el = api.ref(selector);
      if (!el) return [];
      // composed-tree containment: root.contains(el) crossing open shadow roots (host chain)
      if (node.nodeType !== 9) {
        let inside = false;
        for (let n: Node | null = el; n; ) {
          if (n === node) { inside = true; break; }
          const p: Node | null = n.parentNode;
          n = p && p.nodeType === 11 ? (p as ShadowRoot).host : p;
        }
        if (!inside) return [];
      }
      return [el];
    },
  });
}
