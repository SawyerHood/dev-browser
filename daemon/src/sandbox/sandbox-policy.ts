// Deny-list of Playwright protocol (method, top-level params key) pairs that
// let a sandboxed script reach the host filesystem at the *wire* level.
//
// Scope: the dev-browser QuickJS client platform already throws on `fs` and
// `path` (forked-client/quickjs-platform.ts), which blocks the friendly
// client-side APIs that resolve to host I/O before sending anything to the
// server (page.screenshot({ path }), page.pdf({ path }), addScriptTag({ path }),
// browserContext.storageState({ path }), tracing.start/stop({ path }), etc.
// — none of those params exist in the wire schema; the client writes the file
// itself via the platform fs adapter).
//
// What we have to block here are wire methods whose *server-side* implementation
// reads or writes a host path passed in params. A sandboxed script that reaches
// the underlying connection (e.g. via page._connection) can craft these
// messages directly, bypassing the friendly API.
//
// Verified against playwright-core 1.58.2 protocol/validator.js.
const DENIED_PARAMS: Record<string, readonly string[]> = {
  // Frame.setInputFiles / ElementHandle.setInputFiles — server reads the listed
  // local paths and uploads them. `directoryStream` is a channel handle (server
  // writes to a sandbox-supplied stream) and is intentionally not denied here.
  setInputFiles: ["localPaths", "localDirectory"],
  // Artifact.saveAs — server writes the artifact to a host-supplied path.
  saveAs: ["path"],
  // LocalUtils.harOpen — server opens and reads a HAR file from disk.
  harOpen: ["file"],
};

export interface PolicyViolation {
  method: string;
  param: string;
}

export function checkProtocolMessage(
  message: Record<string, unknown>
): PolicyViolation | null {
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return null;
  const denied = DENIED_PARAMS[method];
  if (!denied) return null;
  const params = (message.params ?? {}) as Record<string, unknown>;
  for (const key of denied) {
    if (params[key] !== undefined && params[key] !== null) {
      return { method, param: key };
    }
  }
  return null;
}

export function formatPolicyError(violation: PolicyViolation): string {
  return `Sandbox policy: parameter '${violation.param}' is not allowed on '${violation.method}' (host filesystem path access is denied).`;
}
