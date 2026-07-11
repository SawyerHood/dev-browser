import { webColors } from "./src/utils/isomorphic/colors";

import type { Platform, Zone } from "./src/client/platform";

const noopZone: Zone = {
  push: () => noopZone,
  pop: () => noopZone,
  run: <T>(callback: () => T) => callback(),
  data: <T>() => undefined as T | undefined,
};

function unsupported(apiName: string): never {
  throw new Error(`${apiName} is not available in the QuickJS sandbox`);
}

// Playwright's internal `fs`/`path` modules back every path-based API on the
// client: element.setInputFiles({ path }), page.pdf({ path }),
// context.storageState({ path }), route.fulfill({ path }), browserContext.tracing,
// HAR recording, etc. None of them work in the QuickJS sandbox — there is no
// real filesystem here — but the bare "fs is not available" message didn't
// say what to do instead. Name the limitation and the workarounds that cover
// the field-costliest case (file uploads) and the general case (pass data
// inline instead of a path). addInitScript() is called out separately: it is
// unsupported in every form (not just { path }), so it has its own dedicated
// error (see clientHelper.ts's assertAddInitScriptSupported()) rather than
// relying on this generic message.
function unsupportedFilesystemApi(apiName: "fs" | "path"): never {
  throw new Error(
    `${apiName} is not available in the QuickJS sandbox — there is no real filesystem for ` +
      `Playwright's built-in path-based helpers (element.setInputFiles({ path }), ` +
      `page.pdf({ path }), context.storageState({ path }), route.fulfill({ path }), and ` +
      `similar; addInitScript() is unsupported outright, in every form — see its own error). ` +
      `For file uploads: call the sandbox's uploadFile(pageName, selector, { name, mimeType, ` +
      `base64 }) helper, or read the file into a Buffer with readFile() and call ` +
      `element.setInputFiles({ name, mimeType, buffer }) — or inject the bytes via a ` +
      `canvas/DataTransfer inside page.evaluate(). For everything else, pass inline content ` +
      `instead of a path where the API supports it.`
  );
}

function pseudoSha1(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const quickjsPlatform: Platform = {
  name: "empty",
  boxedStackPrefixes: () => [],
  calculateSha1: async (text: string) => pseudoSha1(text),
  colors: webColors,
  createGuid: () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
      const value = Math.floor(Math.random() * 16);
      const nibble = token === "x" ? value : (value & 0x3) | 0x8;
      return nibble.toString(16);
    }),
  defaultMaxListeners: () => 10,
  env: {},
  fs: () => unsupportedFilesystemApi("fs"),
  inspectCustom: undefined,
  isDebugMode: () => false,
  isJSDebuggerAttached: () => false,
  isLogEnabled: () => false,
  isUnderTest: () => false,
  log: () => {},
  path: () => unsupportedFilesystemApi("path"),
  pathSeparator: "/",
  showInternalStackFrames: () => false,
  streamFile: () => unsupported("streamFile"),
  streamReadable: () => unsupported("streamReadable"),
  streamWritable: () => unsupported("streamWritable"),
  zodToJsonSchema: () => unsupported("zodToJsonSchema"),
  zones: {
    empty: noopZone,
    current: () => noopZone,
  },
};
