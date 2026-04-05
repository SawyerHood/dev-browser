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
  fs: () => unsupported("fs"),
  inspectCustom: undefined,
  isDebugMode: () => false,
  isJSDebuggerAttached: () => false,
  isLogEnabled: () => false,
  isUnderTest: () => false,
  log: () => {},
  path: () => unsupported("path"),
  pathSeparator: "/",
  showInternalStackFrames: () => false,
  streamFile: () => unsupported("streamFile"),
  streamReadable: () => unsupported("streamReadable"),
  streamWritable: () => unsupported("streamWritable"),
  zones: {
    empty: noopZone,
    current: () => noopZone,
  },
};
