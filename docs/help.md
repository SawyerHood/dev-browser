doobie {{VERSION}} — browser automation CLI for coding agents (Puppeteer scripts, named pages, snapshot refs)

USAGE
  doobie [flags] < script.js        run a script from stdin (heredoc)
  doobie [flags] -e 'code'          run inline code
  doobie [flags] run FILE           run a script file
  doobie pages | browsers | status | stop [NAME] | install [--force] | install-skill [--claude|--codex|--agents]
  doobie chrome [--profile NAME] [--port N] [--chrome PATH] [--list] [URL]
  doobie help [topic]               topics: quickstart workflow scripts pages snapshot refs screenshots waiting forms
                                    errors output connect chrome config json examples tips

FLAGS
  -b, --browser NAME      launch/reuse a persistent named profile (default: "default"); ~/.doobie/browsers/NAME
  -c, --connect [URL]     attach to a running Chrome: auto (bare flag) | PORT | host:PORT | http://host:port | ws://... | unix:/path
      --headless          launch headless (1280x720); default headed (viewport: null). config.json can flip the default
      --headed            force headed even if config.json says headless
  -t, --timeout SECONDS   one deadline for the whole request: connect + script + teardown (default 30, >= 1)
  -e, --eval CODE         inline script instead of stdin/FILE
      --json              NDJSON frames on stdout instead of text (see `help json`)
      --idle-timeout D    close a launched browser after D idle: 30s, 5m, 1h, ms, or 0 = never (default 30m)
      --quiet-page        do not print page console errors/warnings/uncaught exceptions
      --no-cap            do not cap stdout at 50k chars (see `help output`)
  -h, --help              this text        -V, --version   print version
  Flags accept --flag=value. Flags go before the subcommand; a TTY with no script prints help (exit 2).

## quickstart
  doobie <<'EOF'
  const page = await browser.getPage("main");      // named page: persists across runs, created on first use
  await page.goto("https://example.com");           // waits for domcontentloaded (not load) by default
  await page.snapshot({ interactive: true })        // last expression = return value, printed raw
  EOF
  doobie -e 'const p = await browser.getPage("main"); await p.click("ref/e3"); p.url()'
  doobie -e 'const p = await browser.getPage("main"); (await p.shot()).path'   # then Read the image file
  First run: a daemon starts (~360 ms) and launches Chrome; later runs reuse both (~25 ms). No Chrome? `doobie install`.

## workflow
  Each invocation is one decision-sized step: snapshot -> act by ref -> verify with the cheapest state check.
  1. Look:   s = await page.snapshot({ track: "main" }); print s.full (or snapshot({ interactive: true }) on big pages).
  2. Act:    await page.click("ref/e12")  /  await page.fill("ref/e7", "text")  /  page.ref("e12") for an ElementHandle.
  3. Verify: print (await page.snapshot({ track: "main" })).incremental — a diff of only what changed — plus page.url().
  Batch look/act/verify in one script when the target is known; split when you must read output to decide. End every
  script by logging only the state the next decision needs (url, title, a diff, one value). Never dump HTML.
  Cheapest state check wins: url/title < incremental snapshot < interactive snapshot < full snapshot < screenshot.
  Named pages persist: do not re-navigate; getPage("checkout") resumes where the last script (or failure) left off.
  Use short explicit timeouts: page.click(sel, { timeout: 3000 }), waitForSelector(sel, { timeout: 5000 }), -t 15.
  Inside page.evaluate(...) write plain browser JavaScript (no TypeScript, no doobie globals, no closures over script vars;
  pass values as arguments: page.evaluate((n) => ..., n)). Never assume page structure: snapshot first.
  A failed script leaves the page where it stopped; the error prints `[page NAME] url "title"` so you can resume.

