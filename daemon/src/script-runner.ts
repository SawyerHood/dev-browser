import util from "node:util";
import vm from "node:vm";
import type { ScriptBrowserAPI } from "./browser-api.js";

interface ScriptOutput {
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}

function withWallClockTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Script timed out after ${timeout}ms`));
    }, timeout);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : util.inspect(arg, {
            colors: false,
            depth: 6,
            compact: 3,
            breakLength: Infinity,
          })
    )
    .join(" ");
}

export async function runScript(
  script: string,
  browser: ScriptBrowserAPI,
  output: ScriptOutput,
  options: { timeout?: number } = {}
): Promise<void> {
  const { timeout = 30_000 } = options;

  const routedConsole = {
    log: (...args: unknown[]) => output.onStdout(`${formatArgs(args)}\n`),
    info: (...args: unknown[]) => output.onStdout(`${formatArgs(args)}\n`),
    debug: (...args: unknown[]) => output.onStdout(`${formatArgs(args)}\n`),
    warn: (...args: unknown[]) => output.onStderr(`${formatArgs(args)}\n`),
    error: (...args: unknown[]) => output.onStderr(`${formatArgs(args)}\n`),
  };

  const context = vm.createContext({
    browser,
    console: routedConsole,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });

  const wrappedScript = `(async () => {\n${script}\n})()`;
  const compiledScript = new vm.Script(wrappedScript, {
    filename: "user-script.js",
  });
  const result = compiledScript.runInContext(context, {
    timeout,
    displayErrors: true,
  });

  await withWallClockTimeout(Promise.resolve(result), timeout);
}
