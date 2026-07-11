---
name: dev-browser
description: Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", or any browser interaction request.
---

# Dev Browser

A CLI for controlling browsers with sandboxed JavaScript scripts. Pages behave like Playwright Page objects, driven from a background daemon — see Sandbox limits below for the differences.

## Installation

```bash
npm install -g dev-browser
dev-browser install
```

## The canonical script

Keep every script small, focused, one job — end it with a `console.log` of the state you need for the next decision.

```bash
dev-browser --timeout 60 <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(JSON.stringify({ url: page.url(), title: await page.title() }));
EOF
```

## Method ladder — try the direct verb first

Work down this list only as each rung fails. The common mistake is skipping straight to `page.evaluate()` to find-and-click something a locator would hit directly — it bypasses Playwright's actionability waits and silently clicks the wrong node.

1. **Known selector → a Playwright locator.** `getByRole`, `getByText`, `getByLabel`, `locator()`. Default for almost everything.
2. **Unknown page → `page.snapshotForAI()` once** to discover elements, then act on locators from what it returns.
3. **After ~2 failed locator attempts on the same target → `page.domCua`** (act by node id from `getVisibleDom()`).
4. **Visual-only structure, no stable DOM (e.g. canvas) → `page.cua`** (act by coordinates read off a screenshot).
5. **`page.evaluate()` → read-only introspection, last resort.** Compute a value or check state — never to click, scroll, or find.

## Timeouts — three separate clocks

- **`--timeout N`** sets the whole script's budget. It does **not** raise Playwright's per-action timeout.
- **Each action** (`goto`, `click`, `screenshot`, `snapshotForAI`) has its own ~30s default, independent of `--timeout`. Raise it explicitly on the call: `page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" })`.
- **The outer shell/tool** running dev-browser has its own separate kill clock (e.g. a Bash tool's ~2min limit) — not fixable by any dev-browser flag. If that's what's killing the run, shorten the script; don't raise `--timeout`.

If a `goto`/`click` keeps failing at "30000ms exceeded" even after raising `--timeout`, you're chasing the wrong clock — pass `{ timeout }` on that specific call instead.

Use `waitUntil: "domcontentloaded"`, not `"networkidle"` — `networkidle` hangs indefinitely on any site with analytics, trackers, or SPA polling.

## Named pages persist — and typos make blank ones

- `browser.getPage("checkout")` returns the **same tab** across separate script invocations. Reuse it — don't re-navigate or re-log-in.
- **`getPage("typo")` silently creates a new blank page** instead of erroring. A blank/`about:blank` result usually means a misspelled name, not a broken page — check spelling before assuming something failed.
- Use a fresh/random page name to simulate a first-time visitor (no cookies, first-load popups).

## One daemon — never run calls in parallel

- All dev-browser calls share **one background daemon**. Never fire two dev-browser calls at once — they serialize on the daemon and can wedge Chromium under load. Loop *inside* one script instead.
- Running multiple agents concurrently: give each its own **`--browser <name>`**. **Never run global `dev-browser stop`** — it kills every agent's browser, not just yours.

## Sandbox limits — this is QuickJS, not Node

- No `require`/`import`/`process`/`fs`/`fetch` at the script's top level.
- **`document`/`window`/DOM globals only exist inside `page.evaluate(() => ...)`** — never at the top level. `document is not defined` means you're outside `evaluate()`.
- **`setInputFiles` with a host file path fails** — there's no filesystem in the sandbox. For uploads, generate the file in-page (canvas → `Blob`/`File` → `DataTransfer`) and inject it.
- **`readFile()` is UTF-8 only** — don't use it to round-trip a screenshot or other binary file; it will corrupt it.

## Usage

Run `dev-browser --help` for the complete, authoritative API — method reference, `cua`/`domCua` details, `--connect` mode, and the full option list.
