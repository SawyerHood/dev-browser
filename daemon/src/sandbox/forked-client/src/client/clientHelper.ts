// @ts-nocheck
/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { isString } from "../utils/isomorphic/rtti";

import type { Platform } from "./platform";

export function envObjectToArray(env: NodeJS.ProcessEnv): { name: string; value: string }[] {
  const result: { name: string; value: string }[] = [];
  for (const name in env) {
    if (!Object.is(env[name], undefined)) result.push({ name, value: String(env[name]) });
  }
  return result;
}

export async function evaluationScript(
  platform: Platform,
  fun: Function | string | { path?: string; content?: string },
  arg?: any,
  addSourceUrl: boolean = true
): Promise<string> {
  if (typeof fun === "function") {
    const source = fun.toString();
    const argString = Object.is(arg, undefined) ? "undefined" : JSON.stringify(arg);
    return `(${source})(${argString})`;
  }
  if (arg !== undefined) throw new Error("Cannot evaluate a string with arguments");
  if (isString(fun)) return fun;
  if (fun.content !== undefined) return fun.content;
  if (fun.path !== undefined) {
    let source = await platform.fs().promises.readFile(fun.path, "utf8");
    if (addSourceUrl) source = addSourceUrlToScript(source, fun.path);
    return source;
  }
  throw new Error("Either path or content property must be present");
}

export function addSourceUrlToScript(source: string, path: string): string {
  return `${source}\n//# sourceURL=${path.replace(/\n/g, "")}`;
}

// addInitScript() does not work in the QuickJS sandbox in ANY of its input
// forms. The { path } form fails at the platform's fs() stub (see
// quickjs-platform.ts) because there is no real filesystem to read from. The
// function/string/{ content } forms get past evaluationScript() just fine —
// but fail deeper, when the server tries to relay the resulting init-script
// registration back across the sandbox's protocol bridge, surfacing only as
// an opaque `__transport_receive failed: expected object, got undefined` /
// ValidationError with nothing pointing at addInitScript as the cause. Fail
// fast, before any of that, with an authored error that names the limitation
// and the workaround (agents lose 15-20+ minutes rediscovering this per the
// field taxonomy at ObsidianVault/References/dev-browser-taxonomy).
export function assertAddInitScriptSupported(): never {
  throw new Error(
    "addInitScript() is not supported in the QuickJS sandbox, in any input form (function, " +
      "string, { content }, or { path }) — it fails deep in the sandbox's protocol bridge with " +
      "an opaque error. Inject your script via page.evaluate() after navigation instead, e.g. " +
      "`await page.goto(url); await page.evaluate(() => { /* your init code */ });`. If you " +
      "need the script to run before the page's own scripts, evaluate it against a blank page " +
      "before navigating, or re-apply it after each navigation."
  );
}