## scripts
  Runtime: your code is the body of one async function run in a fresh node:vm context inside the warm daemon with real
  Puppeteer objects. This isolates globals only — it is NOT a security sandbox; scripts can do anything the daemon can.
  Top-level await works. `return x` works. If the last statement is an expression its value is the result (no `return`
  needed; a promise there is awaited, so `page.title()` alone prints the title). Code never runs twice.
  Result printing: undefined -> nothing; string -> raw; anything else -> pretty JSON (Map/Set/bigint handled;
  Puppeteer objects shown as [ElementHandle] / [Page url]). console.log/info/debug/table/dir -> stdout, streamed live;
  console.warn/error -> stderr. console.log(JSON.stringify(x)) is the reliable way to emit structured data.
  Globals: browser, console, saveFile(name, data) -> path, readFile(name) -> string (both jailed to ~/.doobie/tmp,
  names [A-Za-z0-9._-] only, no paths), fetch, URL, URLSearchParams, Buffer, TextEncoder/Decoder, atob/btoa, crypto,
  performance, setTimeout/setInterval/setImmediate, AbortController, Blob, FormData, Headers, Request, Response.
  Not available: require, import/export (SyntaxError with a hint), process, fs. Syntax errors cost no browser time.
  Timeouts: --timeout (default 30 s) is one absolute deadline over connect + script + teardown -> TimeoutError, exit
  124. Inside the script each Puppeteer action defaults to 5 s, navigation to 15 s; override per call with { timeout }.
  Scripts run concurrently (only launch/connect and page creation are serialized); do not run two on one named page.

## pages
  browser.getPage(name)       get-or-create a named tab; the name -> tab mapping is stored in ~/.doobie/pages/ and
                              survives daemon restarts while Chrome lives. A closed tab is recreated on next use.
  browser.getPage(targetId)   attach to any open tab by its 32-hex CDP target id (from listPages / `doobie pages`).
  browser.newPage()           anonymous tab. NOT auto-closed; close it yourself or it stays open. Prefer getPage(name).
  browser.listPages()         -> [{ id, name|null, url, title }] (one CDP call, no per-tab attach).
  browser.closePage(name)     close and forget a named page. `doobie pages` lists tabs for every running browser.
  Use descriptive names ("login", "checkout", "results"), not "page1"; reuse them across scripts.
  Browsers: -b NAME is a separate Chrome with its own profile/cookies; headed and headless are separate instances
  (keys "NAME" and "NAME:headless"). `doobie browsers` lists them; `doobie stop NAME` closes one (profile persists);
  `doobie stop` closes all and exits the daemon. Idle launched browsers close after --idle-timeout (30m); the daemon
  exits 15 min after its last browser and restarts automatically on the next call. `doobie status` shows all of this.

## snapshot
  await page.snapshot(opts?) -> string            (or { full, incremental } when opts.track is set)
  opts: { scope?: "e12" | "css selector", interactive?: boolean, depth?: number, track?: string, boxes?: boolean,
          maxChars?: number (default 20000), frames?: boolean (default true) }
  Output is an ARIA YAML tree (Playwright grammar), refs on visible elements that receive pointer events:
    - textbox "Email" [ref=e3]                         (- heading "Sign in" [level=1] has no ref: not interactive)
    - button "Continue" [ref=e4] [cursor=pointer]
    - link "Forgot password?" [ref=e5]:
      - /url: /reset
    - checkbox "Remember me" [checked] [ref=e6]        (also [disabled] [expanded] [pressed] [selected] [active])
    - iframe [ref=e9] [cross-origin]                   (same-origin iframes are inlined with refs like f1e5)
    - text: Plain text nodes appear like this
  interactive: true  keeps only links/buttons/inputs/etc. plus headings/landmarks for context — use it first on big pages.
  scope: "e12"       subtree only (a ref or CSS selector).   depth: N  limits nesting.   boxes: true adds [box=x,y,w,h].
  track: "name"      stores the snapshot under name; incremental is a unified-style diff vs the previous one with that
                     name ("(no changes)" when equal). Take a tracked snapshot before acting, print .incremental after.
  Over maxChars the YAML is cut at a line and ends with:
    # ... truncated at 20000 chars (N more lines). Narrow with snapshot({ scope: 'eN' }) or snapshot({ interactive: true }).
  The snapshot does not scroll or wait; call page.waitForLoad() first on dynamic pages.

