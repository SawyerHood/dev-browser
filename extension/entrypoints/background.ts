/**
 * dev-browser Chrome Extension Background Script
 *
 * This extension connects to the dev-browser relay server and allows
 * Playwright automation of the user's existing browser tabs.
 */

import { createLogger } from "../utils/logger";
import { TabManager } from "../services/TabManager";
import { ConnectionManager } from "../services/ConnectionManager";
import { CDPRouter } from "../services/CDPRouter";

export default defineBackground(() => {
  // Create connection manager first (needed for sendMessage)
  let connectionManager: ConnectionManager;

  // Create logger with sendMessage function
  const logger = createLogger((msg) => connectionManager?.send(msg));

  // Create tab manager
  const tabManager = new TabManager({
    logger,
    sendMessage: (msg) => connectionManager.send(msg),
  });

  // Create CDP router
  const cdpRouter = new CDPRouter({
    logger,
    tabManager,
  });

  // Create connection manager
  connectionManager = new ConnectionManager({
    logger,
    onMessage: (msg) => cdpRouter.handleCommand(msg),
    onDisconnect: () => tabManager.detachAll(),
  });

  // Handle debugger events
  function onDebuggerEvent(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params: unknown
  ): void {
    cdpRouter.handleDebuggerEvent(source, method, params, (msg) => connectionManager.send(msg));
  }

  function onDebuggerDetach(
    source: chrome.debugger.Debuggee,
    reason: `${chrome.debugger.DetachReason}`
  ): void {
    const tabId = source.tabId;
    if (!tabId) return;

    logger.debug(`Debugger detached for tab ${tabId}: ${reason}`);
    tabManager.handleDebuggerDetach(tabId);
  }

  // Handle extension icon click - toggle debugger attachment
  async function onActionClicked(tab: chrome.tabs.Tab): Promise<void> {
    if (!tab.id) {
      logger.debug("No tab ID available");
      return;
    }

    const tabInfo = tabManager.get(tab.id);

    if (tabInfo?.state === "connected") {
      // Disconnect
      tabManager.detach(tab.id, true);
    } else {
      // Connect
      try {
        tabManager.set(tab.id, { state: "connecting" });
        await connectionManager.ensureConnected();
        await tabManager.attach(tab.id);
      } catch (error) {
        logger.error("Failed to connect:", error);
        tabManager.set(tab.id, {
          state: "error",
          errorText: (error as Error).message,
        });
      }
    }
  }

  // Set up event listeners
  chrome.action.onClicked.addListener(onActionClicked);

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabManager.has(tabId)) {
      logger.debug("Tab closed:", tabId);
      tabManager.detach(tabId, false);
    }
  });

  // Register debugger event listeners
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);

  // Reset any stale debugger connections on startup
  chrome.debugger.getTargets().then((targets) => {
    const attached = targets.filter((t) => t.tabId && t.attached);
    if (attached.length > 0) {
      logger.log(`Detaching ${attached.length} stale debugger connections`);
      for (const target of attached) {
        chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
      }
    }
  });

  logger.log("Extension initialized");

  // Start connection manager - will auto-connect to relay and reconnect if disconnected
  connectionManager.startMaintaining();
});
