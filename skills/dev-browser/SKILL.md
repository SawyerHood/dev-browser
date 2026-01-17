---
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

# Dev Browser Skill

Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally. Once you've proven out part of a workflow and there is repeated work to be done, you can write a script to do the repeated work in a single execution.

## Choosing Your Approach

- **Local/source-available sites**: Read the source code first to write selectors directly
- **Unknown page layouts**: Use `getAISnapshot()` to discover elements and `selectSnapshotRef()` to interact with them
- **Visual feedback**: Take screenshots to see what the user sees

## Setup

```bash
./skills/dev-browser/server.sh &
```

**Wait for the `Ready` message before running scripts.**

The server:
- Auto-assigns a port from 19222-19300 (avoids Chrome CDP port conflicts)
- Writes the port to `tmp/port` for client discovery
- Outputs `PORT=XXXX` to stdout
- Auto-shuts down after 30 minutes of inactivity
- Cleans up stale server entries on startup

The client (`connectLite()`) auto-discovers the port in this order:
1. `DEV_BROWSER_PORT` environment variable
2. `tmp/port` file in skill directory
3. Most recent server from `~/.dev-browser/active-servers.json`
4. Default port 19222

The server uses Chrome for Testing via CDP based on configuration at `~/.dev-browser/config.json`:

- **External Browser** (default): Uses Chrome for Testing via CDP. Browser stays open after automation.
- **Standalone**: Uses Playwright's bundled Chromium. **Not recommended** - only available with explicit `--standalone` flag.

**Important**: If Chrome for Testing is not found, the server will fail with an error instead of falling back to Playwright's bundled browser. This ensures consistent browser behavior.

**Flags:**
- `--standalone` - Force standalone Playwright mode (not recommended)
- `--headless` - Run headless (standalone mode only)

### Configuration

Browser settings are configured in a `config.json` file. Dev-browser searches for this file in the following order:

1. `DEV_BROWSER_CONFIG` environment variable (explicit path)
2. `.dev-browser/config.json` in current directory or any parent (project config)
3. `$XDG_CONFIG_HOME/dev-browser/config.json` (Linux/macOS XDG)
4. `~/.config/dev-browser/config.json` (XDG default)
5. `~/.dev-browser/config.json` (legacy)

**Example config:**

```json
{
  "portRange": { "start": 19222, "end": 19300, "step": 2 },
  "cdpPort": 9223,
  "browser": {
    "mode": "auto",
    "path": "/Applications/Chrome for Testing.app"
  }
}
```

| Setting | Values | Description |
|---------|--------|-------------|
| `portRange.start` | Number (default: 19222) | First port to try for HTTP API server |
| `portRange.end` | Number (default: 19300) | Last port to try |
| `cdpPort` | Number (default: 9223) | Chrome DevTools Protocol port |
| `browser.mode` | `"auto"` (default), `"external"`, `"standalone"` | `auto` and `external` use Chrome for Testing; `standalone` uses Playwright (not recommended) |
| `browser.path` | Path string | Browser executable or .app bundle. On macOS, .app paths use `open -a` for proper Dock icon |
| `browser.userDataDir` | Path string | Browser profile directory. Defaults to `$XDG_STATE_HOME/dev-browser/chrome-profile` (Chrome requires a non-default profile for CDP debugging) |
| `browser.extraArgs` | String array | Extra command-line arguments to pass to Chrome (e.g., `["--disable-gpu"]`) |

