# dev-browser Cheat Sheet

> Complete reference for all CLI commands, sandbox globals, Playwright Page API, and built-in tools.

---

## Installation

```bash
npm install -g dev-browser      # install CLI
dev-browser install             # download Playwright + Chromium
dev-browser install-skill       # install skill for Claude Code / Codex
```

**From source:**
```bash
bash scripts/install-dev.sh     # build + install everything from this repo
```

**Permissions for Claude Code** — add to `.claude/settings.json`:
```json
{ "permissions": { "allow": ["Bash(dev-browser *)"] } }
```

---

## CLI Flags

```
dev-browser [FLAGS] [SUBCOMMAND] [< script.js | <<'EOF' ... EOF]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--browser NAME` | `default` | Named browser instance (separate state per name) |
| `--connect [URL]` | — | Connect to running Chrome; omit URL to auto-discover |
| `--headless` | off | Launch Chromium without a visible window |
| `--ignore-https-errors` | off | Ignore TLS/cert errors (useful for local dev) |
| `--timeout SECONDS` | `30` | Max script execution time |

**Examples:**
```bash
dev-browser <<'EOF'                      # default browser, stdin script
dev-browser --headless < script.js       # headless, file input
dev-browser --browser myapp <<'EOF'      # named browser instance
dev-browser --connect <<'EOF'            # auto-connect to running Chrome
dev-browser --connect http://localhost:9222 <<'EOF'   # specific CDP endpoint
dev-browser --timeout 60 run script.js  # longer timeout
```

---

## CLI Subcommands

| Command | Description |
|---------|-------------|
| `dev-browser run FILE` | Run a .js script file |
| `dev-browser install` | Download Playwright + Chromium |
| `dev-browser install-skill` | Install skill into `~/.claude/skills` / `~/.agents/skills` |
| `dev-browser install-skill --claude` | Install to Claude Code only |
| `dev-browser install-skill --agents` | Install to Agents/Codex only |
| `dev-browser browsers` | List all managed browser instances |
| `dev-browser status` | Show daemon PID, uptime, browser count |
| `dev-browser stop` | Gracefully stop the daemon |

---

## Sandbox Globals

Scripts run in a **QuickJS WASM sandbox** — not Node.js.
These are NOT available: `require`, `import`, `process`, `fs`, `fetch`, `__dirname`.

| Global | Type | Description |
|--------|------|-------------|
| `browser` | object | Browser control (pages, tabs) |
| `network` | object | Request mocking + traffic log |
| `screenshot` | object | Visual regression baselines |
| `recording` | object | Record interactions → Playwright tests |
| `secrets` | object | Register sensitive values for output redaction |
| `session` | object | Save/restore auth state |
| `errors` | object | Collect console errors, JS exceptions, network failures |
| `audit` | object | Accessibility (axe-core) + Core Web Vitals |
| `scenario` | object | Multi-page orchestration: parallel, race, barrier, observe |
| `saveScreenshot(buf, name)` | async fn | Save screenshot buffer to `~/.dev-browser/tmp/` |
| `writeFile(name, data)` | async fn | Write file to `~/.dev-browser/tmp/` |
| `readFile(name)` | async fn | Read file from `~/.dev-browser/tmp/` |
| `console.log/warn/error/info` | fn | Output to CLI stdout/stderr |
| `setTimeout / clearTimeout` | fn | Standard timers |

---

## `browser` — Browser Control

```javascript
// Get or create a named page (persists between script runs)
const page = await browser.getPage("main");

// Create an anonymous page (auto-closed when script ends)
const page = await browser.newPage();

// List all open tabs
const tabs = await browser.listPages();
// → [{ id, url, title, name }]

// Close a named page
await browser.closePage("main");
```

**Tip:** Named pages survive server restarts within the same session. Use descriptive names: `"login"`, `"dashboard"`, `"results"`.

---

## Playwright `page` — Full API

### Navigation
```javascript
await page.goto(url)                          // Navigate; default waitUntil: "load"
await page.goto(url, { waitUntil: "networkidle" })
await page.goto(url, { waitUntil: "domcontentloaded" })
await page.reload()
await page.goBack()
await page.goForward()
page.url()                                    // Current URL (sync)
await page.title()                            // Page title
```

