// Deny-list of Playwright protocol (method, top-level params key) pairs that
// would let a sandboxed script reach the host filesystem. The QuickJS client
// platform already throws on fs/path access, which blocks the friendly
// JavaScript APIs that lower to these wire calls. This module is defense in
// depth: it stops a script that crafts the raw protocol message directly from
// reaching the host-side dispatcher.
const DENIED_PARAMS: Record<string, readonly string[]> = {
  screenshot: ["path"],
  pdf: ["path"],
  storageState: ["path"],
  addScriptTag: ["path"],
  addStyleTag: ["path"],
  setInputFilePaths: ["localPaths"],
  saveAs: ["path"],
  fulfill: ["path"],
  tracingStart: ["tracesDir"],
  tracingStop: ["path"],
  tracingStopChunk: ["filePath"],
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
