---
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

# Dev Browser Skill

Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally. Once you've proven out part of a workflow and there is repeated work to be done, you can write a script to do the repeated work in a single execution.

## Choosing Your Approach

**Local/source-available sites**: If you have access to the source code (e.g., localhost or project files), read the code first to write selectors directly—no need for multi-script discovery.

**External sites**: Without source code, use `getLLMTree()` to discover elements and `getSelectorForID()` to get selectors. These work alongside standard Playwright methods.

**Visual feedback**: Take screenshots to see what the user sees and iterate on design or debug layout issues.

## Setup

First, start the dev-browser server. It will automatically install Chromium on first run if needed:

```bash
cd skills/dev-browser && bun run start-server &
```

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

### LLM Tree (Structured DOM Inspection)

For a structured, text-based view of the page, use `getLLMTree()`. This returns a human-readable representation of interactive elements on the page, making it easier to understand page structure without parsing raw HTML.

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

await page.goto("https://news.ycombinator.com");
await waitForPageLoad(page);

// Get the LLM-friendly DOM tree
const tree = await client.getLLMTree("main");
console.log(tree);

await client.disconnect();
EOF
```

#### Example Output

The tree output shows interactive elements with numbered indices:

```
[1]<a href="https://news.ycombinator.com" />
[2]<a href="news">Hacker News</a>
[3]<a href="newest">new</a>
[4]<a href="front">past</a>
[5]<a href="newcomments">comments</a>
[6]<a href="ask">ask</a>
[7]<a href="submit">submit</a>
[8]<a href="login?goto=news">login</a>
1.
[9]<a id="up_46134443" href="vote?id=46134443&how=up&goto=news" />
[10]<div class="votearrow" title="upvote" />
[11]<a href="https://www.example.com/article">Article Title Here</a>
528 points
by
[12]<a class="hnuser" href="user?id=username">username</a>
[13]<a href="item?id=46134443">3 hours ago</a>
[14]<a href="item?id=46134443">328 comments</a>
...
[256]<input type="text" name="q" autocomplete="off" />
```

#### Interpreting the Tree

- **`[N]`** - Interactive elements are numbered. Use these indices with `getSelectorForID()` to get CSS selectors
- **`<tag attr="value">text</tag>`** - Element tag, key attributes, and text content
- **Plain text** - Static text content between elements (e.g., "528 points", "by")
- **`|SCROLL|`** - Marks scrollable containers with scroll position info
- **`|IFRAME|`** - Marks iframe boundaries
- **`|SHADOW(open)|`** - Marks shadow DOM roots

### Getting Selectors for Interaction

Once you identify an element by its index in the tree, use `getSelectorForID()` to get a CSS selector you can use with Playwright:

```bash
cd skills/dev-browser && bun x tsx <<'EOF'
import { connect } from "@/client.js";

const client = await connect("http://localhost:9222");
const page = await client.page("main");

// First, get the tree to see what's on the page
const tree = await client.getLLMTree("main");
console.log(tree);
// Output shows: [11]<a href="...">Article Title Here</a>

// Get the selector for element 11
const selector = await client.getSelectorForID("main", 11);
console.log(selector); // e.g., "a:nth-of-type(3)" or "#article-link"

// Now use that selector with Playwright
await page.click(selector);

await client.disconnect();
EOF
```

### When to Use Each Approach

| Method          | Best For                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| **Screenshots** | Visual debugging, seeing layout/styling issues, sharing with humans             |
| **LLM Tree**    | Understanding page structure, finding interactive elements, text-based analysis |
| **Selectors**   | Programmatically interacting with elements found in the tree                    |

## Debugging Tips

1. **Use getLLMTree** for a structured view of interactive elements
2. **Take screenshots** when you need visual context
3. **Log selectors** before clicking to verify they exist
4. **Use waitForSelector** before interacting with dynamic content
5. **Check page.url()** to confirm navigation worked

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