### Waiting
```javascript
await page.waitForURL("**/dashboard")         // Glob pattern
await page.waitForURL(/dashboard/)            // Regex
await page.waitForSelector(".spinner", { state: "hidden" })
await page.waitForSelector(".results", { state: "visible" })
await page.waitForLoadState("networkidle")
await page.waitForLoadState("domcontentloaded")
await page.waitForFunction(() => document.readyState === "complete")
await page.waitForTimeout(1000)               // Fixed delay (avoid if possible)
```

### Finding Elements — Locators (preferred)
```javascript
page.getByRole("button", { name: "Submit" })
page.getByRole("link", { name: "Home" })
page.getByRole("textbox", { name: "Email" })
page.getByRole("checkbox", { name: "Remember me" })
page.getByRole("heading", { name: "Welcome" })
page.getByLabel("Password")
page.getByText("Sign in")
page.getByText("Sign in", { exact: true })
page.getByPlaceholder("Search...")
page.getByAltText("Company logo")
page.getByTitle("Close dialog")
page.getByTestId("submit-btn")               // data-testid attribute
page.locator(".my-class")                    // CSS selector
page.locator("//div[@class='box']")          // XPath
```

### Locator Chaining
```javascript
page.locator(".list").getByRole("listitem").first()
page.locator(".card").filter({ hasText: "Pro plan" })
page.locator(".card").nth(2)
page.locator(".card").last()
page.locator("form").locator("input[type=email]")
```

### Interacting
```javascript
await page.click(selector)
await page.dblclick(selector)
await page.fill(selector, value)             // Clear + type (recommended for inputs)
await page.type(selector, text)              // Type character by character
await page.press(selector, "Enter")
await page.press(selector, "Tab")
await page.press(selector, "Control+a")
await page.check(selector)                  // Check checkbox/radio
await page.uncheck(selector)
await page.selectOption(selector, "value")
await page.selectOption(selector, { label: "Option label" })
await page.hover(selector)
await page.focus(selector)
await page.tap(selector)                    // Touch tap

// Locator actions (same methods on locator objects)
await page.getByRole("button", { name: "OK" }).click()
await page.getByLabel("Email").fill("user@example.com")
await page.getByRole("checkbox").check()
```

### Reading Content
```javascript
await page.textContent(selector)            // Text content of element
await page.innerText(selector)              // Visible text
await page.innerHTML(selector)             // Inner HTML
await page.inputValue(selector)            // Value of input/textarea
await page.getAttribute(selector, "href")
await page.isVisible(selector)             // → boolean
await page.isEnabled(selector)             // → boolean
await page.isChecked(selector)             // → boolean
await page.isHidden(selector)              // → boolean
```

### JavaScript in Page Context
```javascript
// Run JS in the page — must use plain JS, no TypeScript
const result = await page.evaluate(() => document.title)
const val = await page.evaluate(sel => document.querySelector(sel)?.textContent, ".price")
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

// Run on all matching elements
const texts = await page.$$eval("li", els => els.map(el => el.textContent))

// Run on first matching element
const href = await page.$eval("a.logo", el => el.href)

// Expose a Node.js function to the page
await page.exposeFunction("myFn", (arg) => arg.toUpperCase())
```

### Screenshots & PDF
```javascript
const buf = await page.screenshot()
const buf = await page.screenshot({ fullPage: true })
const buf = await page.screenshot({ path: "/tmp/snap.png" })
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 300 } })

// Save using the sandbox helper
const path = await saveScreenshot(buf, "snapshot.png")
console.log(path)   // ~/.dev-browser/tmp/snapshot.png

// Element screenshot
const buf = await page.locator(".chart").screenshot()
```

### Frames & Popups
```javascript
// All frames
const frames = page.frames()
const frame = page.frame({ name: "my-iframe" })
const frame = page.frame({ url: "**/embed*" })

// Run inside a frame
await frame.fill("#search", "query")
await frame.click("button")

// Wait for popup
const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  page.click("a[target=_blank]"),
])
await popup.waitForLoadState()
```

