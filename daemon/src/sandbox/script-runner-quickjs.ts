import type { BrowserManager } from "../browser-manager.js";
import { QuickJSSandbox } from "./quickjs-sandbox.js";

interface ScriptOutput {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}

export async function finalizeSandbox(
  sandbox: Pick<QuickJSSandbox, "dispose">,
  abortPromise: Promise<void>
): Promise<void> {
  let finalizationError: unknown;
  try {
    await abortPromise;
  } catch (error) {
    finalizationError = error;
  }

  try {
    await sandbox.dispose();
  } catch (error) {
    finalizationError ??= error;
  }

  if (finalizationError instanceof Error) {
    throw finalizationError;
  }
  if (finalizationError !== undefined) {
    throw new Error(String(finalizationError));
  }
}

export async function runScript(
  script: string,
  manager: BrowserManager,
  browserName: string,
  output: ScriptOutput,
  options: { timeout?: number; memoryLimitBytes?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const sandbox = new QuickJSSandbox({
    manager,
    browserName,
    onStdout: output.onStdout,
    onStderr: output.onStderr,
    memoryLimitBytes: options.memoryLimitBytes,
    timeoutMs: options.timeout,
  });

  let abortPromise = Promise.resolve();
  const onAbort = () => {
    const reason =
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error(String(options.signal?.reason ?? "Script aborted"));
    abortPromise = sandbox.abort(reason);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (options.signal?.aborted) {
      onAbort();
      throw options.signal.reason;
    }
    await sandbox.initialize();
    await sandbox.executeScript(`(async () => {\n${script}\n})()`);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await finalizeSandbox(sandbox, abortPromise);
  }
}
