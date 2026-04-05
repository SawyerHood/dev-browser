# Forked Playwright Client

## What this is

This directory is a forked subset of Playwright's client-side code, adapted to run inside the QuickJS WASM sandbox used by dev-browser.

The goal is simple:

- sandboxed user scripts should get normal Playwright client objects like `Page`, `Frame`, `Locator`, and `ElementHandle`
- the sandbox should not get direct access to the host filesystem, processes, sockets, or browser ownership

The fork sits on the client side only. The real browser, dispatcher graph, and browser lifecycle stay on the host side.

```text
User script
  -> QuickJS sandbox
  -> forked Playwright client
  -> transport bridge
  -> host Playwright dispatcher
  -> real Playwright
  -> browser
```

Relevant local paths:

```text
bundle-entry.ts
quickjs-platform.ts
src/client/*
src/protocol/*
src/utils/isomorphic/*
types/*
../quickjs-sandbox.ts
../host-bridge.ts
../protocol-bridge.ts
../sandbox-transport.ts
```

## Why we forked it

Upstream Playwright client code is not a drop-in fit for QuickJS:

- it assumes Node.js APIs such as `fs`, `path`, and stream types
- it expects upstream transports like WebSocket or Playwright's local pipe helpers
- it includes surfaces that do not make sense in the sandbox, such as Android, Electron, downloads/artifacts-to-disk, and local utility helpers

The fork lets dev-browser keep the Playwright object model and protocol semantics while replacing the runtime assumptions around it.

## Source version and provenance

This fork now tracks Playwright `v1.59.1` from the official upstream repository.

- `../../../package.json` declares:

```json
"playwright": "1.59.1",
"playwright-core": "1.59.1"
```

- The vendored client files in this directory were refreshed from upstream tag `v1.59.1`.
- That tag resolves to commit `d466ac5358cae058cdc75d2ae3ab3ad220042730`.
- The older research notes at `/Users/sawyerhood/.middleman/notes/dev-browser/research/playwright-fork-sandbox.md` refer to an earlier snapshot and should be treated as historical context only.

When updating, diff against the exact upstream tag or commit you choose. Keep the pinned package version and the vendored fork in sync.

Upstream path mapping for this fork:

```text
src/client/*               <- packages/playwright-core/src/client/*
src/protocol/channels.d.ts <- packages/protocol/src/channels.d.ts
src/protocol/*             <- packages/playwright-core/src/protocol/*
src/utils/isomorphic/*     <- packages/playwright-core/src/utils/isomorphic/*
types/*                    <- packages/playwright-core/types/*
```

## Change tiers

### Tier 1: verbatim

Strict byte-for-byte copies are rare in this fork because most `.ts` files add `// @ts-nocheck` and/or replace monorepo alias imports with local relative imports.

Strict verbatim file list:

```text
types/structs.d.ts
```

Everything else should be treated as fork-maintained, even when the runtime logic is effectively upstream.

### Tier 2: modified

These files have intentional behavior changes or important local wiring:

- `quickjs-platform.ts`
  - new file
  - provides a minimal `Platform` implementation for QuickJS
  - supplies colors, GUID generation, a lightweight pseudo-SHA1, noop zones/logging, and throws for Node-only APIs like `fs`, `path`, and streams

- `bundle-entry.ts`
  - new file
  - esbuild entry point for the sandbox bundle
  - exports `Connection`, `quickjsPlatform`, and the public client-side types used by the sandbox loader

- `src/client/platform.ts`
  - re-exports `quickjsPlatform`
  - replaces upstream monorepo alias imports with local relative imports so this directory can bundle standalone

- `src/client/connection.ts`
  - defaults `new Connection()` to `quickjsPlatform`
  - keeps the client object graph local to this fork by importing `../protocol/channels` instead of upstream monorepo aliases
  - still creates Android/Electron objects when the protocol says they exist, but those classes are stubbed locally

- `src/client/browserType.ts`
  - hard-disables `browserType.connect()` and `browserType.launchPersistentContext()`
  - keeps browser ownership on the host side instead of letting sandboxed code launch or attach directly
  - leaves `launch()` and `connectOverCDP()` in place for the protocol surface, subject to host policy

- `src/client/fileUtils.ts`
  - replaces upstream filesystem helpers with sandbox-safe behavior
  - `mkdirIfNeeded()` becomes a noop
  - `writeTempFile()` delegates to `globalThis.writeFile`, which is injected by `../quickjs-sandbox.ts`