### Dialogs
```javascript
// Handle alert/confirm/prompt before triggering
page.once("dialog", dialog => dialog.accept())
page.once("dialog", dialog => dialog.dismiss())
page.once("dialog", dialog => dialog.accept("input text"))
await page.click("#trigger-alert")
```

### AI Snapshots (dev-browser extension)
```javascript
// Get AI-optimized accessibility snapshot
const snap = await page.snapshotForAI()
console.log(snap.full)              // Full snapshot string for element discovery

// Incremental tracking (only changes since last call)
const snap = await page.snapshotForAI({ track: "main" })
console.log(snap.incremental)

// Options
await page.snapshotForAI({ depth: 5, timeout: 5000 })
```

---

## Playwright CLI (Linux)

### Installation

```bash
# Install Playwright + test runner into your project
npm init playwright@latest
npm install -D @playwright/test

# Install browsers
npx playwright install                     # all browsers
npx playwright install chromium            # only Chromium
npx playwright install chromium firefox    # multiple browsers
npx playwright install --with-deps         # also install OS dependencies

# Install specific browser with system deps
npx playwright install chromium --with-deps
npx playwright install msedge

# List installed browsers
npx playwright install --dry-run

# Uninstall browsers
npx playwright uninstall chromium
```

### Running Tests

```bash
# Run all tests
npx playwright test

# Run a specific file
npx playwright test tests/login.spec.ts

# Run a specific test by name
npx playwright test -g "should log in"

# Run tests in a directory
npx playwright test tests/auth/

# Run with a specific browser
npx playwright test --browser chromium
npx playwright test --browser firefox
npx playwright test --browser webkit

# Run in headed mode (see the browser window)
npx playwright test --headed

# Run with workers (parallel)
npx playwright test --workers 4
npx playwright test --workers 1            # serial, useful for debugging

# Repeat / retry
npx playwright test --retries 2            # retry failed tests up to 2 times
npx playwright test --repeat-each 3        # run each test 3 times

# Timeout
npx playwright test --timeout 60000        # per-test timeout in ms

# Fail fast
npx playwright test --max-failures 5       # stop after 5 failures
```

### Debug Mode

```bash
# Open Playwright Inspector (step through tests)
npx playwright test --debug
npx playwright test tests/login.spec.ts --debug

# Debug a specific test
npx playwright test -g "should log in" --debug

# Run with PWDEBUG env var
PWDEBUG=1 npx playwright test
PWDEBUG=console npx playwright test        # log to terminal instead of Inspector

# Slow down execution (ms between actions)
npx playwright test --slow-mo 500

# UI Mode — interactive test explorer with time travel
npx playwright test --ui
```

### Code Generation

```bash
# Record interactions and generate test code
npx playwright codegen https://example.com

# Generate code for a specific browser
npx playwright codegen --browser firefox https://example.com

# Save output to a file
npx playwright codegen https://example.com -o tests/recorded.spec.ts

# Emulate a device
npx playwright codegen --device "iPhone 13" https://example.com

# Set viewport
npx playwright codegen --viewport-size 1280,720 https://example.com

# Record with auth (cookies/localStorage saved to file)
npx playwright codegen --save-storage auth.json https://example.com

# Use saved auth
npx playwright codegen --load-storage auth.json https://example.com
```

### Screenshots & PDF (CLI)

```bash
# Take a screenshot
npx playwright screenshot https://example.com screenshot.png

# Full page screenshot
npx playwright screenshot --full-page https://example.com full.png

# Specific browser
npx playwright screenshot --browser firefox https://example.com ff.png

# Save PDF (Chromium only)
npx playwright pdf https://example.com output.pdf
```

### Reports

```bash
# Show last HTML report in browser
npx playwright show-report

# Show report from a specific path
npx playwright show-report playwright-report/

# Run tests and output results as JSON
npx playwright test --reporter json > results.json

# Run tests with multiple reporters
npx playwright test --reporter=html,line

# Available reporters:
#   list        — default terminal output
#   line        — single-line progress
#   dot         — minimal dots
#   html        — HTML report (opens automatically on failure)
#   json        — JSON file
#   junit       — JUnit XML (for CI)
#   github      — GitHub Actions annotations
```

### Trace Viewer

