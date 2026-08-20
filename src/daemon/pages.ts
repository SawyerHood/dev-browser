/**
 * Named pages for one browser.
 *
 * Names live in ~/.doobie/pages/<browserKey>.json as { name: targetId } so
 * they survive a daemon restart while Chrome keeps running. A name whose
 * target is gone is dropped on first use and the page is recreated.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page, Target } from "puppeteer-core";
import type { PageInfo } from "../shared/protocol.ts";
import { paths } from "../shared/paths.ts";
import { extendPage } from "../page/extend.ts";

const TARGET_ID_RE = /^[0-9A-F]{32}$/;

export function targetIdOf(page: Page): string {
  const t = page.target() as Target & { _targetId?: string };
  if (t && typeof t._targetId === "string") return t._targetId;
  return (page.mainFrame() as unknown as { _id: string })._id;
}

export function looksLikeTargetId(s: string): boolean {
  return TARGET_ID_RE.test(s);
}

export class PageRegistry {
  private names = new Map<string, string>(); // name -> targetId
  private readonly file: string;
  private loaded = false;
  /** Target ids that existed when the browser was launched (Chrome's initial about:blank tab). */
  readonly initialTargetIds = new Set<string>();
  /**
   * Page creation is serialized per registry (design §2): the lookup, the
   * adopt-or-create and the names.set must be atomic, or N parallel
   * getPage(name) calls create N tabs (N-1 leaked anonymous) and N parallel
   * first-time calls with different names all adopt the one initial tab.
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly browser: Browser,
    readonly browserKey: string,
  ) {
    this.file = paths.pagesFile(browserKey);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === "string") this.names.set(k, v);
    } catch {
      /* no file yet */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.names), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }

  private pageTargets(): Target[] {
    return this.browser.targets().filter((t) => t.type() === "page");
  }

  private findTarget(targetId: string): Target | undefined {
    return this.pageTargets().find((t) => (t as Target & { _targetId?: string })._targetId === targetId);
  }

  /** Name of a page or null when anonymous. */
  nameOf(page: Page): string | null {
    this.load();
    const id = targetIdOf(page);
    for (const [name, tid] of this.names) if (tid === id) return name;
    return null;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private async pageFromTarget(target: Target): Promise<Page> {
    const page = await target.page();
    if (!page) throw new Error(`Target ${(target as Target & { _targetId?: string })._targetId} is not a page`);
    extendPage(page);
    return page;
  }

  /**
   * Get a page by name (created lazily and remembered) or by target id
   * (attaches to an existing tab without naming it).
   */
  async getPage(nameOrId: string): Promise<Page> {
    if (typeof nameOrId !== "string" || nameOrId.length === 0) {
      throw new TypeError("browser.getPage(name) requires a non-empty string");
    }
    this.load();
    if (looksLikeTargetId(nameOrId)) {
      const target = this.findTarget(nameOrId);
      if (!target) throw new Error(`No page with target id ${nameOrId}. Use browser.listPages() to see open pages.`);
      return this.pageFromTarget(target);
    }
    return this.withLock(() => this.getNamedPage(nameOrId));
  }

  private async getNamedPage(nameOrId: string): Promise<Page> {
    const existingId = this.names.get(nameOrId);
    if (existingId) {
      const target = this.findTarget(existingId);
      if (target) return this.pageFromTarget(target);
      this.names.delete(nameOrId);
    }
    // Adopt the browser's initial about:blank tab instead of opening a second one.
    const named = new Set(this.names.values());
    const initial = this.pageTargets().find((t) => {
      const id = (t as Target & { _targetId?: string })._targetId ?? "";
      return this.initialTargetIds.has(id) && !named.has(id) && t.url() === "about:blank";
    });
    if (initial) {
      // Reserve the target before the first await so nothing else can adopt it.
      const initialId = (initial as Target & { _targetId?: string })._targetId ?? "";
      this.initialTargetIds.delete(initialId);
      this.names.set(nameOrId, initialId);
      const adopted = await this.pageFromTarget(initial);
      this.names.set(nameOrId, targetIdOf(adopted));
      this.save();
      return adopted;
    }
    const page = await this.browser.newPage();
    extendPage(page);
    this.names.set(nameOrId, targetIdOf(page));
    this.save();
    return page;
  }

  async newPage(): Promise<Page> {
    return this.withLock(async () => {
      const page = await this.browser.newPage();
      extendPage(page);
      return page;
    });
  }

  /** Name an existing page (used by tests and future `doobie pages name` command). */
  setName(name: string, page: Page): void {
    this.load();
    this.names.set(name, targetIdOf(page));
    this.save();
  }

  async closePage(name: string): Promise<void> {
    this.load();
    return this.withLock(async () => {
      const id = this.names.get(name);
      if (!id) throw new Error(`Page "${name}" not found`);
      const target = this.findTarget(id);
      this.names.delete(name);
      this.save();
      if (target) {
        const page = await target.page();
        if (page && !page.isClosed()) await page.close();
      }
    });
  }

  /** Called when the manager notices a target went away. */
  forgetTarget(targetId: string): void {
    this.load();
    let changed = false;
    for (const [name, tid] of this.names) {
      if (tid === targetId) {
        this.names.delete(name);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * List open pages with titles, without attaching to every tab:
   * one browser-level Target.getTargets call.
   */
  async listPages(): Promise<PageInfo[]> {
    this.load();
    const byId = new Map<string, string>();
    for (const [name, tid] of this.names) byId.set(tid, name);
    let infos: Array<{ targetId: string; type: string; url: string; title: string }> = [];
    try {
      const session = await this.browser.target().createCDPSession();
      try {
        const res = (await session.send("Target.getTargets")) as { targetInfos: typeof infos };
        infos = res.targetInfos;
      } finally {
        await session.detach().catch(() => {});
      }
    } catch {
      // Fallback: Puppeteer targets without titles.
      infos = this.pageTargets().map((t) => ({
        targetId: (t as Target & { _targetId?: string })._targetId ?? "",
        type: "page",
        url: t.url(),
        title: "",
      }));
    }
    const known = new Set(this.pageTargets().map((t) => (t as Target & { _targetId?: string })._targetId));
    return infos
      .filter((i) => i.type === "page" && (known.size === 0 || known.has(i.targetId)))
      .map((i) => ({ id: i.targetId, name: byId.get(i.targetId) ?? null, url: i.url, title: i.title }));
  }
}
