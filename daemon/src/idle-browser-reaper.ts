export interface IdleBrowserSummary {
  name: string;
  type: "launched" | "connected";
}

export interface BrowserIdleInfo {
  activeRequests: number;
  idleForMs?: number;
  idleRemainingMs?: number;
}

interface ActivityState {
  activeRequests: number;
  lastActivityAt: number;
}

interface IdleBrowserReaperDependencies {
  listBrowsers(): IdleBrowserSummary[];
  stopBrowser(name: string): Promise<void>;
  withBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T>;
  now?: () => number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class IdleBrowserReaper {
  readonly #activity = new Map<string, ActivityState>();
  readonly #dependencies: IdleBrowserReaperDependencies;
  readonly #now: () => number;

  #idleTimeoutMs = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dependencies: IdleBrowserReaperDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? Date.now;
  }

  configure(idleTimeoutMs: number): void {
    if (idleTimeoutMs === this.#idleTimeoutMs) {
      return;
    }

    this.#idleTimeoutMs = idleTimeoutMs;
    this.#scheduleNextDeadline();
  }

  get idleTimeoutMs(): number {
    return this.#idleTimeoutMs;
  }

  requestStarted(browserName: string): void {
    const state = this.#getOrCreateActivity(browserName);
    state.activeRequests += 1;
    state.lastActivityAt = this.#now();
    this.#scheduleNextDeadline();
  }

  requestFinished(browserName: string): void {
    const state = this.#getOrCreateActivity(browserName);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    state.lastActivityAt = this.#now();
    this.#scheduleNextDeadline();
  }

  browserStopped(browserName: string): void {
    this.#activity.delete(browserName);
    this.#scheduleNextDeadline();
  }

  idleInfo(browser: IdleBrowserSummary): BrowserIdleInfo {
    const state = this.#activity.get(browser.name);
    if (!state) {
      return { activeRequests: 0 };
    }

    const now = this.#now();
    const idleForMs = Math.max(0, now - state.lastActivityAt);
    const info: BrowserIdleInfo = {
      activeRequests: state.activeRequests,
      idleForMs,
    };

    if (browser.type === "launched" && this.#idleTimeoutMs > 0 && state.activeRequests === 0) {
      info.idleRemainingMs = Math.max(0, this.#idleTimeoutMs - idleForMs);
    }

    return info;
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #getOrCreateActivity(browserName: string): ActivityState {
    let state = this.#activity.get(browserName);
    if (!state) {
      state = { activeRequests: 0, lastActivityAt: this.#now() };
      this.#activity.set(browserName, state);
    }
    return state;
  }

  #scheduleNextDeadline(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (this.#idleTimeoutMs === 0) {
      return;
    }

    const now = this.#now();
    let earliestDeadline: number | undefined;

    for (const browser of this.#dependencies.listBrowsers()) {
      if (browser.type !== "launched") {
        continue;
      }

      const state = this.#getOrCreateActivity(browser.name);
      if (state.activeRequests > 0) {
        continue;
      }

      const deadline = state.lastActivityAt + this.#idleTimeoutMs;
      earliestDeadline =
        earliestDeadline === undefined ? deadline : Math.min(earliestDeadline, deadline);
    }

    if (earliestDeadline === undefined) {
      return;
    }

    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestDeadline - now));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#reapDueBrowsers().finally(() => this.#scheduleNextDeadline());
    }, delay);
    this.#timer.unref?.();
  }

  async #reapDueBrowsers(): Promise<void> {
    if (this.#idleTimeoutMs === 0) {
      return;
    }

    const now = this.#now();
    const candidates = this.#dependencies
      .listBrowsers()
      .filter((browser) => {
        const state = this.#activity.get(browser.name);
        return (
          browser.type === "launched" &&
          state !== undefined &&
          state.activeRequests === 0 &&
          now - state.lastActivityAt >= this.#idleTimeoutMs
        );
      })
      .map((browser) => browser.name);

    await Promise.allSettled(
      candidates.map(async (browserName) => {
        await this.#dependencies.withBrowserLock(browserName, async () => {
          const browser = this.#dependencies
            .listBrowsers()
            .find((candidate) => candidate.name === browserName);
          const state = this.#activity.get(browserName);

          // Recheck after acquiring the same lock used by scripts and explicit stops.
          // A request that started or completed while the reaper waited gets a fresh deadline.
          if (
            !browser ||
            browser.type !== "launched" ||
            !state ||
            state.activeRequests > 0 ||
            this.#idleTimeoutMs === 0 ||
            this.#now() - state.lastActivityAt < this.#idleTimeoutMs
          ) {
            return;
          }

          try {
            await this.#dependencies.stopBrowser(browserName);
            this.#activity.delete(browserName);
          } catch {
            // Avoid a tight retry loop if a close fails unexpectedly.
            state.lastActivityAt = this.#now();
          }
        });
      })
    );
  }
}
