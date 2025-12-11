---
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

# Dev Browser Skill

Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally. Once you've proven out part of a workflow and there is repeated work to be done, you can write a script to do the repeated work in a single execution.

## Choosing Your Approach

**Local/source-available sites**: If you have access to the source code (e.g., localhost or project files), read the code first to write selectors directly—no need for multi-script discovery.

**Unknown page layouts**: If you don't know the structure of the page, use `getAISnapshot()` to discover elements and `selectSnapshotRef()` to interact with them. The ARIA snapshot provides semantic roles (button, link, heading) and stable refs that persist across script executions.

**Visual feedback**: Take screenshots to see what the user sees and iterate on design or debug layout issues.

## Setup

First, start the dev-browser server using the startup script:

```bash
./skills/dev-browser/server.sh &
```

The script will automatically install dependencies and start the server. It will also install Chromium on first run if needed.

### Flags

The server script accepts the following flags:

- `--headless` - Start the browser in headless mode (no visible browser window). Use if the user asks for it.

**Wait for the `Ready` message before running scripts.** On first run, the server will:

- Install dependencies if needed
- Download and install Playwright Chromium browser
- Create the `tmp/` directory for scripts
- Create the `profiles/` directory for browser data persistence

The first run may take longer while dependencies are installed. Subsequent runs will start faster.

**Important:** Scripts must be run with `bun x tsx` (not `bun run`) due to Playwright WebSocket compatibility.

The server starts a Chromium browser with a REST API for page management (default: `http://localhost:9222`).

## How It Works

1. **Server** launches a persistent Chromium browser and manages named pages via REST API
2. **Client** connects to the HTTP server URL and requests pages by name
3. **Pages persist** - the server owns all page contexts, so they survive client disconnections
4. **State is preserved** - cookies, localStorage, DOM state all persist between runs

## Writing Scripts

Execute scripts inline using heredocs—no need to write files for one-off automation:

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect } from "@/client.js";
const client = await connect("http://localhost:9222");
const page = await client.page("main");
// Your automation code here
await client.disconnect();
EOF
```

**Only write to `tmp/` files when:**

- The script needs to be reused multiple times
- The script is complex and you need to iterate on it
- The user explicitly asks for a saved script

### Basic Template

Use the `@/client.js` import path for all scripts.

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("main"); // get or create a named page

// Your automation code here
await page.goto("https://example.com");
await waitForPageLoad(page); // Wait for page to fully load

// Always evaluate state at the end
const title = await page.title();
const url = page.url();
console.log({ title, url });

// Disconnect so the script exits (page stays alive on the server)
await client.disconnect();
EOF
```

### Key Principles

1. **Small scripts**: Each script should do ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Always log/return state at the end to decide next steps
3. **Use page names**: Use descriptive names like `"checkout"`, `"login"`, `"search-results"`
4. **Disconnect to exit**: Call `await client.disconnect()` at the end of your script so the process exits cleanly. Pages persist on the server.
5. **Plain JS in evaluate**: Always use plain JavaScript inside `page.evaluate()` callbacks—never TypeScript. The code runs in the browser which doesn't understand TS syntax.

### Important Notes

- **tsx runs without type-checking**: Scripts run with `bun x tsx` which transpiles TypeScript but does NOT type-check. Type errors won't prevent execution—they're just ignored.
- **No TypeScript in browser context**: Code passed to `page.evaluate()`, `page.evaluateHandle()`, or similar methods runs in the browser. Use plain JavaScript only:

```typescript
// ✅ Correct: plain JavaScript in evaluate
const text = await page.evaluate(() => {
  return document.body.innerText;
});

// ❌ Wrong: TypeScript syntax in evaluate (will fail at runtime)
const text = await page.evaluate(() => {
  const el: HTMLElement = document.body; // TS syntax - don't do this!
  return el.innerText;
});
```

## Workflow Loop

Follow this pattern for complex tasks:

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

## Client API

