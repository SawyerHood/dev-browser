import type { Page } from "playwright";
import type { BrowserManager, BrowserPageSummary } from "./browser-manager.js";

export interface CleanupTracker {
  anonymousPages: Page[];
}

export interface ScriptBrowserAPI {
  getPage(name: string): Promise<Page>;
  newPage(): Promise<Page>;
  listPages(): Promise<BrowserPageSummary[]>;
  closePage(name: string): Promise<void>;
}

export function createBrowserAPI(
  manager: BrowserManager,
  browserName: string,
  cleanupTracker: CleanupTracker
): ScriptBrowserAPI {
  return {
    getPage(name: string): Promise<Page> {
      return manager.getPage(browserName, name);
    },

    async newPage(): Promise<Page> {
      const page = await manager.newPage(browserName);
      cleanupTracker.anonymousPages.push(page);
      return page;
    },

    async listPages(): Promise<BrowserPageSummary[]> {
      return manager.listPages(browserName);
    },

    closePage(name: string): Promise<void> {
      return manager.closePage(browserName, name);
    },
  };
}
