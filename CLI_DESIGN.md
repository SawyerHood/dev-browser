# Dev-Browser CLI Redesign

A design doc for restructuring dev-browser from a collection of scripts into a standalone CLI with an embedded daemon. The core model stays the same -- you write and run Playwright scripts -- but the daemon is managed automatically instead of manually.

## Current State vs. Target

### What dev-browser is today

- A library (`src/index.ts`, `src/client.ts`) exposed via npm scripts
- Users write Playwright scripts that import `connect()` and call `client.page()`
- Server started manually with `npm run start-server`
- Two modes: launch mode (own Chromium) and extension mode (relay to Chrome extension)
- ARIA snapshot system for LLM-friendly page inspection

### What we want

A single `dev-browser` CLI where:

1. The daemon is invisible -- auto-starts on first script run, persists across runs
2. Scripts are the primary interface (`dev-browser run script.ts`)
3. A few management commands exist for the daemon and pages, nothing more
4. Extension mode remains available as a flag

The user never thinks about starting or stopping servers. They write a script, run it, and the browser is there.

---

## Architecture

```
User
  │
  ▼
┌──────────────────────────────────┐
│  dev-browser CLI (Node.js)       │
│                                  │
│  dev-browser run script.ts       │
│  dev-browser pages               │
│  dev-browser stop                │
│  dev-browser status              │
└──────────────┬───────────────────┘
               │
               │  1. Ensure daemon is running (auto-start if not)
               │  2. Execute script in-process, connected to daemon's browser
               │
               ▼
┌──────────────────────────────────────┐
│  Daemon Process (background Node.js) │
│                                      │
│  • HTTP API (existing, on port 9222) │
│  • Auto-launches Chromium on demand  │
│  • Page registry (named pages)       │
│  • PID file for lifecycle mgmt       │
│  • Graceful shutdown on stop/signal  │
└──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│  Playwright + Chromium               │
│  (persistent context)                │
└──────────────────────────────────────┘
```

### Key difference from agent-browser

Agent-browser sends individual commands (click, fill, snapshot) over a socket to a daemon. We don't need that. Our scripts run Playwright directly via CDP -- the daemon just keeps the browser alive and tracks named pages. The existing HTTP API is sufficient for page management; no new socket protocol needed.

### Why keep the HTTP API (not switch to sockets)

- The current HTTP API already works and the client library already speaks it
- Scripts connect to the browser via CDP (WebSocket), not through the daemon's API
- The HTTP API is only used for lightweight page management (create/list/close)
- Extension mode relay already uses HTTP + WebSocket
- No benefit to a socket protocol when the heavy lifting (Playwright automation) goes directly over CDP

---

## Daemon Lifecycle

### File Layout

```
~/.dev-browser/
├── default.pid        # PID file for default session
├── default.log        # Daemon stdout/stderr log
├── my-session.pid     # PID file for named session
├── my-session.log
└── profiles/
    └── default/       # Persistent browser profile (cookies, localStorage)
```

Configurable via `DEV_BROWSER_HOME` env var (default: `~/.dev-browser`).

### Auto-Start

When the CLI runs a script and no daemon is running:

1. CLI checks for PID file, verifies process is alive
2. If no daemon: spawn one as a detached child process
   - `child_process.spawn('node', ['daemon.js'], { detached: true, stdio: ['ignore', logFd, logFd] })`
   - Write PID file
3. CLI polls `http://localhost:{port}/` with backoff until daemon responds (max ~3s)
4. CLI proceeds with the original command

### Stop

The daemon stays alive indefinitely. It shuts down on:

- `dev-browser stop` command (sends shutdown request to HTTP API, or kills PID)
- SIGTERM / SIGINT to the daemon process

No idle timeout by default. The browser stays warm for the next script.

### Session Isolation

Support `--session <name>` for isolated browser instances:

```bash
dev-browser run script.ts --session agent1
dev-browser run script.ts --session agent2
# Two separate daemons, separate browsers, separate state
```

Each session gets its own daemon process, PID file, port, and profile directory.

---

## Commands

Only the essentials. No verb commands for clicking/filling/typing -- that's what scripts are for.

### `dev-browser run <script.ts> [flags]`

The primary command. Runs a Playwright script against the daemon's browser.

```bash
dev-browser run ./login.ts
dev-browser run ./scrape.ts --page products
dev-browser run ./test.ts --session staging --headed
```