```bash
# Run tests and record traces
npx playwright test --trace on           # always record
npx playwright test --trace retain-on-failure  # only on failure (default)
npx playwright test --trace off

# Open trace file in browser
npx playwright show-trace trace.zip
npx playwright show-trace test-results/my-test/trace.zip
```

### UI Mode — Interactive Test Explorer

Playwright UI Mode is a full visual interface for running, filtering, and debugging tests with time-travel.

```bash
# Open UI Mode
npx playwright test --ui

# Open UI Mode on a specific port
npx playwright test --ui --ui-port 8080

# Open UI Mode on all interfaces (useful for remote/WSL access)
npx playwright test --ui --ui-host 0.0.0.0 --ui-port 8080

# Open UI Mode for a specific project only
npx playwright test --ui --project chromium

# Open UI Mode with a specific config
npx playwright test --ui --config playwright.staging.config.ts
```

**What you can do inside UI Mode:**

| Feature | How |
|---------|-----|
| Run all tests | Click the ▶ Run button |
| Run a single test | Click ▶ next to the test name |
| Filter tests by name | Type in the search box |
| Filter by file / project | Use the sidebar tree |
| Watch mode | Toggle the eye icon — reruns on file save |
| Time-travel debugging | Click any action in the trace timeline to jump to that moment |
| DOM snapshot | Click an action → see the DOM at that exact point |
| Network tab | See all requests during the test |
| Console tab | See console output per action |
| Source tab | See the test code with the current line highlighted |
| Screenshots | View before/after screenshot for each action |
| Pick locator | Click the target icon → click on the page → get the locator code |

**Keyboard shortcuts inside UI Mode:**

| Shortcut | Action |
|----------|--------|
| `F5` | Run selected tests |
| `Ctrl+R` | Rerun last run |
| `Ctrl+F` | Filter / search tests |
| `Esc` | Stop running tests |

**Watch mode** — automatically reruns tests when you save a file:
```bash
# Enable watch in UI Mode (toggle the eye icon in the toolbar)
# Or start with watch already on:
npx playwright test --ui
# Then click the 👁 Watch icon in the top bar
```

**Trace Viewer inside UI Mode:**
- Every test run automatically records a trace
- Click any test → see the full action timeline
- Click any step → DOM snapshot, network, console at that moment
- Hover over the timeline → scrub through the test

**Standalone Trace Viewer** (without UI Mode):
```bash
# View a saved trace file
npx playwright show-trace test-results/my-test-chromium/trace.zip

# View a trace from a URL
npx playwright show-trace https://example.com/trace.zip
```

---

### Misc

```bash
# Print version
npx playwright --version

# Print Playwright config
npx playwright test --list              # list all test files and titles

# Clear browser caches
npx playwright clear-cache

# Run with custom config file
npx playwright test --config=playwright.staging.config.ts

# Run in CI (no retries, no interactive output)
CI=true npx playwright test
```

### `playwright.config.ts` — Key Options

```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,               // per-test timeout
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",

  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
    { name: "webkit",   use: { ...devices["Desktop Safari"] } },
    { name: "mobile",   use: { ...devices["iPhone 13"] } },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
```

### Test File Structure

```typescript
import { test, expect } from "@playwright/test";

// Basic test
test("page title", async ({ page }) => {
  await page.goto("https://example.com");
  await expect(page).toHaveTitle(/Example/);
});

// Group with describe
test.describe("Login", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("successful login", async ({ page }) => {
    await page.fill('[name="email"]', "user@example.com");
    await page.fill('[name="password"]', "password");
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(/dashboard/);
  });

  test("wrong password shows error", async ({ page }) => {
    await page.fill('[name="email"]', "user@example.com");
    await page.fill('[name="password"]', "wrong");
    await page.click('[type="submit"]');
    await expect(page.getByText("Invalid credentials")).toBeVisible();
  });
});

// Reuse saved auth state (storageState)
test.use({ storageState: ".dev-browser/sessions/admin.json" });

// Skip / only
test.skip("not ready yet", async ({ page }) => { ... });
test.only("focus this one", async ({ page }) => { ... });

// Conditional skip
test("linux only", async ({ page }) => {
  test.skip(process.platform !== "linux", "Linux only");
  ...
});
```

---