## refs
  Refs (e5, or f1e5 inside same-origin frame f1) come from the latest page.snapshot(); stable for the same element
  while the document lives, reset by navigation/reload. Two ways to use one:
    await page.ref("e5")                      -> ElementHandle (click(), type(), evaluate(), boundingBox(), ...)
    "ref/e5" as a selector                    -> page.click("ref/e5"), page.type("ref/e7", "hi"), page.hover, focus,
                                                 select, tap, $, $$, $eval, $$eval, fill, waitForSelector, locator
  Frame refs route automatically: page.click("ref/f1e5") acts inside frame f1. Stale ref error:
  `Ref "e5" is stale or unknown. Take a new page.snapshot() and use a fresh ref.` (or `Frame f1 ... is gone.`)
  After any navigation or big DOM change: re-snapshot, then use fresh refs. Refs from the old document never act on
  the new one. Known pages with stable CSS selectors: skip the snapshot and use them directly with short timeouts.

## screenshots
  await page.shot(opts?) -> { path, width, height, scale, fullPage }
  opts: { name?: "file.jpg", fullPage?: boolean, clip?: { x, y, width, height } (CSS px), quality?: 80, maxEdge?: 1568,
          type?: "jpeg" | "png" }
  Writes ~/.doobie/tmp/shot-<ts>-<n>.jpg (JPEG q80) and prints `[image] PATH (WxH)`; open it with your image/Read tool.
  Downscaled so the longest edge <= 1568 px. scale === 1 means image pixels map 1:1 onto CSS pixels, so a point read
  off a viewport/clip screenshot feeds page.mouse.click(x, y) directly (any DPR). If scale < 1, divide by scale. Never
  derive click coordinates from a fullPage shot; scroll, then shot again. Use a named page so coordinates stay valid.

## waiting
  page.goto(url, opts?)         default { waitUntil: "domcontentloaded" } (dev servers keep "load" pending forever);
                                pass { waitUntil: "load" | "networkidle0" | "networkidle2", timeout } to change it.
  await page.waitForLoad(opts?) -> { ready, readyState, pending, ms }   never throws; cap 3 s. Use after clicks that
      trigger fetches/navigation. ready when readyState === "complete" AND no new network request for 300 ms (sockets/
      streams older than 2 s ignored) AND no DOM mutations for 200 ms. opts: { timeout?, networkQuietMs?, domQuietMs? }.
  Puppeteer waits, always with a timeout: page.waitForSelector(sel, { visible: true, timeout: 5000 }),
  page.waitForNavigation({ timeout }) (start it BEFORE the click: Promise.all([page.waitForNavigation(), page.click()])),
  page.waitForFunction(fn, { timeout }), page.waitForNetworkIdle({ idleTime: 500, timeout }), page.waitForResponse.
  No action waits implicitly after a click. No sleep(): `await new Promise(r => setTimeout(r, ms))`, sparingly.

## forms
  await page.fill("ref/e7", "text")   clear + type into input/textarea/contenteditable (React-safe: native setter +
                                      input/change events). Opts { delay } per keystroke. Throws if no element matches.
  page.type(sel, text)                append keystrokes.      page.select(sel, value)   choose <select> options.
  page.click(sel, { count: 2 })       double-click.           page.keyboard.press("Enter") / .down("Shift") / .type(s).
  page.$eval(sel, el => el.value)     read a value.           (await page.ref("e7")).uploadFile("/abs/path") for files.

