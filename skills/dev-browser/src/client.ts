import { chromium, type Browser, type Page, type ElementHandle, type Frame } from "playwright";
import type {
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";
import { getSnapshotScript } from "./snapshot/browser-script";

/**
 * Options for finding elements in frames
 */
export interface FindInFramesOptions {
  /** Maximum time to wait for element in ms (default: 5000) */
  timeout?: number;
  /** Include main frame in search (default: true) */
  includeMainFrame?: boolean;
}

/**
 * Result of finding an element in frames
 */
export interface FindInFramesResult {
  /** The element handle if found */
  element: ElementHandle | null;
  /** The frame containing the element */
  frame: Frame | null;
  /** Frame name or src for debugging */
  frameInfo: string;
}

/**
 * Options for filling forms
 */
export interface FillFormOptions {
  /** Maximum time to wait for elements in ms (default: 5000) */
  timeout?: number;
  /** Submit form after filling (default: false) */
  submit?: boolean;
  /** Clear fields before filling (default: true) */
  clear?: boolean;
}

/**
 * Result of filling a form
 */
export interface FillFormResult {
  /** Fields that were successfully filled */
  filled: string[];
  /** Fields that could not be found */
  notFound: string[];
  /** Whether form was submitted (if requested) */
  submitted: boolean;
}

/**
 * Options for waiting for page load
 */
export interface WaitForPageLoadOptions {
  /** Maximum time to wait in ms (default: 10000) */
  timeout?: number;
  /** How often to check page state in ms (default: 50) */
  pollInterval?: number;
  /** Minimum time to wait even if page appears ready in ms (default: 100) */
  minimumWait?: number;
  /** Wait for network to be idle (no pending requests) (default: true) */
  waitForNetworkIdle?: boolean;
}

/**
 * Result of waiting for page load
 */
export interface WaitForPageLoadResult {
  /** Whether the page is considered loaded */
  success: boolean;
  /** Document ready state when finished */
  readyState: string;
  /** Number of pending network requests when finished */
  pendingRequests: number;
  /** Time spent waiting in ms */
  waitTimeMs: number;
  /** Whether timeout was reached */
  timedOut: boolean;
}

interface PageLoadState {
  documentReadyState: string;
  documentLoading: boolean;
  pendingRequests: PendingRequest[];
}

interface PendingRequest {
  url: string;
  loadingDurationMs: number;
  resourceType: string;
}

/**
 * Wait for a page to finish loading using document.readyState and performance API.
 *
 * Uses browser-use's approach of:
 * - Checking document.readyState for 'complete'
 * - Monitoring pending network requests via Performance API
 * - Filtering out ads, tracking, and non-critical resources
 * - Graceful timeout handling (continues even if timeout reached)
 */
export async function waitForPageLoad(
  page: Page,
  options: WaitForPageLoadOptions = {}
): Promise<WaitForPageLoadResult> {
  const {
    timeout = 10000,
    pollInterval = 50,
    minimumWait = 100,
    waitForNetworkIdle = true,
  } = options;

  const startTime = Date.now();
  let lastState: PageLoadState | null = null;

  // Wait minimum time first
  if (minimumWait > 0) {
    await new Promise((resolve) => setTimeout(resolve, minimumWait));
  }

  // Poll until ready or timeout
  while (Date.now() - startTime < timeout) {
    try {
      lastState = await getPageLoadState(page);

      // Check if document is complete
      const documentReady = lastState.documentReadyState === "complete";

      // Check if network is idle (no pending critical requests)
      const networkIdle = !waitForNetworkIdle || lastState.pendingRequests.length === 0;

      if (documentReady && networkIdle) {
        return {
          success: true,
          readyState: lastState.documentReadyState,
          pendingRequests: lastState.pendingRequests.length,
          waitTimeMs: Date.now() - startTime,
          timedOut: false,
        };
      }
    } catch {
      // Page may be navigating, continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // Timeout reached - return current state
  return {
    success: false,
    readyState: lastState?.documentReadyState ?? "unknown",
    pendingRequests: lastState?.pendingRequests.length ?? 0,
    waitTimeMs: Date.now() - startTime,
    timedOut: true,
  };
}

/**
 * Get the current page load state including document ready state and pending requests.
 * Filters out ads, tracking, and non-critical resources that shouldn't block loading.
 */
async function getPageLoadState(page: Page): Promise<PageLoadState> {
  const result = await page.evaluate(() => {
    // Access browser globals via globalThis for TypeScript compatibility
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const g = globalThis as { document?: any; performance?: any };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const perf = g.performance!;
    const doc = g.document!;

    const now = perf.now();
    const resources = perf.getEntriesByType("resource");
    const pending: Array<{ url: string; loadingDurationMs: number; resourceType: string }> = [];

    // Common ad/tracking domains and patterns to filter out
    const adPatterns = [
      "doubleclick.net",
      "googlesyndication.com",
      "googletagmanager.com",
      "google-analytics.com",
      "facebook.net",
      "connect.facebook.net",
      "analytics",
      "ads",
      "tracking",
      "pixel",
      "hotjar.com",
      "clarity.ms",
      "mixpanel.com",
      "segment.com",
      "newrelic.com",
      "nr-data.net",
      "/tracker/",
      "/collector/",
      "/beacon/",
      "/telemetry/",
      "/log/",
      "/events/",
      "/track.",
      "/metrics/",
    ];

    // Non-critical resource types
    const nonCriticalTypes = ["img", "image", "icon", "font"];

    for (const entry of resources) {
      // Resources with responseEnd === 0 are still loading
      if (entry.responseEnd === 0) {
        const url = entry.name;

        // Filter out ads and tracking
        const isAd = adPatterns.some((pattern) => url.includes(pattern));
        if (isAd) continue;

        // Filter out data: URLs and very long URLs
        if (url.startsWith("data:") || url.length > 500) continue;

        const loadingDuration = now - entry.startTime;

        // Skip requests loading > 10 seconds (likely stuck/polling)
        if (loadingDuration > 10000) continue;

        const resourceType = entry.initiatorType || "unknown";

        // Filter out non-critical resources loading > 3 seconds
        if (nonCriticalTypes.includes(resourceType) && loadingDuration > 3000) continue;

        // Filter out image URLs even if type is unknown
        const isImageUrl = /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i.test(url);
        if (isImageUrl && loadingDuration > 3000) continue;

        pending.push({
          url,
          loadingDurationMs: Math.round(loadingDuration),
          resourceType,
        });
      }
    }

    return {
      documentReadyState: doc.readyState,
      documentLoading: doc.readyState !== "complete",
      pendingRequests: pending,
    };
  });

  return result;
}

export interface DevBrowserClient {
  page: (name: string) => Promise<Page>;
  list: () => Promise<string[]>;
  close: (name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Get AI-friendly ARIA snapshot for a page.
   * Returns YAML format with refs like [ref=e1], [ref=e2].
   * Refs are stored on window.__devBrowserRefs for cross-connection persistence.
   */
  getAISnapshot: (name: string) => Promise<string>;
  /**
   * Get an element handle by its ref from the last getAISnapshot call.
   * Refs persist across Playwright connections.
   */
  selectSnapshotRef: (name: string, ref: string) => Promise<ElementHandle | null>;
  /**
   * Find an element across all frames (including iframes like Stripe, PayPal).
   * Searches main frame and all nested iframes for the selector.
   * Useful for payment forms and embedded widgets.
   */
  findInFrames: (
    name: string,
    selector: string,
    options?: FindInFramesOptions
  ) => Promise<FindInFramesResult>;
  /**
   * Smart form filling using field labels, names, or placeholders.
   * Automatically finds fields by matching labels, aria-labels, names, or placeholders.
   * Works across frames (including Stripe iframes).
   */
  fillForm: (
    name: string,
    fields: Record<string, string>,
    options?: FillFormOptions
  ) => Promise<FillFormResult>;
}

export async function connect(serverUrl = "http://localhost:9222"): Promise<DevBrowserClient> {
  let browser: Browser | null = null;
  let wsEndpoint: string | null = null;
  let connectingPromise: Promise<Browser> | null = null;

  async function ensureConnected(): Promise<Browser> {
    // Return existing connection if still active
    if (browser && browser.isConnected()) {
      return browser;
    }

    // If already connecting, wait for that connection (prevents race condition)
    if (connectingPromise) {
      return connectingPromise;
    }

    // Start new connection with mutex
    connectingPromise = (async () => {
      try {
        // Fetch wsEndpoint from server
        const res = await fetch(serverUrl);
        if (!res.ok) {
          throw new Error(`Server returned ${res.status}: ${await res.text()}`);
        }
        const info = (await res.json()) as ServerInfoResponse;
        wsEndpoint = info.wsEndpoint;

        // Connect to the browser via CDP
        browser = await chromium.connectOverCDP(wsEndpoint);
        return browser;
      } finally {
        connectingPromise = null;
      }
    })();

    return connectingPromise;
  }

  // Find page by CDP targetId - more reliable than JS globals
  async function findPageByTargetId(b: Browser, targetId: string): Promise<Page | null> {
    for (const context of b.contexts()) {
      for (const page of context.pages()) {
        let cdpSession;
        try {
          cdpSession = await context.newCDPSession(page);
          const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
          if (targetInfo.targetId === targetId) {
            return page;
          }
        } catch (err) {
          // Only ignore "target closed" errors, log unexpected ones
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Target closed") && !msg.includes("Session closed")) {
            console.warn(`Unexpected error checking page target: ${msg}`);
          }
        } finally {
          if (cdpSession) {
            try {
              await cdpSession.detach();
            } catch {
              // Ignore detach errors - session may already be closed
            }
          }
        }
      }
    }
    return null;
  }

  // Helper to get a page by name (used by multiple methods)
  async function getPage(name: string): Promise<Page> {
    // Request the page from server (creates if doesn't exist)
    const res = await fetch(`${serverUrl}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies GetPageRequest),
    });

    if (!res.ok) {
      throw new Error(`Failed to get page: ${await res.text()}`);
    }

    const { targetId } = (await res.json()) as GetPageResponse;

    // Connect to browser
    const b = await ensureConnected();

    // Find the page by targetId
    const page = await findPageByTargetId(b, targetId);
    if (!page) {
      throw new Error(`Page "${name}" not found in browser contexts`);
    }

    return page;
  }

  return {
    page: getPage,

    async list(): Promise<string[]> {
      const res = await fetch(`${serverUrl}/pages`);
      const data = (await res.json()) as ListPagesResponse;
      return data.pages;
    },

    async close(name: string): Promise<void> {
      const res = await fetch(`${serverUrl}/pages/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error(`Failed to close page: ${await res.text()}`);
      }
    },

    async disconnect(): Promise<void> {
      // Just disconnect the CDP connection - pages persist on server
      if (browser) {
        await browser.close();
        browser = null;
      }
    },

    async getAISnapshot(name: string): Promise<string> {
      // Get the page
      const page = await getPage(name);

      // Inject the snapshot script and call getAISnapshot
      const snapshotScript = getSnapshotScript();
      const snapshot = await page.evaluate((script: string) => {
        // Inject script if not already present
        // Note: page.evaluate runs in browser context where window exists
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        if (!w.__devBrowser_getAISnapshot) {
          // eslint-disable-next-line no-eval
          eval(script);
        }
        return w.__devBrowser_getAISnapshot();
      }, snapshotScript);

      return snapshot;
    },

    async selectSnapshotRef(name: string, ref: string): Promise<ElementHandle | null> {
      // Get the page
      const page = await getPage(name);

      // Find the element using the stored refs
      const elementHandle = await page.evaluateHandle((refId: string) => {
        // Note: page.evaluateHandle runs in browser context where globalThis is the window
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = globalThis as any;
        const refs = w.__devBrowserRefs;
        if (!refs) {
          throw new Error("No snapshot refs found. Call getAISnapshot first.");
        }
        const element = refs[refId];
        if (!element) {
          throw new Error(
            `Ref "${refId}" not found. Available refs: ${Object.keys(refs).join(", ")}`
          );
        }
        return element;
      }, ref);

      // Check if we got an element
      const element = elementHandle.asElement();
      if (!element) {
        await elementHandle.dispose();
        return null;
      }

      return element;
    },

    async findInFrames(
      name: string,
      selector: string,
      options: FindInFramesOptions = {}
    ): Promise<FindInFramesResult> {
      const { timeout = 5000, includeMainFrame = true } = options;
      const page = await getPage(name);

      // Get all frames (including nested)
      const allFrames = page.frames();

      // Try each frame
      for (const frame of allFrames) {
        // Skip main frame if not wanted
        if (!includeMainFrame && frame === page.mainFrame()) {
          continue;
        }

        try {
          // Wait briefly for element in this frame
          const element = await frame.waitForSelector(selector, {
            timeout: Math.min(timeout / allFrames.length, 1000),
            state: "attached",
          });

          if (element) {
            // Build frame info for debugging
            const frameName = frame.name() || "(unnamed)";
            const frameUrl = frame.url();
            const isStripe = frameUrl.includes("stripe");
            const isPaypal = frameUrl.includes("paypal");
            const badge = isStripe ? " [Stripe]" : isPaypal ? " [PayPal]" : "";
            const frameInfo = `${frameName}${badge}: ${frameUrl.substring(0, 60)}`;

            return {
              element,
              frame,
              frameInfo,
            };
          }
        } catch {
          // Element not in this frame, continue
        }
      }

      // Not found in any frame
      return {
        element: null,
        frame: null,
        frameInfo: "Element not found in any frame",
      };
    },

    async fillForm(
      name: string,
      fields: Record<string, string>,
      options: FillFormOptions = {}
    ): Promise<FillFormResult> {
      const { timeout = 5000, submit = false, clear = true } = options;
      const page = await getPage(name);
      const allFrames = page.frames();

      const filled: string[] = [];
      const notFound: string[] = [];

      for (const [fieldLabel, value] of Object.entries(fields)) {
        let found = false;

        // Build selectors to try - from most specific to least
        const normalizedLabel = fieldLabel.toLowerCase().trim();
        const selectors = [
          // Exact matches
          `input[name="${fieldLabel}"]`,
          `input[name="${normalizedLabel}"]`,
          `input[id="${fieldLabel}"]`,
          `input[id="${normalizedLabel}"]`,
          `select[name="${fieldLabel}"]`,
          `select[name="${normalizedLabel}"]`,
          `textarea[name="${fieldLabel}"]`,
          // Placeholder matches
          `input[placeholder*="${fieldLabel}" i]`,
          `input[placeholder*="${normalizedLabel}" i]`,
          // Aria-label matches
          `input[aria-label*="${fieldLabel}" i]`,
          `[aria-label*="${fieldLabel}" i]`,
          // Data attribute matches (common in Stripe)
          `[data-elements-stable-field-name="${normalizedLabel}"]`,
          // Label association
          `label:has-text("${fieldLabel}") + input`,
          `label:has-text("${fieldLabel}") input`,
        ];

        // Try each frame
        for (const frame of allFrames) {
          if (found) break;

          for (const selector of selectors) {
            try {
              const element = await frame.waitForSelector(selector, {
                timeout: Math.min(timeout / (allFrames.length * selectors.length), 200),
                state: "attached",
              });

              if (element) {
                // Clear if requested
                if (clear) {
                  await element.click({ clickCount: 3 }); // Select all
                  await page.keyboard.press("Backspace");
                }

                // Fill the field
                await element.fill(value);
                filled.push(fieldLabel);
                found = true;
                break;
              }
            } catch {
              // Selector not found in this frame, continue
            }
          }
        }

        if (!found) {
          notFound.push(fieldLabel);
        }
      }

      // Submit if requested and we filled at least one field
      let submitted = false;
      if (submit && filled.length > 0) {
        try {
          // Try common submit patterns
          const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Submit")',
            'button:has-text("Pay")',
            'button:has-text("Continue")',
            'button:has-text("Place Order")',
          ];

          for (const selector of submitSelectors) {
            try {
              const btn = await page.waitForSelector(selector, { timeout: 500 });
              if (btn) {
                await btn.click();
                submitted = true;
                break;
              }
            } catch {
              // Continue trying
            }
          }
        } catch {
          // Submit failed
        }
      }

      return { filled, notFound, submitted };
    },
  };
}
