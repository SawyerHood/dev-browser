---
name: dev-browser
description: Browser automation with persistent named pages via the dev-browser CLI. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, log into sites, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", "open the browser", or any browser interaction request.
---

# dev-browser

CLI for controlling a real Chrome with short Puppeteer scripts. One warm daemon; named pages persist between runs.

```bash
npm install -g dev-browser   # bun add -g dev-browser works too; the first run downloads the binary if the install script was blocked
dev-browser install          # only if the first run says "No Chrome found"
```

Run `dev-browser --help` (full guide; `dev-browser help <topic>` for one section) before non-trivial work. Quick start:

```bash
dev-browser <<'EOF'
const page = await browser.getPage("main");        // named page persists across runs
await page.goto("https://example.com");            // default waitUntil: domcontentloaded
await page.snapshot({ interactive: true })         // ARIA tree with refs; last expression is printed
EOF
dev-browser -e 'const p = await browser.getPage("main"); await p.click("ref/e6"); await p.waitForLoad(); p.url()'
```

Gotchas: end lines with semicolons (a line starting with `(` continues the previous one); return an object as
`({ a, b })`; `page.click` never waits (use `waitForSelector` first); page names are per browser (`--headless` and
headed are separate Chromes and profiles); refs reset on navigation — re-snapshot; file paths resolve against your cwd
(uploadFile, screenshot/pdf `path`); do not run parallel dev-browser calls against the same named page.