**How it works:**

1. CLI ensures daemon is running (auto-starts if needed)
2. CLI uses the existing `connect()` client to attach to the daemon
3. CLI gets or creates the target page (via `client.page(name)`)
4. CLI dynamically imports the user's script
5. Script's default export receives the `DevBrowserClient` and the active `Page`
6. Script runs to completion
7. CLI disconnects; page and browser persist

**Script interface:**

```typescript
// login.ts
import type { DevBrowserClient } from "dev-browser";
import type { Page } from "playwright";

export default async function (client: DevBrowserClient, page: Page) {
  await page.goto("https://app.com/login");
  await page.fill("#email", "user@example.com");
  await page.fill("#password", "secret");
  await page.click("button[type=submit]");

  // Snapshot for AI consumption
  const snapshot = await client.getAISnapshot("main");
  console.log(snapshot);
}
```

Scripts get the full `DevBrowserClient` (with `getAISnapshot`, `selectSnapshotRef`, `page()`, `list()`, `close()`) plus the active Playwright `Page`. This preserves the current workflow exactly -- the only change is how you start the script.

**Before (today):**
```bash
npm run start-server          # manual step, easy to forget
npx tsx ./login.ts            # script must call connect() itself
```

**After:**
```bash
dev-browser run ./login.ts    # daemon auto-starts, script gets a connected page
```

### `dev-browser pages`

List all named pages managed by the daemon.

```bash
dev-browser pages
# main       https://app.com/dashboard
# products   https://app.com/products
```

### `dev-browser close <name>`

Close a specific named page.

```bash
dev-browser close products
```

### `dev-browser stop`

Shut down the daemon and close the browser.

```bash
dev-browser stop
dev-browser stop --session agent1   # Stop a specific session
```

### `dev-browser status`

Show whether the daemon is running, what port, how many pages.

```bash
dev-browser status
# Daemon running (PID 12345) on port 9222
# Browser: Chromium 131.0 (headed)
# Pages: 2 (main, products)
# Profile: ~/.dev-browser/profiles/default
```

### `dev-browser start`

Explicitly start the daemon without running a script. Useful if you want the browser open before writing scripts.

```bash
dev-browser start
dev-browser start --headed --session dev
```

---

## Global Flags

| Flag | Description |
|------|-------------|
| `--session <name>` | Use named session (default: "default") |
| `--profile <path>` | Persistent browser profile directory |
| `--headed` | Show browser window (default: headless) |
| `--page <name>` | Target page name for `run` command (default: "main") |
| `--port <n>` | Daemon port (default: 9222) |
| `--extension` | Use extension mode (relay) instead of launching browser |

Environment variable overrides:

| Env Var | Maps To |
|---------|---------|
| `DEV_BROWSER_SESSION` | `--session` |
| `DEV_BROWSER_PROFILE` | `--profile` |
| `DEV_BROWSER_HEADED` | `--headed` |
| `DEV_BROWSER_HOME` | Base directory for PID/log/profile files |
| `DEV_BROWSER_PORT` | `--port` |

---

## Script API

Scripts export a default async function. The CLI calls it with two arguments:

```typescript
export default async function (client: DevBrowserClient, page: Page): Promise<void>
```

### `DevBrowserClient` (existing, unchanged)

```typescript
interface DevBrowserClient {
  page(name: string, options?: PageOptions): Promise<Page>;
  list(): Promise<string[]>;
  close(name: string): Promise<void>;
  disconnect(): Promise<void>;
  getAISnapshot(name: string): Promise<string>;
  selectSnapshotRef(name: string, ref: string): Promise<ElementHandle | null>;
  getServerInfo(): Promise<ServerInfo>;
}
```

### `Page` (Playwright, unchanged)

Full Playwright `Page` object. Scripts can do anything Playwright supports.

### Script output

- `console.log()` output goes to stdout as normal
- `console.error()` goes to stderr
- Return value is ignored
- Thrown errors cause non-zero exit code + error message on stderr
- For structured output (AI agents), scripts should `console.log(JSON.stringify(...))` themselves

### Script resolution

- Relative paths resolved from cwd: `dev-browser run ./script.ts`
- Absolute paths: `dev-browser run /path/to/script.ts`
- TypeScript supported via `tsx` (already a dependency)

---

## What Changes from Current Codebase

### Keep (unchanged)