- `src/client/page.ts`
  - intercepts `page.screenshot({ path })`
  - strips `path` before sending the protocol request
  - saves the returned buffer through `writeTempFile()` so sandboxed code never writes host paths directly

- `src/client/elementHandle.ts`
  - same screenshot-path interception as `src/client/page.ts`

- `src/client/browserContext.ts`
  - removes `Debugger` wiring from the client-side initializer
  - replaces upstream `@recorder/actions` imports with local `types/recorder-actions.d.ts`

- `src/protocol/channels.d.ts`
  - vendored locally from Playwright's protocol package
  - kept here so the fork bundles without depending on the upstream monorepo layout

- `src/protocol/validator.ts`
  - local validator snapshot matching the vendored protocol/types in this directory

- `types/protocol.d.ts`
- `types/types.d.ts`
  - vendored type declarations that preserve the normal Playwright API surface inside the sandbox
  - note that the types intentionally still describe some APIs that later throw at runtime because the runtime is stubbed

- `src/client/connect.ts`
  - copied into the fork, but it is not the main QuickJS transport path
  - the sandbox path constructs `Connection` directly in `../quickjs-sandbox.ts` and pumps protocol JSON through `../host-bridge.ts`

- Most other `.ts` files in `src/client/`, `src/protocol/`, and `src/utils/isomorphic/`
  - mechanical edits only
  - mainly `// @ts-nocheck` plus replacing upstream aliases like `@protocol/*`, `@isomorphic/*`, and `@recorder/*` with local relative imports

### Tier 3: stubbed

These files keep the object graph and type surface intact, but replace the implementation with empty or throwing behavior:

```text
src/client/android.ts
src/client/artifact.ts
src/client/electron.ts
src/client/fetch.ts
src/client/harRouter.ts
src/client/localUtils.ts
src/client/screencast.ts
src/client/stream.ts
src/client/tracing.ts
src/client/video.ts
src/client/writableStream.ts
types/recorder-actions.d.ts
```

Why they are stubbed:

- Android and Electron are not part of the sandbox execution model
- artifacts, streams, tracing, and HAR helpers assume filesystem or stream access the sandbox does not have
- `APIRequest` and `LocalUtils` would otherwise pull in more host capabilities than this sandbox should expose
- `types/recorder-actions.d.ts` exists only to satisfy local type imports from `src/client/browserContext.ts`

Related note:

- `src/client/download.ts` is not itself stubbed, but it delegates to `Artifact`, so download file access is effectively unsupported in the sandbox

### Tier 4: skipped

These upstream files are intentionally not copied into this fork:

```text
src/client/DEPS.list
src/protocol/DEPS.list
src/protocol/callMetadata.d.ts
src/protocol/progress.d.ts
src/protocol/protocol.yml
src/utils/isomorphic/DEPS.list
src/utils/isomorphic/trace/DEPS.list
src/utils/isomorphic/trace/entries.ts
src/utils/isomorphic/trace/snapshotRenderer.ts
src/utils/isomorphic/trace/snapshotServer.ts
src/utils/isomorphic/trace/snapshotStorage.ts
src/utils/isomorphic/trace/traceLoader.ts
src/utils/isomorphic/trace/traceModel.ts
src/utils/isomorphic/trace/traceModernizer.ts
src/utils/isomorphic/trace/traceUtils.ts
src/utils/isomorphic/trace/versions/traceV3.ts
src/utils/isomorphic/trace/versions/traceV4.ts
src/utils/isomorphic/trace/versions/traceV5.ts
src/utils/isomorphic/trace/versions/traceV6.ts
src/utils/isomorphic/trace/versions/traceV7.ts
src/utils/isomorphic/trace/versions/traceV8.ts
```

Why they are skipped:

- `DEPS.list` and protocol generator inputs are monorepo/build metadata, not runtime requirements for the sandbox bundle
- the trace viewer and trace model helpers are not needed to expose the Playwright page automation surface inside QuickJS

## `quickjs-platform.ts`

`quickjs-platform.ts` exists because upstream Playwright expects a `Platform` object and QuickJS is neither Node nor a browser runtime in the way Playwright assumes.

It does three important things:

- provides the small cross-cutting utilities the client always needs
- explicitly throws for host features the sandbox must not get
- gives `Connection` a safe default runtime via `src/client/connection.ts`

