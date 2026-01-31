/**
 * StateManager - Manages extension active/inactive state with persistence.
 */

import { DEFAULT_RELAY_URL } from "../utils/constants";

const STORAGE_KEY = "devBrowserActiveState";
const RELAY_URL_KEY = "devBrowserRelayUrl";

export interface ExtensionState {
  isActive: boolean;
}

export class StateManager {
  /**
   * Get the current extension state.
   * Defaults to inactive if no state is stored.
   */
  async getState(): Promise<ExtensionState> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const state = result[STORAGE_KEY] as ExtensionState | undefined;
    return state ?? { isActive: false };
  }

  /**
   * Set the extension state.
   */
  async setState(state: ExtensionState): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }

  /**
   * Get the relay URL.
   * Defaults to localhost:9222 if not configured.
   */
  async getRelayUrl(): Promise<string> {
    const result = await chrome.storage.local.get(RELAY_URL_KEY);
    return (result[RELAY_URL_KEY] as string) ?? DEFAULT_RELAY_URL;
  }

  /**
   * Set the relay URL.
   */
  async setRelayUrl(url: string): Promise<void> {
    await chrome.storage.local.set({ [RELAY_URL_KEY]: url.trim() });
  }
}