**Auto-detection paths:**
- **macOS**: `/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
- **Linux**: `/opt/google/chrome-for-testing/chrome`, `/usr/bin/google-chrome-for-testing`
- **Windows**: `C:\Program Files\Google\Chrome for Testing\Application\chrome.exe`

#### Project-Level Configuration

Place a `.dev-browser/config.json` in your project root to use project-specific browser settings. This is useful when:

- Different projects need different Chrome installations
- Working in containers/devcontainers with custom browser paths
- Sharing browser configuration with your team via version control

#### XDG Base Directory Support

On Linux and macOS, dev-browser follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html):

| Data Type | Location |
|-----------|----------|
| Config | `$XDG_CONFIG_HOME/dev-browser/config.json` (default: `~/.config/dev-browser/`) |
| State | `$XDG_STATE_HOME/dev-browser/` (default: `~/.local/state/dev-browser/`) |

State files (like `active-servers.json`) are stored separately from config:

1. `$XDG_STATE_HOME/dev-browser/` if `XDG_STATE_HOME` is set
2. `~/.local/state/dev-browser/` if it exists
3. `~/.dev-browser/` (legacy fallback)

#### Browser Profile Behavior

Dev-browser uses a dedicated profile directory by default (`$XDG_STATE_HOME/dev-browser/chrome-profile`). This ensures:

- **Predictable behavior** - Works the same in all environments
- **CDP compatibility** - Chrome requires a non-default profile for remote debugging on Linux
- **Isolation** - Automation doesn't interfere with your regular browsing

**To use your existing browser profile** (for logged-in sessions, extensions, etc.):

```json
{
  "browser": {
    "userDataDir": "/path/to/your/chrome/profile"
  }
}
```

Common profile locations:
- **macOS**: `~/Library/Application Support/Google/Chrome`
- **Linux**: `~/.config/google-chrome`
- **Windows**: `%LOCALAPPDATA%\Google\Chrome\User Data`

**Note**: Using your default profile may cause conflicts if Chrome is already running.

#### Environment Variable Override

Set `DEV_BROWSER_CONFIG` to explicitly specify a config file path:

```bash
DEV_BROWSER_CONFIG=/path/to/config.json ./server.sh
```

This takes highest priority and is useful for CI/CD pipelines or container environments.

#### WSL2 and Container Environments

Chrome may crash with `SIGILL` (illegal instruction) when rendering GPU-accelerated content in WSL2 or containerized environments. This happens because GPU virtualization doesn't properly expose all CPU features to Chrome's rendering code.

**Symptoms:**
- Chrome launches and simple pages work
- Complex pages with canvas/WebGL crash with "Error code: SIGILL"
- dmesg shows: `trap invalid opcode` in chrome process

**Fix:** Add GPU-disabling flags via `extraArgs`:

```json
{
  "browser": {
    "path": "/opt/google/chrome/google-chrome",
    "extraArgs": [
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
      "--no-sandbox"
    ]
  }
}
```

| Flag | Purpose |
|------|---------|
| `--disable-gpu` | Disable GPU hardware acceleration |
| `--disable-software-rasterizer` | Disable software fallback for GPU |
| `--disable-dev-shm-usage` | Use /tmp instead of /dev/shm (fixes container memory issues) |
| `--no-sandbox` | Disable Chrome sandbox (required in some containers, security tradeoff) |

**When to use:** WSL2 with WSLg, Docker containers, devcontainers, or any virtualized Linux environment where GPU passthrough is incomplete.

**When NOT needed:** Native Linux, macOS, Windows native, or headless mode.

### Extension Mode

Connects to user's existing Chrome browser. Use this when:

- The user is already logged into sites and wants you to do things behind an authed experience that isn't local dev.
- The user asks you to use the extension

**Important**: The core flow is still the same. You create named pages inside of their browser.

**Start the relay server:**

```bash
cd skills/dev-browser && npm i && npm run start-extension &
```

Wait for `Waiting for extension to connect...`

**Workflow:**

1. Scripts call `client.page("name")` just like the normal mode to create new pages / connect to existing ones.
2. Automation runs on the user's actual browser session

If the extension hasn't connected yet, tell the user to launch and activate it. Download link: https://github.com/SawyerHood/dev-browser/releases

## Writing Scripts

> **Run all scripts from `skills/dev-browser/` directory.** The `@/` import alias requires this directory's config.

Execute scripts inline using heredocs:

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connectLite } from "@/client-lite.js";

const client = await connectLite();
await client.page("example"); // descriptive name like "cnn-homepage"
await client.setViewportSize("example", 1280, 800);

await client.navigate("example", "https://example.com");

const info = await client.getInfo("example");
console.log({ title: info.title, url: info.url });
await client.disconnect();
EOF
```

