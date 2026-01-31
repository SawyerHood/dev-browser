import type {
  GetStateMessage,
  SetStateMessage,
  GetRelayUrlMessage,
  SetRelayUrlMessage,
  StateResponse,
  RelayUrlResponse,
} from "../../utils/types";
import { validateRelayUrl } from "../../utils/constants";

const toggle = document.getElementById("active-toggle") as HTMLInputElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const connectionStatus = document.getElementById("connection-status") as HTMLParagraphElement;
const relayUrlInput = document.getElementById("relay-url") as HTMLInputElement;
const saveUrlButton = document.getElementById("save-url") as HTMLButtonElement;
const urlStatus = document.getElementById("url-status") as HTMLParagraphElement;

function updateUI(state: StateResponse): void {
  toggle.checked = state.isActive;
  statusText.textContent = state.isActive ? "Active" : "Inactive";

  if (state.isActive) {
    connectionStatus.textContent = state.isConnected ? "Connected to relay" : "Connecting...";
    connectionStatus.className = state.isConnected
      ? "connection-status connected"
      : "connection-status connecting";
  } else {
    connectionStatus.textContent = "";
    connectionStatus.className = "connection-status";
  }
}

function refreshState(): void {
  chrome.runtime.sendMessage<GetStateMessage, StateResponse>({ type: "getState" }, (response) => {
    if (response) {
      updateUI(response);
    }
  });
}

function loadRelayUrl(): void {
  chrome.runtime.sendMessage<GetRelayUrlMessage, RelayUrlResponse>(
    { type: "getRelayUrl" },
    (response) => {
      if (response) {
        relayUrlInput.value = response.relayUrl;
      }
    }
  );
}

function saveRelayUrl(): void {
  const relayUrl = relayUrlInput.value.trim();

  const validationError = validateRelayUrl(relayUrl);
  if (validationError) {
    urlStatus.textContent = validationError;
    urlStatus.className = "url-status error";
    return;
  }

  chrome.runtime.sendMessage<SetRelayUrlMessage, RelayUrlResponse>(
    { type: "setRelayUrl", relayUrl },
    (response) => {
      if (chrome.runtime.lastError) {
        urlStatus.textContent = "Failed to save URL";
        urlStatus.className = "url-status error";
        return;
      }
      if (response) {
        urlStatus.textContent = "Saved! Reconnecting...";
        urlStatus.className = "url-status saved";
        setTimeout(() => {
          urlStatus.textContent = "";
          urlStatus.className = "url-status";
        }, 3000);
      }
    }
  );
}

// Load initial state
refreshState();
loadRelayUrl();

// Poll for state updates while popup is open
const pollInterval = setInterval(refreshState, 1000);

// Clean up on popup close
window.addEventListener("unload", () => {
  clearInterval(pollInterval);
});

// Handle toggle changes
toggle.addEventListener("change", () => {
  const isActive = toggle.checked;
  chrome.runtime.sendMessage<SetStateMessage, StateResponse>(
    { type: "setState", isActive },
    (response) => {
      if (response) {
        updateUI(response);
      }
    }
  );
});

// Handle save URL button
saveUrlButton.addEventListener("click", saveRelayUrl);

// Handle Enter key in URL input
relayUrlInput.addEventListener("keypress", (event) => {
  if (event.key === "Enter") {
    saveRelayUrl();
  }
});
