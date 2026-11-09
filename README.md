<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

Brought to you by [Do Browser](https://dobrowser.io).

A browser automation tool that lets AI agents and developers control browsers with sandboxed JavaScript scripts.

**Key features:**
- **Sandboxed execution** — scripts run in a QuickJS WASM sandbox, no host filesystem or network access
- **Persistent pages** — named pages survive between script runs within the same session
- **Auto-connect** — attach to your running Chrome or launch a managed Chromium automatically
- **Full Playwright API** — `goto`, `click`, `fill`, `locator`, `evaluate`, screenshots, and everything else
- **Network mocking** — intercept and stub HTTP requests before the page loads
- **Visual regression** — save baseline screenshots and diff against them pixel-by-pixel
- **Test recording** — record agent interactions and export as Playwright `.spec.ts` tests
- **Session persistence** — save and restore cookies, localStorage, and sessionStorage across restarts
- **Error aggregation** — auto-collect console errors, JS exceptions, and network failures with diagnostics
- **Accessibility & performance audit** — axe-core WCAG audit and Core Web Vitals in one call
- **Multi-page orchestration** — `parallel`, `race`, `barrier`, `observe` helpers for coordinating pages

---

## Requirements

| Dependency | Version | Purpose |
|-----------|---------|---------|
| **Node.js** | >= 18 | Runtime for the daemon and npm install |
| **npm** | any | Installing the CLI globally |
| **Chromium** | auto-installed | Browser engine (downloaded by `dev-browser install`) |

> **Building from source** additionally requires [Rust + Cargo](https://rustup.rs) (stable).

---

## Installation

### Standard install (npm)

```bash
npm install -g dev-browser
dev-browser install          # downloads Playwright + Chromium (~150 MB)
```

### For Claude Code

```bash
bash scripts/install-claude.sh
```

What it does:
1. Checks Node.js >= 18
2. Installs `dev-browser` globally (uses `sudo` only if the npm prefix isn't user-writable)
3. Runs `dev-browser install` to download Playwright + Chromium
4. Installs the skill to `~/.claude/skills/dev-browser/`

After running, **restart Claude Code** so it picks up the new skill.

### For Codex CLI / Agents

```bash
bash scripts/install-codex.sh
```

Installs the skill to both `~/.codex/skills/dev-browser/` and `~/.agents/skills/dev-browser/`.

### From source (development)

```bash
git clone https://github.com/venosm/dev-browser
cd dev-browser
bash scripts/install-dev.sh
```

What it does:
1. Runs `pnpm install` in `daemon/`
2. Bundles the daemon (`pnpm run bundle` + `pnpm run bundle:sandbox-client`)
3. Builds and installs the Rust CLI with `cargo install`
4. Runs `dev-browser install` to download Playwright + Chromium

### Windows

```powershell
npm install -g dev-browser
dev-browser install
```

To attach to a running Chrome on Windows:
```powershell
chrome.exe --remote-debugging-port=9222
dev-browser --connect
```

Windows npm installs download the native `dev-browser-windows-x64.exe` release asset during `postinstall`, and the generated npm shims invoke that executable directly.

---

## Allow dev-browser in Claude Code

By default Claude Code prompts for approval on every `bash` command. Pre-approve `dev-browser` so it runs silently.

**Per-project** — add to `.claude/settings.json` in your project root:

```json
{
  "permissions": {
    "allow": ["Bash(dev-browser *)"]
  }
}
```

**Per-user (global)** — add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(dev-browser *)"]
  }
}
```

---

## Quick Start

```bash
# Run a one-liner against a managed Chromium
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF

# Headless (no window)
dev-browser --headless <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF

# Run a script file
dev-browser run script.js

# Connect to your running Chrome
dev-browser --connect <<'EOF'
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
EOF

# Connect to a specific CDP endpoint
dev-browser --connect http://localhost:9222 <<'EOF'
const page = await browser.getPage("main");
console.log(await page.title());
EOF
```

---

## CLI Reference

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--browser NAME` | `default` | Named browser instance — separate state per name |
| `--connect [URL]` | — | Connect to running Chrome; omit URL to auto-discover |
| `--headless` | off | Launch Chromium without a visible window |
| `--ignore-https-errors` | off | Ignore TLS/certificate errors (for local dev) |
| `--timeout SECONDS` | `30` | Max script execution time before forceful termination |

### Subcommands

| Command | Description |
|---------|-------------|
| `dev-browser run FILE` | Execute a `.js` script file |
| `dev-browser install` | Download Playwright + Chromium |
| `dev-browser install-skill` | Install skill into `~/.claude/skills` and/or `~/.agents/skills` |
| `dev-browser install-skill --claude` | Install to Claude Code only |
| `dev-browser install-skill --agents` | Install to Agents/Codex only |
| `dev-browser browsers` | List all managed browser instances and their named pages |
| `dev-browser status` | Show daemon PID, uptime, browser count |
| `dev-browser stop` | Gracefully stop the daemon and all browsers |

---

## Script API

Scripts run inside a **QuickJS WASM sandbox** — not Node.js.
`require`, `import`, `process`, `fs`, `fetch`, and `__dirname` are **not available**.

### `browser` — Browser Control

```javascript
const page = await browser.getPage("main")    // get/create named page (persists between runs)
const page = await browser.newPage()           // anonymous page (auto-closed after script)
const tabs  = await browser.listPages()        // [{id, url, title, name}]
await browser.closePage("main")                // close and unregister a named page
```

### Playwright `page` — Full API

Pages are full [Playwright Page](https://playwright.dev/docs/api/class-page) objects.

```javascript
// Navigation
await page.goto(url)
await page.goto(url, { waitUntil: "networkidle" | "domcontentloaded" | "load" | "commit" })
await page.reload()
await page.goBack()
await page.goForward()
page.url()                                         // current URL (sync)
await page.title()                                 // page title

// Waiting
await page.waitForURL("**/dashboard")              // glob or regex
await page.waitForSelector(".spinner", { state: "hidden" })
await page.waitForLoadState("networkidle")
await page.waitForFunction(() => document.readyState === "complete")

// Finding elements (locators — preferred)
page.getByRole("button", { name: "Submit" })
page.getByLabel("Email")
page.getByText("Sign in")
page.getByPlaceholder("Search...")
page.getByTestId("submit-btn")                     // data-testid
page.locator(".my-class")                          // CSS
page.locator("//div[@id='app']")                   // XPath

// Locator chaining
page.locator(".list").getByRole("listitem").first()
page.locator(".card").filter({ hasText: "Pro plan" })
page.locator(".card").nth(2)

// Interacting
await page.click(selector)
await page.fill(selector, value)                   // clear + type
await page.type(selector, text)                    // character by character
await page.press(selector, "Enter")
await page.check(selector)
await page.uncheck(selector)
await page.selectOption(selector, "value")
await page.hover(selector)

// All locator actions work the same way
await page.getByRole("button", { name: "OK" }).click()
await page.getByLabel("Email").fill("user@example.com")

// Reading content
await page.textContent(selector)
await page.innerText(selector)
await page.inputValue(selector)
await page.getAttribute(selector, "href")
await page.isVisible(selector)
await page.isEnabled(selector)
await page.isChecked(selector)

// JavaScript in page context (plain JS only, no TypeScript)
const result = await page.evaluate(() => document.title)
const texts  = await page.$$eval("li", els => els.map(e => e.textContent))
const href   = await page.$eval("a.logo", el => el.href)

// Screenshots
const buf = await page.screenshot()
const buf = await page.screenshot({ fullPage: true })
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 800, height: 600 } })
const buf = await page.locator(".chart").screenshot()
const path = await saveScreenshot(buf, "snap.png")

// AI-optimized snapshots (dev-browser extension)
const snap = await page.snapshotForAI()                        // { full, incremental? }
const snap = await page.snapshotForAI({ track: "main" })       // track changes
const snap = await page.snapshotForAI({ depth: 5, timeout: 5000 })

// Frames
const frame = page.frame({ name: "my-iframe" })
await frame.fill("#search", "query")

// Dialogs
page.once("dialog", dialog => dialog.accept())
```

### `network` — Request Mocking

```javascript
// Mock a URL pattern (set up BEFORE page.goto)
await network.mock("/api/users", {
  body: [],                          // object → JSON, string → text
  status: 200,                       // HTTP status (default 200)
  contentType: "application/json",
  headers: { "X-Custom": "value" },
  delay: 1500,                       // artificial latency in ms
  times: 3,                          // only mock first N requests
})

await network.clearMocks("/api/users")  // remove one mock
await network.clearMocks()              // remove all mocks

// Request log
const log = await network.getLog()
const log = await network.getLog({
  mockedOnly: true,
  failedOnly: true,           // status >= 400 or network error
  urlPattern: "/api/",        // substring filter
  limit: 20,
})
// log entries: { url, method, status, mocked, duration, timestamp,
//               resourceType, requestHeaders, responseHeaders,
//               requestBody, responseBody }

await network.clearLog()
```

### `screenshot` — Visual Regression

```javascript
// Save baseline (first run, or after intentional UI change)
await screenshot.baseline(page, "homepage")
await screenshot.baseline(page, "hero", { element: ".hero-section" })
await screenshot.baseline(page, "fold", { fullPage: true })
await screenshot.baseline(page, "area", { clip: { x: 0, y: 0, width: 1280, height: 800 } })

// Compare against baseline
const result = await screenshot.compare(page, "homepage")
const result = await screenshot.compare(page, "homepage", { threshold: 0.01 })
// result: { match, diffPercentage, diffPixelCount,
//           diffImagePath, currentImagePath, baselineImagePath, summary }

await screenshot.updateBaseline(page, "homepage")   // overwrite after intentional change

const list = await screenshot.listBaselines()
// list: [{ name, path, width, height, createdAt }]
```

Baselines: `~/.dev-browser/baselines/`
Diffs: `~/.dev-browser/diffs/`

### `recording` — Generate Playwright Tests

```javascript
recording.start({ testName: "Checkout flow", outputFile: "checkout.spec.ts" })

const rPage = recording.wrap(page)        // wrap to capture all interactions

await rPage.goto("http://localhost:3000")
await rPage.getByRole("button", { name: "Add to cart" }).click()
await recording.checkpoint("Item added to cart", rPage)   // captures URL + title

const result = await recording.stop()
// result: { code, filePath, stats: { actions, assertions, duration } }
console.log(result.code)
```

### `secrets` — Output Redaction

```javascript
await secrets.register("APP_LOGIN", globalThis.APP_LOGIN)   // once per script run
```

Registered values are replaced with `[REDACTED:NAME]` in console output, text written via
`writeFile`, thrown script errors and generated tests. A recorded fill of exactly the value is
generated as `process.env.NAME!`. Screenshots and binary data are not redacted — see
[CHEATSHEET.md](CHEATSHEET.md) for the full list of limits.

### `session` — Session Persistence

Save full browser auth state (cookies + localStorage + sessionStorage) across daemon restarts.

```javascript
// Save after login
const r = await session.save("admin", {
  description: "Admin user — full access",
  tags: ["admin", "role-test"],
  overwrite: true,                 // default: true
  includeSessionStorage: true,     // default: true
  analyzeAuth: true,               // auto-detect JWT/cookie type + expiry
  domains: ["localhost"],          // restrict to these domains only
})
// r: { name, path, sizeBytes, domains, cookieCount,
//      localStorageEntries, sessionStorageEntries, authType, estimatedExpiry }

// Restore at the start of any future script
const r = await session.restore("admin", {
  clearExisting: true,      // wipe existing cookies/localStorage first (default: true)
  validateExpiry: true,     // warn if expired (default: true)
  navigateToSource: false,  // auto-navigate to sourceUrl after restore
  page: "main",             // page name to use for sessionStorage restore
})
// r: { success, expired, warnings[], restored: { cookies, localStorageEntries,
//      sessionStorageEntries }, recommendation }

if (r.expired) throw new Error(r.recommendation)

// List sessions
const sessions = await session.list({ tags: ["admin"], checkExpiry: true })
// sessions: [{ name, description, createdAt, updatedAt, sizeBytes,
//              domains, tags, authType, expired, estimatedExpiry }]

// Inspect — decode JWT tokens, check cookie expiry
const info = await session.inspect("admin")
// info.summary: { totalCookies, authCookies[], localStorageByOrigin{},
//                 sessionStorageByOrigin{}, jwtTokens[], expired, expiryDetails }

await session.delete("old-session")    // → { deleted: true, name }
```

Sessions: `~/.dev-browser/sessions/`

### `errors` — Console & Network Error Aggregation

Automatically collects console errors, JS exceptions, and network failures for every named page retrieved with `browser.getPage()`. No setup required.

```javascript
// Get all collected errors
const report = await errors.get()
// report: { entries[], summary: { total, byType, topErrors[] }, diagnostics[], pageCount }

// Filter options
const report = await errors.get({
  types: ["console-error", "js-exception", "network-failure", "cors-error", "console-warn"],
  pageName: "checkout",    // restrict to one page
  since: Date.now() - 60000,  // last 60 s
  limit: 50,               // most recent N entries
  minCount: 2,             // only repeated errors
})

// LLM-friendly one-line summary
const text = await errors.summary()
// e.g. "12 error(s) across 2 page(s)\n  console-error: 8\n  network-failure: 4\nDiagnostics:\n  • CORS errors detected…"

// Clear all errors, or just for one page
await errors.clear()
await errors.clear("checkout")
```

Error types: `console-error`, `console-warn`, `js-exception`, `network-failure`, `cors-error`

### `audit` — Accessibility & Performance

```javascript
// Accessibility audit via axe-core (WCAG 2.1 A/AA)
const report = await audit.accessibility("main")
const report = await audit.accessibility("main", {
  context: "#app",                     // limit scope to a CSS selector
  tags: ["wcag2a", "wcag2aa"],         // axe rule tags
  disabledRules: ["color-contrast"],   // skip specific rules
})
// report: { url, violations[], passes, incomplete, summary, score (0–100) }

// Performance audit — Core Web Vitals via browser Performance API
const perf = await audit.performance("main")
const perf = await audit.performance("main", { settleMs: 500 })
// perf: { url, metrics: { lcp, fid, cls, fcp, ttfb, tbt, domInteractive,
//          domContentLoaded, loadComplete, transferSize, resourceCount },
//          summary, ratings: { lcp, fid, cls, fcp } }

// Both in one call
const full = await audit.full("main")
// full: { url, accessibility, performance, summary }
```

Pass the **page name** (string) — the same name used with `browser.getPage()`.

### `scenario` — Multi-page Orchestration

```javascript
// Run multiple async functions in parallel, collect all results
const [a, b] = await scenario.parallel([
  async () => { const p = await browser.getPage("tab-a"); await p.goto(urlA); return p.title(); },
  async () => { const p = await browser.getPage("tab-b"); await p.goto(urlB); return p.title(); },
])

// Return whichever resolves first
const winner = await scenario.race([
  async () => { await browser.getPage("fast"); /* ... */ return "fast"; },
  async () => { await browser.getPage("slow"); /* ... */ return "slow"; },
])

// Synchronisation barrier — wait until N signals have arrived
const sync = scenario.barrier(2)
await scenario.parallel([
  async () => { /* worker 1 */ sync.signal(); await sync.wait(); /* continue */ },
  async () => { /* worker 2 */ sync.signal(); await sync.wait(); /* continue */ },
])

// Observe a page — collect all responses and console output during fn
const { result, events } = await scenario.observe(page, async (p) => {
  await p.goto("https://example.com")
  return await p.title()
})
// events: [{ type: "response"|"console", url?, status?, level?, text?, timestamp }]
```

### File I/O

All paths are restricted to `~/.dev-browser/tmp/`.

```javascript
const path = await saveScreenshot(await page.screenshot(), "home.png")
const path = await writeFile("results.json", JSON.stringify(data))
const raw  = await readFile("results.json")
```

### Output

```javascript
console.log("message")     // → CLI stdout
console.warn("warning")    // → CLI stderr
console.error("error")     // → CLI stderr
console.info("info")       // → CLI stdout
```

---

## Scripts

All helper scripts live in `scripts/`:

| Script | Purpose |
|--------|---------|
| `scripts/install-dev.sh` | Build and install from source (requires Rust + Cargo) |
| `scripts/install-claude.sh` | Install dev-browser + Claude Code skill |
| `scripts/install-codex.sh` | Install dev-browser + Codex / Agents skill |

Run any script from the repo root:
```bash
bash scripts/install-dev.sh
bash scripts/install-claude.sh
bash scripts/install-codex.sh
```

---

## File Locations

| Path | Contents |
|------|---------|
| `~/.dev-browser/sessions/` | Saved session snapshots (`session.save`) |
| `~/.dev-browser/baselines/` | Screenshot baselines (`screenshot.baseline`) |
| `~/.dev-browser/diffs/` | Screenshot diff images (`screenshot.compare`) |
| `~/.dev-browser/tmp/` | Temp files (`writeFile`, `saveScreenshot`) |
| `~/.dev-browser/browsers/` | Persistent Chromium profiles |
| `~/.dev-browser/daemon.sock` | Daemon Unix socket |
| `~/.dev-browser/daemon.pid` | Daemon PID file |

---

## Daemon Lifecycle

The daemon starts automatically on the first script run and stays alive between invocations so that named pages and browser state persist.

```bash
dev-browser status     # PID, uptime, browser count
dev-browser browsers   # list instances and named pages
dev-browser stop       # graceful shutdown
```

---

## Building from Source

```bash
# 1. Install daemon dependencies
cd daemon && npx pnpm install

# 2. Type-check
cd daemon && npx tsc --noEmit

# 3. Run tests
cd daemon && npx pnpm vitest run

# 4. Bundle daemon (required before cargo build picks up changes)
cd daemon && npx pnpm run bundle
cd daemon && npx pnpm run bundle:sandbox-client

# 5. Build CLI
cd cli && cargo build
```

`cli/src/daemon.rs` embeds `daemon/dist/daemon.bundle.mjs` and `daemon/dist/sandbox-client.js` via `include_str!`, so **always re-bundle before `cargo build`** when daemon code changes.

---

## Benchmarks

| Method | Time | Cost | Turns | Success |
|--------|------|------|-------|---------|
| **Dev Browser** | 3m 53s | $0.88 | 29 | 100% |
| Playwright MCP | 4m 31s | $1.45 | 51 | 100% |
| Playwright Skill | 8m 07s | $1.45 | 38 | 67% |
| Claude Chrome Extension | 12m 54s | $2.81 | 80 | 100% |

_See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

---

## License

MIT

## Authors

**Fork maintained by [Milan Venos](https://github.com/venosm)** — added Test Recording & Replay, Visual Regression, Network Mocking, Multi-page Orchestration, Console & Network Error Aggregation, Session Persistence, and Accessibility & Performance Audit.

Original project by [Sawyer Hood](https://github.com/sawyerhood) — [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser).