## errors
  On failure stderr gets, in order: `Name: message`, up to 5 stack frames `    at <stdin>:LINE:COL` (script lines only;
  file scripts show their basename), then one line per page the script touched: `[page NAME] URL "Title"`
  (anonymous tabs: `[page] URL "Title"`). Recover by reconnecting to the same page name and checking state.
  Exit codes: 0 ok · 1 script/daemon error (also Chrome not found, bad --connect) · 2 usage · 124 deadline hit
  (`TimeoutError: Timed out after 30s (deadline)`). Per-action timeouts from Puppeteer ("Waiting for selector `x`
  failed: 5000ms exceeded") are ordinary errors (exit 1).
  Page console: console.error/warn and uncaught exceptions from touched pages are collected and printed at the end on
  stderr as `[page:NAME] error: ...`, `[page:NAME] warn: ...`, `[page:NAME] uncaught: ...` (max 20 lines, 500 chars
  each; `[page]` for anonymous tabs). --quiet-page disables this.
  "No Chrome found": `doobie install` or DOOBIE_CHROME. Daemon trouble: `doobie status` (log tail), `doobie stop`, retry.

## output
  stdout: console output and `[image] PATH (WxH)` lines (one per page.shot()) streamed live; the return value last.
  stderr: console.warn/error, the error block, the page console block. stderr is never capped.
  Cap: after 50k chars of stdout the rest is spilled to ~/.doobie/tmp/out-<id>.txt and at the end doobie prints
  `[... stdout capped at 50000 chars, N total; full output: PATH (e.g. sed -n '1,200p' PATH) ...]` then
  `[... last N chars ...]` + the tail (<= 5k). --no-cap disables. Prefer small returns, or saveFile("big.json", text).

## connect
  --connect with no value = auto: probes ports remembered by `doobie chrome`, then 9222-9229 on 127.0.0.1 (400 ms each).
  --connect 9222 | --connect host:9222 | --connect http://host:9222   -> reads /json/version for the websocket URL
  --connect ws://host:9222/devtools/browser/<id>                     -> connects directly
  --connect unix:/path/to.sock (or pipe:NAME)   -> raw browser-level CDP, one JSON message per line (embedder hook)
  Attached browsers are never closed by --idle-timeout; `doobie stop <key>` only disconnects. Named pages work the
  same (stored per endpoint); see the user's existing tabs with browser.listPages(), then getPage(targetId).

## chrome
  doobie chrome [--profile NAME] [--port N] [--chrome PATH] [URL]   launch your real installed Chrome as a normal OS
  process with --remote-debugging-port on a dedicated profile (~/.doobie/browsers/NAME/profile, default NAME "chrome")
  and remember the port in ~/.doobie/chrome-ports.json so a bare `doobie --connect` finds it. This is the path for
  Google sign-in and other logins that reject automation-launched Chrome: sign in by hand once, then automate.
  `doobie chrome --list` prints detected Chromes. (Chrome 136+ ignores the port flag on its default profile, hence the
  dedicated --user-data-dir.) A --connect that finds nothing prints this launch hint.

## config
  ~/.doobie/config.json: { "headless": false, "idleTimeout": "30m", "chrome": "/path/to/chrome", "timeout": 30 }
  Precedence everywhere: flag > env > config.json > default.
  Env: DOOBIE_HOME (state dir, default ~/.doobie: daemon.sock/.pid/.log, config.json, tmp/, browsers/, pages/, chrome/),
       DOOBIE_CHROME (executable), DOOBIE_IDLE_TIMEOUT, DOOBIE_SOCKET. Durations: 30s, 5m, 1h, 0 (off), or milliseconds.
  Chrome lookup: DOOBIE_CHROME > config.chrome > ~/.doobie/chrome (from `doobie install`, Chrome for Testing via
  @puppeteer/browsers) > system Chrome/Chromium/Edge/Brave > Playwright's cached Chromium.
  `doobie install-skill [--claude|--codex|--agents]` writes SKILL.md to ~/.claude|.codex|.agents/skills/doobie (default all).

## json
  --json prints one NDJSON frame per line (same frames as the daemon socket protocol, so MCP servers/tools can wrap it):
    {"type":"stdout","data":"..."}  {"type":"stderr","data":"..."}  {"type":"image","path":"...","width":W,"height":H}
    {"type":"result","value":"<formatted string>"}   {"type":"data","payload":...} (pages/browsers/status/stop)
    {"type":"error","kind":"script|timeout|daemon|version|usage","name":"...","message":"...","stack":"...",
     "pages":[{"id","name","url","title"}]}   {"type":"done","exitCode":N,"durationMs":N}   (done is always last)
  The process exit code equals done.exitCode. Output is never capped in --json mode.

## examples
  # Inspect a page you have never seen (interactive elements only)
  doobie <<'EOF'
  const page = await browser.getPage("shop");
  await page.goto("https://shop.example.com", { timeout: 15000 });
  await page.waitForLoad();
  await page.snapshot({ interactive: true, track: "shop" })
  EOF
  # Act by ref and verify with the incremental diff
  doobie <<'EOF'
  const page = await browser.getPage("shop");
  await page.fill("ref/e7", "running shoes");
  await page.click("ref/e8", { timeout: 3000 });
  const load = await page.waitForLoad();
  const snap = await page.snapshot({ track: "shop" });
  console.log(page.url(), JSON.stringify(load));
  snap.incremental
  EOF
  # Log in, persist the session (profile "work" keeps cookies across runs)
  doobie -b work <<'EOF'
  const page = await browser.getPage("login");
  await page.goto("https://app.example.com/login");
  await page.fill("#email", "me@example.com");
  await page.fill("#password", readFile("pw.txt").trim());
  await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click("button[type=submit]")]);
  ({ url: page.url(), title: await page.title() })
  EOF
  # Extract structured data with plain JS in the page
  doobie --headless <<'EOF'
  const page = await browser.getPage("hn");
  await page.goto("https://news.ycombinator.com");
  const rows = await page.$$eval(".athing", els => els.slice(0, 5).map(e => ({
    title: e.querySelector(".titleline a")?.textContent, href: e.querySelector(".titleline a")?.href })));
  rows
  EOF
  # Visual check: screenshot, then click by coordinates measured on the image (scale is 1 for viewport shots)
  doobie -e 'const p = await browser.getPage("shop"); await p.shot({ name: "shop.jpg" })'
  doobie -e 'const p = await browser.getPage("shop"); await p.mouse.click(412, 233); await p.waitForLoad(); p.url()'
  # Your own Chrome (after `doobie chrome`): list tabs, attach one by target id, scoped snapshot with boxes
  doobie --connect -e 'await browser.listPages()'
  doobie --connect -e 'const p = await browser.getPage("4F0C...32HEX"); await p.snapshot({ scope: "e42", boxes: true })'
  # Test a local dev app: console errors surface automatically on stderr as [page:dev] lines
  doobie -t 20 <<'EOF'
  const page = await browser.getPage("dev");
  await page.goto("http://localhost:3000/dashboard");
  await page.waitForSelector("[data-testid=chart]", { visible: true, timeout: 5000 });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.click("text/Refresh").catch(e => console.log("no Refresh button:", e.message));
  await page.waitForLoad();
  ({ url: page.url(), errors, heading: await page.$eval("h1", h => h.textContent) })
  EOF
  # Recover after a failure: where is the page now? (named page kept its state)
  doobie <<'EOF'
  const page = await browser.getPage("shop");
  ({ url: page.url(), title: await page.title(), shot: (await page.shot()).path })
  EOF
  # Same-origin iframe: refs are prefixed with the frame key and route automatically
  doobie <<'EOF'
  const page = await browser.getPage("embed");
  console.log(await page.snapshot({ interactive: true }));   // ... - iframe [ref=e2]:  - button "Pay" [ref=f1e3]
  await page.click("ref/f1e3", { timeout: 3000 });
  (await page.ref("f1e3")).evaluate(el => el.textContent)
  EOF
  doobie pages · doobie browsers · doobie stop work · doobie --json status       # housekeeping

## tips
  - Do not take both a snapshot and a screenshot by default; pick the cheapest check that answers the question.
  - Known selectors beat refs: page.click("#submit", { timeout: 3000 }). Puppeteer prefixes text/ aria/ xpath/ pierce/ work.
  - --headless for unattended work; headed (default) to watch. Claude Code: allowlist `Bash(doobie *)`.
  - Long jobs: --idle-timeout 0 keeps the browser alive; `doobie stop` when done. -b NAME isolates logins/parallel work.
  - For Google/OAuth logins use `doobie chrome` + `--connect`; automation-launched Chrome is often blocked.
