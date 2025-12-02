---
name: dev-browser
description: Browser automation with persistent page state. Use when testing websites, debugging web apps, taking screenshots, filling forms, or automating browser interactions.
---

# Dev Browser Skill

A browser automation skill that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally.

## Setup

First, install dependencies and start the dev-browser server:

You should make sure to run it in the background

```bash
cd dev-browser && bun run start-server &
```

**Important:** Scripts must be run with `bun x tsx` (not `bun run`) due to Playwright WebSocket compatibility:

The server starts a Chromium browser and exposes a WebSocket endpoint (default: `ws://127.0.0.1:9222/...`). Clients connect directly to this endpoint.

## How It Works

1. **Server** launches a persistent Chromium browser server
2. **Client** connects directly via WebSocket and manages named pages locally
3. **Pages persist** - you can run multiple scripts against the same page
4. **State is preserved** - cookies, localStorage, DOM state all persist between runs

## Writing Scripts

Write scripts to `tmp/` with unique names (e.g., `navigate-login.ts`, `fill-form.ts`) and run them with `bun x tsx tmp/<script-name>.ts`.

Make sure the tmp directory exists:

```bash
mkdir -p tmp
```

### Basic Template

Always use the package name `dev-browser/client`.

```typescript
import { connect } from "dev-browser/client";

const client = await connect("ws://127.0.0.1:9222/<guid>");
const page = await client.page("main"); // get or create a named page

// Your automation code here
await page.goto("https://example.com");

// Always evaluate state at the end
const title = await page.title();
const url = page.url();
console.log({ title, url });

// Don't close - keep page alive for next script
```

**Note:** The WebSocket URL is printed when the server starts. Use the full URL from the server output.

### Key Principles

1. **Small scripts**: Each script should do ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Always log/return state at the end to decide next steps
3. **Use page names**: Use descriptive names like `"checkout"`, `"login"`, `"search-results"`
4. **Don't close**: Never call `client.disconnect()` or `page.close()` unless done

## Workflow Loop

Follow this pattern for complex tasks:

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

### Example: Login Flow

**Step 1: Navigate to login page**

```typescript
import { connect } from "dev-browser/client";

const client = await connect("ws://127.0.0.1:9222/<guid>");
const page = await client.page("auth");

await page.goto("https://example.com/login");

// Check state
const hasLoginForm = (await page.$("form#login")) !== null;
console.log({ url: page.url(), hasLoginForm });
```

**Step 2: Fill credentials** (after confirming login form exists)

```typescript
import { connect } from "dev-browser/client";

const client = await connect("ws://127.0.0.1:9222/<guid>");
const page = await client.page("auth");

await page.fill('input[name="email"]', "user@example.com");
await page.fill('input[name="password"]', "password123");
await page.click('button[type="submit"]');

// Wait for navigation and check state
await page.waitForLoadState("networkidle");
const url = page.url();
const isLoggedIn = url.includes("/dashboard");
console.log({ url, isLoggedIn });
```

**Step 3: Verify success** (if needed)

```typescript
import { connect } from "dev-browser/client";

const client = await connect("ws://127.0.0.1:9222/<guid>");
const page = await client.page("auth");

const welcomeText = await page.textContent("h1");
const userMenu = (await page.$(".user-menu")) !== null;
console.log({ welcomeText, userMenu, success: userMenu });
```

## Common Operations

### Navigation

```typescript
await page.goto("https://example.com");
await page.goBack();
await page.reload();
```

### Clicking

```typescript
await page.click("button.submit");
await page.click('a:has-text("Sign Up")');
await page.click("nav >> text=Products");
```

### Form Filling

```typescript
await page.fill('input[name="email"]', "test@example.com");
await page.selectOption("select#country", "US");
await page.check('input[type="checkbox"]');
```

### Waiting

```typescript
await page.waitForSelector(".results");
await page.waitForLoadState("networkidle");
await page.waitForURL("**/success");
await page.waitForTimeout(1000); // avoid if possible
```

### Extracting Data

```typescript
const text = await page.textContent(".message");
const html = await page.innerHTML(".container");
const value = await page.inputValue("input#search");
const items = await page.$$eval(".item", (els) =>
  els.map((e) => e.textContent)
);
```

### Screenshots

```typescript
await page.screenshot({ path: "tmp/screenshot.png" });
await page.screenshot({ path: "tmp/full.png", fullPage: true });
```

### Evaluating JavaScript

```typescript
const result = await page.evaluate(() => {
  return document.querySelectorAll(".item").length;
});
```

## Managing Pages

```typescript
// List all pages (local to this client connection)
const pages = await client.list();
console.log(pages); // ["main", "auth", "checkout"]

// Close a specific page when done
await client.close("checkout");
```

## Debugging Tips

1. **Take screenshots** when unsure of page state
2. **Log selectors** before clicking to verify they exist
3. **Use waitForSelector** before interacting with dynamic content
4. **Check page.url()** to confirm navigation worked

## Error Recovery

If a script fails, the page state is preserved. You can:

1. Take a screenshot to see what happened
2. Check the current URL and DOM state
3. Write a recovery script to get back on track

```typescript
// Recovery script - check current state
// Save as dev-browser/tmp/debug-state.ts and run with: bun x tsx tmp/debug-state.ts
import { connect } from "dev-browser/client";

const client = await connect("ws://127.0.0.1:9222/<guid>");
const page = await client.page("main");

await page.screenshot({ path: "tmp/debug.png" });
console.log({
  url: page.url(),
  title: await page.title(),
  bodyText: await page.textContent("body").then((t) => t?.slice(0, 200)),
});
```