## `network` — Request Mocking

```javascript
// Mock a URL pattern — all requests matching the glob are intercepted
await network.mock("/api/users", {
  body: [{ id: 1, name: "Alice" }],   // response body (object → JSON, string → text)
  status: 200,                         // HTTP status (default: 200)
  contentType: "application/json",     // default: inferred from body type
  headers: { "X-Custom": "value" },   // extra response headers
  delay: 1500,                         // artificial latency in ms
  times: 3,                            // limit to first N requests, then pass through
})

// Clear a specific mock
await network.clearMocks("/api/users")

// Clear all mocks
await network.clearMocks()

// Get request log
const log = await network.getLog()
// log entries: [{ url, method, status, mocked, duration, timestamp,
//                resourceType, requestHeaders, responseHeaders,
//                requestBody, responseBody }]

// Filtered log
const log = await network.getLog({
  mockedOnly: true,          // only mocked requests
  failedOnly: true,          // only status >= 400 or network errors
  urlPattern: "/api/",       // substring match
  limit: 20,                 // max entries
})

// Clear log
await network.clearLog()
```

**Pattern:** Set up mocks BEFORE `page.goto()` so they are in place when the page loads.

---

## `screenshot` — Visual Regression

```javascript
// Save baseline (first run, or after intentional UI change)
await screenshot.baseline(page, "homepage")
await screenshot.baseline(page, "hero", { element: ".hero-section" })
await screenshot.baseline(page, "fold", { clip: { x: 0, y: 0, width: 1280, height: 800 } })
await screenshot.baseline(page, "full", { fullPage: true })

// Compare against saved baseline
const result = await screenshot.compare(page, "homepage")
const result = await screenshot.compare(page, "homepage", { threshold: 0.01 })
// result: { match, diffPercentage, diffPixelCount, diffImagePath,
//           currentImagePath, baselineImagePath, summary }

// Update baseline after intentional design change
await screenshot.updateBaseline(page, "homepage")

// List all saved baselines
const baselines = await screenshot.listBaselines()
// baselines: [{ name, path, width, height, createdAt }]
```

**Storage:**
- Baselines: `~/.dev-browser/baselines/{name}.png`
- Diffs: `~/.dev-browser/diffs/{name}-diff.png`

---

## `recording` — Generate Playwright Tests

```javascript
// 1. Start recording
recording.start()
recording.start({ testName: "User signup", outputFile: "signup.spec.ts" })

// 2. Wrap page to capture all interactions
const rPage = recording.wrap(page)

// 3. Interact using the wrapped page (same API as regular page)
await rPage.goto("http://localhost:3000/signup")
await rPage.getByLabel("Email").fill("test@example.com")
await rPage.getByLabel("Password").fill("Secret123")
await rPage.getByRole("button", { name: "Create Account" }).click()
await rPage.waitForURL("**/dashboard")

// 4. Add assertion checkpoints (captures URL + title)
await recording.checkpoint("Redirected to dashboard after signup", rPage)

// 5. Stop and get generated test
const result = await recording.stop()
console.log(result.code)          // generated Playwright .spec.ts source
console.log(result.filePath)      // path if outputFile was set
console.log(JSON.stringify(result.stats))
// stats: { actions, assertions, duration }
```

---

## `secrets` — Output Redaction

Register sensitive values once per script run. The daemon then replaces them with
`[REDACTED:NAME]` in everything that leaves the sandbox as text.

```javascript
// Value injected by the runner, never written into the script source
await secrets.register("APP_LOGIN", globalThis.APP_LOGIN)

await rPage.getByLabel("Password").fill(globalThis.APP_LOGIN)
console.log("typed", globalThis.APP_LOGIN)   // → typed [REDACTED:APP_LOGIN]
```

| Output | Behaviour |
|--------|-----------|
| `console.*` | value replaced with `[REDACTED:NAME]` |
| `writeFile(name, text)` | text replaced before writing |
| thrown script errors | message and stack replaced, error name kept |
| `recording.stop()` | a fill of exactly the value becomes `process.env.NAME!`; other occurrences become `[REDACTED:NAME]` |