- **`src/client.ts`**: The connect/page/snapshot client -- this IS the script API
- **`src/snapshot/`**: ARIA snapshot engine
- **`src/types.ts`**: Shared types
- **`src/relay.ts`**: Extension mode relay

### Refactor

- **`src/index.ts`** (server): Extract into a `serve()` function that can be called by the daemon entry point. Most of this code stays the same -- it already does what we need (launch browser, HTTP API, page registry). The main change is removing the Express dependency in favor of the existing Hono setup, and making it daemonizable.

### Add

- **`src/cli.ts`**: Argument parser, daemon lifecycle (start/stop/status), script executor
- **`src/daemon.ts`**: Entry point for the daemon process. Calls `serve()`, writes PID file, handles signals.
- **`bin/dev-browser`**: `#!/usr/bin/env node` shim that loads `cli.ts`

### Remove

- **`scripts/start-server.ts`**: Replaced by `dev-browser start` / auto-start
- **`scripts/start-relay.ts`**: Absorbed into daemon with `--extension` flag
- **`server.sh`**: No longer needed

---

## File Structure (Target)

```
skills/dev-browser/
├── bin/
│   └── dev-browser.js          # #!/usr/bin/env node → loads src/cli.ts
├── src/
│   ├── cli.ts                  # Arg parsing, daemon mgmt, script runner
│   ├── daemon.ts               # Daemon entry point (called as detached child)
│   ├── server.ts               # Refactored from index.ts: serve(), HTTP API
│   ├── client.ts               # Unchanged: connect(), DevBrowserClient
│   ├── types.ts                # Unchanged + add CLI-specific types
│   ├── relay.ts                # Unchanged: extension mode
│   └── snapshot/               # Unchanged
│       ├── index.ts
│       └── browser-script.ts
├── test/
│   ├── cli.test.ts
│   ├── daemon.test.ts
│   └── snapshot/               # Existing tests
├── package.json                # Add "bin" field
├── tsconfig.json
└── vitest.config.ts
```

### package.json changes

```jsonc
{
  "name": "dev-browser",
  "bin": {
    "dev-browser": "./bin/dev-browser.js"
  },
  "scripts": {
    "start-server": "npx tsx src/daemon.ts",  // Backward compat
    "dev": "npx tsx --watch src/daemon.ts",
    "test": "vitest run"
  }
}
```

---

## Implementation Phases

### Phase 1: Daemon extraction

Refactor `src/index.ts` into `src/server.ts` (the `serve()` function) and `src/daemon.ts` (the process entry point that calls `serve()`, writes PID, handles signals). Verify existing tests still pass and scripts still work via `npx tsx src/daemon.ts`.

### Phase 2: CLI shell

Build `src/cli.ts` and `bin/dev-browser.js`. Implement:
- `dev-browser start` (spawn daemon)
- `dev-browser stop` (kill daemon)
- `dev-browser status` (check PID)
- `dev-browser pages` (hit HTTP API)
- `dev-browser close <name>` (hit HTTP API)

At this point the daemon is auto-managed but scripts are still run with `npx tsx`.

### Phase 3: Script runner

Implement `dev-browser run <script.ts>`:
- Auto-start daemon
- Import user script
- Call `connect()`, get page, invoke script's default export
- Handle errors, exit codes

### Phase 4: Polish

- `--session` support (multiple daemons)
- `--extension` mode
- `--headed` flag
- Log file management
- Help text (`dev-browser --help`)
- Stale PID cleanup

---

## Open Questions

1. **Should scripts be required to export a default function, or should they also work as standalone scripts that call `connect()` themselves?** Supporting both means the CLI can't inject the page, but we could detect whether the script has a default export and branch accordingly. Backward compatibility argues for supporting both.

2. **Should `dev-browser run` use `tsx` under the hood or require pre-compiled JS?** Using `tsx` (already a dev dependency) is simpler and matches the current workflow. Could add a `--loader` flag if someone needs a different TypeScript runner.

3. **Port allocation for multiple sessions.** Default session uses 9222. Named sessions need unique ports. Options: auto-assign from a range (9222+N), hash the session name to a port, or let the user specify with `--port`.

4. **Should the CLI be published as a standalone npm package?** Currently it lives inside `skills/dev-browser/`. Publishing to npm as `dev-browser` would let users do `npx dev-browser run script.ts` without cloning the repo. This is a distribution question, not an architecture one.