```typescript
const client = await connect("http://localhost:9222");
const page = await client.page("name"); // Get or create named page
const pages = await client.list(); // List all page names
await client.close("name"); // Close a page
await client.disconnect(); // Disconnect (pages persist)

// ARIA Snapshot methods for element discovery and interaction
const snapshot = await client.getAISnapshot("name"); // Get ARIA accessibility tree
const element = await client.selectSnapshotRef("name", "e5"); // Get element by ref
```

The `page` object is a standard Playwright Page—use normal Playwright methods.

## Waiting

Use `waitForPageLoad(page)` after navigation (checks document.readyState and network idle):

```typescript
import { waitForPageLoad } from "@/client.js";

// Preferred: Wait for page to fully load
await waitForPageLoad(page);

// Wait for specific elements
await page.waitForSelector(".results");

// Wait for specific URL
await page.waitForURL("**/success");
```

## Inspecting Page State

### Screenshots

Take screenshots when you need to visually inspect the page:

```typescript
await page.screenshot({ path: "tmp/screenshot.png" });
await page.screenshot({ path: "tmp/full.png", fullPage: true });
```

### ARIA Snapshot (Element Discovery)

Use `getAISnapshot()` when you don't know the page layout and need to discover what elements are available. It returns a YAML-formatted accessibility tree with:

- **Semantic roles** (button, link, textbox, heading, etc.)
- **Accessible names** (what screen readers would announce)
- **Element states** (checked, disabled, expanded, etc.)
- **Stable refs** that persist across script executions

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.goto("https://news.ycombinator.com");
await waitForPageLoad(page);

// Get the ARIA accessibility snapshot
const snapshot = await client.getAISnapshot("main");
console.log(snapshot);

await client.disconnect();
EOF
```

#### Example Output

The snapshot is YAML-formatted with semantic structure:

```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
    - link "past" [ref=e3]
    - link "comments" [ref=e4]
    - link "ask" [ref=e5]
    - link "submit" [ref=e6]
  - link "login" [ref=e7]
- main:
  - list:
    - listitem:
      - link "Article Title Here" [ref=e8]
      - text: "528 points by username 3 hours ago"
      - link "328 comments" [ref=e9]
- contentinfo:
  - textbox [ref=e10]
    - /placeholder: "Search"
```

#### Interpreting the Snapshot

- **Roles** - Semantic element types: `button`, `link`, `textbox`, `heading`, `listitem`, etc.
- **Names** - Accessible text in quotes: `link "Click me"`, `button "Submit"`
- **`[ref=eN]`** - Element reference for interaction. Only assigned to visible, clickable elements
- **`[checked]`** - Checkbox/radio is checked
- **`[disabled]`** - Element is disabled
- **`[expanded]`** - Expandable element (details, accordion) is open
- **`[level=N]`** - Heading level (h1=1, h2=2, etc.)
- **`/url:`** - Link URL (shown as a property)
- **`/placeholder:`** - Input placeholder text

#### Interacting with Refs

Use `selectSnapshotRef()` to get a Playwright ElementHandle for any ref:

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.goto("https://news.ycombinator.com");
await waitForPageLoad(page);

// Get the snapshot to see available refs
const snapshot = await client.getAISnapshot("main");
console.log(snapshot);
// Output shows: - link "new" [ref=e2]

// Get the element by ref and click it
const element = await client.selectSnapshotRef("main", "e2");
await element.click();

await waitForPageLoad(page);
console.log("Navigated to:", page.url());

await client.disconnect();
EOF
```

## Debugging Tips

1. **Use getAISnapshot** to see what elements are available and their refs
2. **Take screenshots** when you need visual context
3. **Use waitForSelector** before interacting with dynamic content
4. **Check page.url()** to confirm navigation worked

## Error Recovery

If a script fails, the page state is preserved. You can:

1. Take a screenshot to see what happened
2. Check the current URL and DOM state
3. Write a recovery script to get back on track

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.screenshot({ path: "tmp/debug.png" });
console.log({
  url: page.url(),
  title: await page.title(),
  bodyText: await page.textContent("body").then((t) => t?.slice(0, 200)),
});

await client.disconnect();
EOF
```