- Name must match `/^[A-Za-z_][A-Za-z0-9_]*$/`; value must be a non-empty string.
- Registration lasts for one script run — register again at the top of every script.
- Matches the raw value, its JSON-escaped form and its `encodeURIComponent` form.
- Not covered: screenshots and binary `writeFile` data, transformed values (base64, substrings),
  values the server issues (cookies, tokens in responses). `network.getLog()` and other return
  values reach the script unredacted; redaction applies when they are printed or written.
- Short values also redact ordinary text that happens to match them.

---

## `session` — Session Persistence

Save and restore full browser auth state (cookies, localStorage, sessionStorage) across server restarts.

### Save
```javascript
const result = await session.save("admin")

const result = await session.save("admin", {
  description: "Admin user — full access",  // human-readable label
  tags: ["admin", "role-test"],              // for filtering
  overwrite: true,                           // default: true
  includeSessionStorage: true,               // default: true
  analyzeAuth: true,                         // detect JWT/cookie type + expiry
  domains: ["localhost"],                    // filter to specific domains only
})

// result: { name, path, sizeBytes, domains, cookieCount,
//           localStorageEntries, sessionStorageEntries,
//           authType, estimatedExpiry }
```

### Restore
```javascript
const result = await session.restore("admin")

const result = await session.restore("admin", {
  clearExisting: true,          // clear cookies+localStorage first (default: true)
  validateExpiry: true,         // warn if session is expired (default: true)
  navigateToSource: false,      // auto-navigate to sourceUrl after restore
  page: "main",                 // page name to use for sessionStorage restore
})

// result: { success, name, expired, warnings[], restored:
//           { cookies, localStorageEntries, sessionStorageEntries },
//           recommendation }

if (result.expired) {
  console.log(result.recommendation)  // "Session expired. Re-login recommended."
}
```

### List
```javascript
const sessions = await session.list()

const sessions = await session.list({
  tags: ["admin"],              // filter by tags (AND)
  domain: "localhost",          // filter by domain
  sortBy: "updatedAt",          // "name" | "createdAt" | "updatedAt" | "size"
  checkExpiry: true,            // default: true
})

// sessions: [{ name, description, createdAt, updatedAt, sizeBytes,
//              domains, tags, authType, expired, estimatedExpiry }]
```

### Inspect
```javascript
const info = await session.inspect("admin")
// info.snapshot — full metadata
// info.summary:
//   totalCookies, authCookies[], localStorageByOrigin{},
//   sessionStorageByOrigin{}, jwtTokens[], expired, expiryDetails
console.log(JSON.stringify(info.summary, null, 2))
```

### Delete
```javascript
await session.delete("admin")
// → { deleted: true, name: "admin" }
```

**Storage:** `~/.dev-browser/sessions/{name}.json`

---

## `errors` — Console & Network Error Aggregation

Error listeners are **automatically attached** to every page returned by `browser.getPage()`.

```javascript
// Get all collected errors
const report = await errors.get()
// report: { entries[], summary: { total, byType, topErrors[] }, diagnostics[], pageCount }

// Filter
const report = await errors.get({
  types: ["console-error", "js-exception", "network-failure", "cors-error", "console-warn"],
  pageName: "checkout",        // only this page
  since: Date.now() - 60000,  // last 60 s
  limit: 50,                   // most recent N
  minCount: 2,                 // only errors that occurred 2+ times
})

// One-line human-readable summary (great for LLM context)
const text = await errors.summary()
// → "12 error(s) across 2 page(s)\n  console-error: 8\n  network-failure: 4\n..."

// Clear (all, or just one page)
await errors.clear()
await errors.clear("checkout")
```

**Error types:** `console-error`, `console-warn`, `js-exception`, `network-failure`, `cors-error`

Auto-deduplication: repeated identical errors increment `count` instead of adding entries.
Ring buffer: max 500 entries, oldest discarded first.

**Diagnostics** are auto-generated patterns:
- TypeError cascade → null/undefined access
- CORS errors → missing `Access-Control-Allow-Origin`
- 401/403 cascade → session expired
- 404 resources → missing assets/API paths
- Mixed content → HTTP resources on HTTPS page

---

## `audit` — Accessibility & Performance

Pass the **page name** string (same as used in `browser.getPage("name")`), not a page object.

