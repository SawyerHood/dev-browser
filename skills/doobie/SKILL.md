---
name: doobie
description: Browser automation with persistent named pages via the doobie CLI. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, log into sites, or automate browser workflows. Trigger phrases include "go to [url]", "click on", "fill out the form", "take a screenshot", "scrape", "automate", "test the website", "log into", "open the browser", or any browser interaction request.
---

# doobie

CLI for controlling a real Chrome with short Puppeteer scripts. One warm daemon; named pages persist between runs.

```bash
npm install -g doobie
doobie install   # only if no Chrome/Chromium/Edge is installed
```

Run `doobie --help` (full guide; `doobie help <topic>` for one section) before non-trivial work. Quick start:

```bash
doobie <<'EOF'
const page = await browser.getPage("main");        // named page persists across runs
await page.goto("https://example.com");            // default waitUntil: domcontentloaded
await page.snapshot({ interactive: true })         // ARIA tree with refs; last expression is printed
EOF
doobie -e 'const p = await browser.getPage("main"); await p.click("ref/e3"); await p.waitForLoad(); p.url()'
```