**Write to `tmp/` files only when** the script needs reuse, is complex, or user explicitly requests it.

### Key Principles

1. **Small scripts**: Each script does ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Log/return state at the end to decide next steps
3. **Descriptive page names**: Use `"checkout"`, `"login"`, not `"main"`
4. **Disconnect to exit**: `await client.disconnect()` - pages persist on server
5. **Plain JS in evaluate**: `client.evaluate()` runs in browser - no TypeScript syntax

## Workflow Loop

Follow this pattern for complex tasks:

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

### No TypeScript in Browser Context

Code passed to `client.evaluate()` runs in the browser, which doesn't understand TypeScript:

```typescript
// ✅ Correct: plain JavaScript
const text = await client.evaluate("mypage", `
  document.body.innerText
`);

// ❌ Wrong: TypeScript syntax will fail at runtime
const text = await client.evaluate("mypage", `
  const el: HTMLElement = document.body; // Type annotation breaks in browser!
  el.innerText;
`);
```

## Scraping Data

For scraping large datasets, intercept and replay network requests rather than scrolling the DOM. See [references/scraping.md](references/scraping.md) for the complete guide covering request capture, schema discovery, and paginated API replay.

## Client API

```typescript
import { connectLite } from "@/client-lite.js";

const client = await connectLite();
await client.page("name");              // Get or create named page
const pages = await client.list();      // List all page names
await client.close("name");             // Close a page
await client.disconnect();              // Disconnect (pages persist)

// ARIA Snapshot methods
const snapshot = await client.getAISnapshot("name");    // Get accessibility tree
const refInfo = await client.selectRef("name", "e5");   // Get element info by ref
await client.click("name", "e5");                       // Click element by ref
await client.fill("name", "e5", "text");                // Fill input by ref
```

## Waiting

```typescript
// After navigation
await client.navigate("name", "https://example.com", "networkidle");

// For specific elements
await client.waitForSelector("name", ".results");
await client.waitForSelector("name", ".modal", { state: "hidden", timeout: 5000 });
```

## Inspecting Page State

### Screenshots

```typescript
import { writeFileSync } from "fs";

const result = await client.screenshot("name");
writeFileSync("tmp/screenshot.png", Buffer.from(result.screenshot, "base64"));

const full = await client.screenshot("name", { fullPage: true });
writeFileSync("tmp/full.png", Buffer.from(full.screenshot, "base64"));
```

### ARIA Snapshot (Element Discovery)

Use `getAISnapshot()` to discover page elements. Returns YAML-formatted accessibility tree:

```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
- main:
  - list:
    - listitem:
      - link "Article Title" [ref=e8]
      - link "328 comments" [ref=e9]
- contentinfo:
  - textbox [ref=e10]
    - /placeholder: "Search"
```

**Interpreting refs:**

- `[ref=eN]` - Element reference for interaction (visible, clickable elements only)
- `[checked]`, `[disabled]`, `[expanded]` - Element states
- `[level=N]` - Heading level
- `/url:`, `/placeholder:` - Element properties

**Interacting with refs:**

```typescript
const snapshot = await client.getAISnapshot("hackernews");
console.log(snapshot); // Find the ref you need

// Get info about an element
const refInfo = await client.selectRef("hackernews", "e2");
console.log(refInfo); // { found: true, tagName: "A", textContent: "..." }

// Click or fill
await client.click("hackernews", "e2");
await client.fill("hackernews", "e10", "search query");
```

## Error Recovery

Page state persists after failures. Debug with:

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connectLite } from "@/client-lite.js";
import { writeFileSync } from "fs";

const client = await connectLite();
await client.page("hackernews");

const shot = await client.screenshot("hackernews");
writeFileSync("tmp/debug.png", Buffer.from(shot.screenshot, "base64"));

const info = await client.getInfo("hackernews");
const bodyText = await client.evaluate("hackernews", "document.body.innerText.slice(0, 200)");

console.log({
  url: info.url,
  title: info.title,
  bodyText,
});

await client.disconnect();
EOF
```