```javascript
// ── Accessibility (axe-core, WCAG 2.1) ──────────────────────────────────────
const report = await audit.accessibility("main")
const report = await audit.accessibility("main", {
  context: "#app",                     // limit audit to a CSS selector
  tags: ["wcag2a", "wcag2aa"],         // axe rule tag sets
  disabledRules: ["color-contrast"],   // skip specific rule IDs
})
// report: {
//   url, score (0–100),
//   violations: [{ id, impact, description, help, helpUrl, nodes[] }],
//   passes, incomplete, summary
// }

// ── Performance (Core Web Vitals via browser Performance API) ───────────────
const perf = await audit.performance("main")
const perf = await audit.performance("main", { settleMs: 500 })   // wait before sampling
// perf: {
//   url, summary,
//   metrics: { lcp, fid, cls, fcp, ttfb, tbt, domInteractive,
//              domContentLoaded, loadComplete, transferSize, resourceCount },
//   ratings: { lcp: "good"|"needs-improvement"|"poor", fid, cls, fcp }
// }

// ── Full audit (both at once) ────────────────────────────────────────────────
const full = await audit.full("main")
// full: { url, accessibility, performance, summary }
```

**CWV thresholds:**

| Metric | Good | Needs improvement | Poor |
|--------|------|------------------|------|
| LCP | < 2500 ms | < 4000 ms | ≥ 4000 ms |
| FCP | < 1800 ms | < 3000 ms | ≥ 3000 ms |
| CLS | < 0.1 | < 0.25 | ≥ 0.25 |

---

## `scenario` — Multi-page Orchestration

```javascript
// ── parallel — run functions concurrently, collect all results ───────────────
const [titleA, titleB] = await scenario.parallel([
  async () => {
    const p = await browser.getPage("tab-a");
    await p.goto("https://example.com");
    return p.title();
  },
  async () => {
    const p = await browser.getPage("tab-b");
    await p.goto("https://example.org");
    return p.title();
  },
])

// ── race — return whichever resolves first ────────────────────────────────────
const first = await scenario.race([
  async () => { /* faster path */ return "a"; },
  async () => { /* slower path */ return "b"; },
])

// ── barrier — synchronise N concurrent tasks ──────────────────────────────────
const sync = scenario.barrier(2)
await scenario.parallel([
  async () => {
    const p = await browser.getPage("actor-1");
    await p.goto("http://localhost:3000/start");
    sync.signal();            // I'm ready
    await sync.wait();        // wait for everyone
    await p.getByRole("button", { name: "Go" }).click();
  },
  async () => {
    const p = await browser.getPage("actor-2");
    await p.goto("http://localhost:3000/start");
    sync.signal();
    await sync.wait();
    await p.getByRole("button", { name: "Go" }).click();
  },
])

// ── observe — collect responses + console events during fn ───────────────────
const page = await browser.getPage("main");
const { result, events } = await scenario.observe(page, async (p) => {
  await p.goto("http://localhost:3000/dashboard");
  await p.waitForLoadState("networkidle");
  return p.title();
})
// events: [{ type: "response"|"console", url?, status?, level?, text?, timestamp }]
const apiCalls = events.filter(e => e.type === "response" && e.url.includes("/api/"));
console.log(JSON.stringify({ result, apiCalls }, null, 2));
```

---

## File I/O Helpers

All paths are restricted to `~/.dev-browser/tmp/`.

```javascript
// Save a screenshot
const path = await saveScreenshot(await page.screenshot(), "home.png")

// Write arbitrary data
const path = await writeFile("results.json", JSON.stringify(data, null, 2))

// Read back
const raw = await readFile("results.json")
const data = JSON.parse(raw)
```

---

## Common Recipes

### Inspect current page
```bash
dev-browser --connect <<'EOF'
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
EOF
```

### Take a screenshot and save it
```bash
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
const path = await saveScreenshot(await page.screenshot(), "example.png");
console.log(path);
EOF
```

### Fill a login form
```bash
dev-browser <<'EOF'
const page = await browser.getPage("app");
await page.goto("http://localhost:3000/login");
await page.fill('[name="email"]', "user@example.com");
await page.fill('[name="password"]', "secret");
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard");
console.log("Logged in:", await page.title());
EOF
```

