/**
 * In-page snapshot script. Evaluated as a string in the MAIN realm of a frame.
 * Installs window.__doobie (idempotent). See ./index.ts for the contract.
 *
 * TODO(snapshot-agent): port do-browser's ariaSnapshot.ts (a port of
 * Playwright's injected ariaSnapshot) and add: stable refs, interactive mode,
 * scope, depth, boxes, maxChars truncation, iframe detection.
 */
export const INPAGE_SCRIPT = `(() => {
  if (window.__doobie) return;
  throw new Error("snapshot in-page script not implemented yet");
})();`;
