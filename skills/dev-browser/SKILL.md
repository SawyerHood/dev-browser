---
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

# Dev Browser

A CLI for controlling browsers with sandboxed JavaScript scripts.

## Usage

Run `dev-browser --help` to learn more.

## Writing Tests

When the user asks to **write a test**, **create a test**, or **automate and save** a flow,
ALWAYS do both:

1. Write and run the dev-browser script using the `recording` API so interactions are captured.
2. Save the generated Playwright `.spec.ts` file to disk.

**Template:**
```javascript
const testName = "Login flow";
const outputFile = "login.spec.ts";

recording.start({ testName, outputFile });
const page = await browser.getPage("main");
const rPage = recording.wrap(page);

await rPage.goto("https://example.com/login");
// ... interactions using rPage instead of page ...

await recording.checkpoint("Logged in", rPage);
const result = await recording.stop();
console.log("Playwright test saved to:", result.filePath);
console.log(result.code);
```

**Rules:**
- Use `rPage` (wrapped page) for all interactions, not the raw `page`.
- Add `recording.checkpoint()` at key navigation steps (after login, after form submit, etc.).
- Always pass `outputFile` to `recording.start()` so the `.spec.ts` is written to disk.
- Choose a descriptive filename matching the flow, e.g. `checkout.spec.ts`, `auth-login.spec.ts`.
- Register every sensitive value with `await secrets.register("NAME", value)` before using it.
  A recorded fill of that value is then generated as `process.env.NAME!` instead of plain text.