### Login once, reuse session
```bash
# First run — save session after login
dev-browser <<'EOF'
const page = await browser.getPage("app");
await page.goto("http://localhost:3000/login");
await page.fill('[name="email"]', "admin@example.com");
await page.fill('[name="password"]', "password");
await page.click('[type="submit"]');
await page.waitForURL("**/dashboard");
const r = await session.save("admin", { tags: ["admin"] });
console.log("Saved:", r.authType, "| expiry:", r.estimatedExpiry);
EOF

# All future runs — skip login
dev-browser <<'EOF'
const r = await session.restore("admin");
if (r.expired) { throw new Error(r.recommendation); }
const page = await browser.getPage("app");
await page.goto("http://localhost:3000/dashboard");
console.log(await page.title());
EOF
```

### Mock an API endpoint
```bash
dev-browser <<'EOF'
await network.mock("/api/products", { body: [], status: 200 });
const page = await browser.getPage("main");
await page.goto("http://localhost:3000/products");
const empty = await page.getByText("No products found").isVisible();
console.log("Shows empty state:", empty);
EOF
```

### Screenshot regression check
```bash
# Baseline (run once)
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("http://localhost:3000");
await screenshot.baseline(page, "home");
console.log("Baseline saved");
EOF

# Compare (run on every change)
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("http://localhost:3000");
const result = await screenshot.compare(page, "home", { threshold: 0.01 });
console.log(result.match ? "✅ No regression" : `❌ ${result.summary}`);
EOF
```

### Test multiple user roles
```bash
dev-browser <<'EOF'
// Restore admin session
await session.restore("role-admin");
const page = await browser.getPage("app");
await page.goto("http://localhost:3000/articles/1");
const canDelete = await page.getByRole("button", { name: "Delete" }).isVisible();
console.log("Admin can delete:", canDelete);

// Switch to reader session
await session.restore("role-reader");
await page.goto("http://localhost:3000/articles/1");
const readerCanDelete = await page.getByRole("button", { name: "Delete" }).isVisible();
console.log("Reader can delete:", readerCanDelete);
EOF
```

### Extract all links from a page
```bash
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
const links = await page.$$eval("a[href]", els =>
  els.map(el => ({ text: el.textContent?.trim(), href: el.href }))
);
console.log(JSON.stringify(links, null, 2));
EOF
```

### Scrape a table
```bash
dev-browser <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com/data");
const rows = await page.$$eval("table tr", rows =>
  rows.map(row =>
    Array.from(row.querySelectorAll("td,th"), cell => cell.textContent?.trim())
  )
);
console.log(JSON.stringify(rows, null, 2));
EOF
```

### Generate a Playwright test from recorded actions
```bash
dev-browser <<'EOF'
recording.start({ testName: "Checkout flow", outputFile: "checkout.spec.ts" });
const rPage = recording.wrap(await browser.getPage("shop"));
await rPage.goto("http://localhost:3000");
await rPage.getByRole("button", { name: "Add to cart" }).first().click();
await rPage.goto("http://localhost:3000/cart");
await recording.checkpoint("Cart has item", rPage);
await rPage.getByRole("button", { name: "Checkout" }).click();
const result = await recording.stop();
console.log(result.code);
EOF
```

---

## File Locations

| Path | Purpose |
|------|---------|
| `~/.dev-browser/tmp/` | Temp files from `writeFile` / `saveScreenshot` |
| `~/.dev-browser/sessions/` | Saved session snapshots |
| `~/.dev-browser/baselines/` | Screenshot baselines |
| `~/.dev-browser/diffs/` | Screenshot diff images |
| `~/.dev-browser/browsers/` | Persistent browser profiles |
| `~/.dev-browser/daemon.sock` | Daemon socket (Unix) |
| `~/.dev-browser/daemon.pid` | Daemon PID file |

---

## Daemon Management

```bash
dev-browser status       # PID, uptime, connected browsers
dev-browser browsers     # list all browser instances and their named pages
dev-browser stop         # gracefully stop daemon + all browsers
```

The daemon starts automatically on first script run and stays running between scripts. Named pages persist until you close them or stop the daemon.