The file is intentionally small. If you are adding a new path-based or stream-based API to the sandbox, this is one of the first places to inspect.

## `bundle-entry.ts`

`bundle-entry.ts` is the esbuild entry point for the fork.

It does not try to recreate the published `playwright` package. It exports only the client-side pieces the sandbox loader needs:

```text
Connection
quickjsPlatform
Browser
BrowserContext
Frame
Locator
Page
Playwright
```

`../quickjs-sandbox.ts` loads the built bundle, evaluates it inside QuickJS, and captures the resulting `__PlaywrightClient` global.

## `stubs/`

There is currently no `stubs/` directory in this fork.

Stubbed behavior lives inline in the files listed under Tier 3 instead.

## How the bundle works

Build inputs and outputs:

```text
entry point: bundle-entry.ts
build script: ../../../scripts/bundle-sandbox-client.ts
output: ../../../dist/sandbox-client.js
format: IIFE
global: __PlaywrightClient
platform: neutral
target: es2022
```

Rebuild command:

```bash
cd daemon && pnpm run bundle:sandbox-client
```

The build uses `platform: "neutral"` on purpose. This code is not a normal Node bundle and not a normal browser bundle. It is a self-contained client bundle that QuickJS can evaluate safely.

## Architecture context

The fork is only one piece of the stack:

```text
User script
  -> QuickJS sandbox
  -> forked Playwright client
  -> transport bridge
  -> host Playwright dispatcher
  -> real Playwright
  -> browser
```

Concrete local pieces:

- `../quickjs-sandbox.ts` loads `../../../dist/sandbox-client.js`, installs host callbacks like `writeFile`, and creates the sandbox-side `Connection`
- `../host-bridge.ts` owns the host-side `DispatcherConnection`, `RootDispatcher`, and `PlaywrightDispatcher`
- `../protocol-bridge.ts` wires both sides together
- `../sandbox-transport.ts` shows the same shape in the pure Node test bridge

One subtle but important detail:

- the QuickJS transport path does not go through `src/client/browserType.connect()`
- instead, the sandbox creates `Connection` directly and exchanges raw Playwright protocol messages with the host bridge

That is why `browserType.connect()` is stubbed even though the sandbox still has a transport bridge.

## How to update the fork

1. Clone Playwright at the exact target tag or commit you want to adopt.

   Do not rely only on `../../../package.json`. Pick one concrete upstream revision first.

2. Diff the upstream files against this directory.

   Compare at least these upstream paths:

   ```text
   packages/playwright-core/src/client/*
   packages/playwright-core/src/protocol/*
   packages/playwright-core/src/utils/isomorphic/*
   packages/playwright-core/types/*
   packages/protocol/src/channels.d.ts
   ```

3. Reapply the local fork changes while keeping upstream behavior where possible.

   The most conflict-prone files are:

   ```text
   quickjs-platform.ts
   bundle-entry.ts
   src/client/connection.ts
   src/client/platform.ts
   src/client/browserType.ts
   src/client/fileUtils.ts
   src/client/page.ts
   src/client/elementHandle.ts
   src/client/browserContext.ts
   src/client/artifact.ts
   src/client/fetch.ts
   src/client/localUtils.ts
   src/client/harRouter.ts
   src/client/tracing.ts
   src/client/android.ts
   src/client/electron.ts
   src/client/stream.ts
   src/client/writableStream.ts
   src/protocol/channels.d.ts
   src/protocol/validator.ts
   types/types.d.ts
   types/protocol.d.ts
   types/recorder-actions.d.ts
   ```

   These are the places where upstream changes are most likely to collide with sandbox-specific behavior.

4. Rebuild the sandbox client bundle.

   ```bash
   cd daemon && pnpm run bundle:sandbox-client
   ```

5. Run the daemon test suite.

   ```bash
   cd daemon && pnpm vitest run
   ```

6. Update the version/provenance section in this README.

   Record the new upstream tag or commit and keep any package-version mismatch explicit.

## Practical rules

- Prefer copying upstream code first, then reapplying the sandbox edits.
- Keep new unsupported features stubbed explicitly instead of silently half-working.
- If an upstream change touches screenshot path handling, `Platform`, or protocol type generation, expect manual merge work.
- If you add a new stubbed surface, keep the runtime error message explicit so sandbox users fail fast.
