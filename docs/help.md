doobie {{VERSION}} — browser automation CLI for coding agents (Puppeteer scripts, named pages, snapshot refs)

USAGE
  doobie [flags] < script.js        run a script from stdin (heredoc)
  doobie [flags] -e 'code'          run inline code
  doobie [flags] run FILE           run a script file
  doobie pages | browsers | status | stop [NAME] | install [--force] | install-skill [--claude|--codex|--agents]
  doobie chrome [--profile NAME] [--port N] [--chrome PATH] [--headless] [--list] [URL]
  doobie help [topic]               topics: quickstart workflow scripts pages snapshot refs screenshots waiting forms
                                    errors output connect chrome config json mcp examples tips

FLAGS
  -b, --browser NAME      launch/reuse a persistent named profile (default: "default"); ~/.doobie/browsers/NAME
  -c, --connect [URL]     attach to a running Chrome: auto (bare flag) | PORT | host:PORT | http://... | ws://... | unix:/path
      --headless          launch headless (1280x720); default headed (viewport: null). config.json can flip the default
      --headed            force headed even if config.json says headless
      --ignore-https-errors  accept self-signed/invalid TLS certs (own browser instance + profile dir)
  -t, --timeout SECONDS   one deadline for the whole request: connect + script + teardown (default 30, >= 1)
  -e, --eval CODE         inline script instead of stdin/FILE
      --json              NDJSON frames on stdout instead of text (see `help json`)
      --idle-timeout D    close a launched browser after D idle: 30s, 5m, 1h, ms, or 0 = never (default 30m)
      --quiet-page        do not print page console errors/warnings/uncaught exceptions/dialogs
      --no-cap            do not cap stdout at 50k chars (see `help output`)
  -h, --help              this text        -V, --version   print version
  Flags accept --flag=value, before or after the subcommand, except: everything after install/install-skill/chrome
  belongs to it; `stop NAME` / `help TOPIC` take their argument immediately. A TTY with no script prints help (exit 2).

## quickstart
  doobie <<'EOF'
  const page = await browser.getPage("main");      // named page: persists across runs, created on first use
  await page.goto("https://example.com");           // waits for domcontentloaded (not load) by default
  await page.snapshot({ interactive: true })        // last expression = return value, printed raw
  EOF
  doobie -e 'const p = await browser.getPage("main"); await p.click("ref/e6"); p.url()'        # act by ref
  doobie -e 'const p = await browser.getPage("main"); (await p.shot()).path'                      # then Read the image
  First run starts a daemon + Chrome (~0.5 s); later runs reuse both (~15 ms). No Chrome? `doobie install`.

## workflow
  Each invocation is one decision-sized step: snapshot -> act by ref -> verify with the cheapest state check.
  1. Look:   print (await page.snapshot({ interactive: true, track: "main" })).full   (interactive first on big pages).
  2. Act:    await page.click("ref/e12")  /  await page.fill("ref/e7", "text")  /  page.ref("e12") for an ElementHandle.
  3. Verify: print (await page.snapshot({ interactive: true, track: "main" })).incremental — a diff of only what
     changed (same track name AND same options as step 1) — plus page.url(). Batch look/act/verify in one script when
     the target is known; split when you must read output to decide. End every script by logging only the state the
     next decision needs (url, title, a diff, one value). Never dump HTML.
  Cheapest state check wins: url/title < incremental snapshot < interactive snapshot < full snapshot < screenshot.
  Named pages persist: do not re-navigate; getPage("checkout") resumes where the last script (or failure) left off.
  page.click/fill/type/hover/select do NOT wait for the element and ignore { timeout }: they throw at once if it is
  missing. If it may not be there yet: await page.waitForSelector(sel, { visible: true, timeout: 3000 }) first, or
  page.locator(sel).setTimeout(3000).click(). Keep waits short and -t small (-t 15) so failures return fast.
  Inside page.evaluate(...) write plain browser JavaScript (no TypeScript, no doobie globals, no closures over script
  vars; pass values as arguments: page.evaluate((n) => ..., n)). Never assume page structure: snapshot first. A failed
  script leaves the page where it stopped; the error prints `[page NAME] url "title"` so you can resume.

## scripts
  Runtime: your code is the body of one async function run in a fresh node:vm context inside the warm daemon with real
  Puppeteer objects. This isolates globals only — it is NOT a security sandbox; scripts can do anything the daemon can.
  Top-level await works. `return x` works. If the last statement is an expression its value is the result (no `return`
  needed; a promise there is awaited, so `page.title()` alone prints the title). Code never runs twice.
  ASI trap: end lines with semicolons. A line starting with ( or [ continues the previous line without one, so
  `const p = await browser.getPage("m")` + newline + `(await p.shot()).path` runs getPage("m")(...) -> ReferenceError
  ("Cannot access 'p' before initialization"). A trailing `{ a: 1, url: p.url() }` is returned as an object (the
  block/literal ambiguity is detected), but parens — ({ a, b }) — are always safe.
  Result printing: undefined -> nothing; string -> raw; anything else -> pretty JSON. Map -> object, Set -> array,
  Error -> "Name: message", bigint -> string; Puppeteer objects shown as [ElementHandle] / [Page url]; other
  non-serializable values (HTTPResponse from goto, DOM nodes/window from evaluate, circular values) print as {} or
  nothing — return .textContent/.outerHTML/attributes/response.status() instead (Locator.wait() returns a serialized
  value; .waitHandle() for an ElementHandle). console.log/info/debug/table/dir -> stdout, streamed live;
  console.warn/error -> stderr. console.log(JSON.stringify(x)) is the reliable way to emit structured data.
  Globals: browser, console, saveFile(name, data) -> path, readFile(name) -> string (both jailed to ~/.doobie/tmp,
  names [A-Za-z0-9._-] only, no paths), fetch, URL, URLSearchParams, Buffer, TextEncoder/Decoder, atob/btoa, crypto,
  performance, structuredClone, queueMicrotask, setTimeout/setInterval/setImmediate (+ clear*), AbortController/
  AbortSignal, Blob, FormData, Headers, Request, Response. Not available: require, import/export (SyntaxError with a
  hint), process, fs, page.waitForTimeout (use `await new Promise(r => setTimeout(r, ms))`). Syntax errors cost no
  browser time. Unhandled promise rejections inside the script are NOT reported: await your promises.
  Timeouts: --timeout (default 30 s) is one absolute deadline over connect + script + teardown -> exit 124 with
  `TimeoutError: Timed out after 30s (deadline)` (+ ` while in page.waitForSelector("#x")` when a call was in flight).
  After the deadline the script is a zombie: its next page/handle/frame call rejects (`script deadline passed`), its
  timers and listeners are cleared. The deadline fires between awaits only: synchronous CPU-bound code (a busy loop)
  cannot be interrupted; an infinite one is ended by the client watchdog, which restarts the daemon and its launched
  Chrome (named pages lost). Inside the script, waitFor*/locator/goto calls default to 5 s (navigation 15 s); override
  per call with { timeout }. setDefaultTimeout/setDefaultNavigationTimeout/setRequestInterception(true) are undone when
  the script ends. Scripts run concurrently; only launch/connect, page creation and input on different tabs of one
  browser (bring-to-front lock) are serialized. Two scripts on one named page interleave: never run them in parallel.

## pages
  browser.getPage(name)       get-or-create a named tab; the name -> tab mapping is stored in ~/.doobie/pages/ and
                              survives daemon restarts while Chrome lives. A closed tab is recreated on next use.
  browser.getPage(targetId)   attach to any open tab by its 32-hex CDP target id (from listPages / `doobie pages`).
  browser.newPage()           anonymous tab. NOT auto-closed; close it yourself or it stays open. Prefer getPage(name).
  browser.listPages()         -> [{ id, name|null, url, title }] (one CDP call, no per-tab attach).
  browser.closePage(name)     close and forget a named page. Anonymous/attached tabs: (await browser.getPage(id)).close().
  Use descriptive names ("login", "checkout"), not "page1"; reuse them across scripts. Names are per browser key
  ("default", "default:headless", "work", "cdp:ws://...") and die with that browser: the same name under --headless and
  headed is two tabs in two Chromes. -b NAME is a separate Chrome with its own profile/cookies; headed and headless are
  separate instances with separate profile dirs (browsers/NAME/profile vs profile-headless): logins do not carry over.
  `doobie browsers` lists them; `doobie pages` lists tabs for every running browser (with -b/--connect it launches/
  attaches that browser and lists only its tabs); `doobie stop NAME` closes one (profile persists; exit 1 if none
  matched; a script running on it fails with BrowserStoppedError); `doobie stop` closes all and exits the daemon. Tabs
  Chrome restores from the previous session are closed at relaunch. Idle launched browsers close after --idle-timeout
  (30m; only scripts reset the idle clock, not `pages`/`status`); the daemon exits 15 min after its last browser and
  restarts automatically on the next call.
  Background tabs are brought forward automatically when you act on them (input/shot/waits on different tabs of one
  browser take turns under a per-browser lock; a long action such as type({ delay }) delays the other tab). Pages from
  Puppeteer itself (page.browser().newPage(), popups) get the doobie helpers too; with --connect only tabs you touch
  (getPage, newPage, their popups) are extended — the user's other tabs keep their dialogs and scripts. Downloads from
  launched browsers land in ~/.doobie/tmp/downloads/<name> (not readable via readFile: use the shell); attached browsers
  keep Chrome's download dir. goto() of an attachment URL throws net::ERR_ABORTED although the file still lands.

## snapshot
  await page.snapshot(opts?) -> string            (or { full, incremental } when opts.track is set)
  opts: { scope?: "e12" | "css selector", interactive?: boolean, depth?: number, track?: string, boxes?: boolean,
          urls?: boolean (default true; false drops "- /url:" lines), maxChars?: number (default 20000),
          frames?: boolean (default true) }
  Output is an ARIA YAML tree (Playwright grammar; names fall back to placeholder, ::before/::after, svg <title>, legend/
  caption; an unlabeled file input is `button "Choose File"`). Refs go on every visible element that receives pointer
  events (headings, generics and text containers included, not just controls); plain text / presentational nodes have none:
    - heading "Sign in" [level=1] [ref=e2]
    - textbox "Email" [ref=e3]
    - button "Continue" [ref=e4]
    - generic "Toggle" [ref=e7] [cursor=pointer]      ([cursor=pointer] marks clickable non-control elements only)
    - link "Forgot password?" [ref=e5]:
      - /url: /reset
    - checkbox "Remember me" [checked] [ref=e6]        (also [disabled] [expanded] [pressed] [selected] [active])
    - iframe [ref=e9] [cross-origin]                   (same-origin iframes are inlined with refs like f1e5)
    - text: Plain text nodes appear like this
  interactive: true  prunes to links/buttons/inputs/etc. plus headings/landmarks for context (keeps alerts/status/live
                     regions, dialog text, contenteditable editor text) — use it first on big pages.
  scope: "e12"       subtree only (a ref or CSS selector).   depth: N  limits nesting (cut nodes end with " […]").
  boxes: true        adds [box=x,y,w,h] in MAIN-viewport CSS px (iframe offsets applied) for page.mouse.
  track: "name"      stores the snapshot under name; incremental is a line diff vs the previous one with that name
                     (+/- lines, one "  " context line per hunk, "…" between hunks; "(no changes)" when equal; the full
                     snapshot on the first call and, prefixed "(page changed substantially; showing full snapshot)",
                     after navigation/big re-renders). Print .full on the first call, .incremental after acting — the
                     object itself prints as escaped JSON. Keep the options (interactive/scope/depth/urls) identical
                     for one track name, otherwise the diff is every line. Frame keys f1, f2… are stable per frame.
  Over maxChars the YAML is cut at a line and ends with `# ... truncated at 20000 chars (N more lines). Narrow with
  snapshot({ scope: 'eN' }) or snapshot({ interactive: true }).` (with interactive on: scope / urls: false / depth / maxChars).
  The snapshot does not scroll or wait; call page.waitForLoad() first on dynamic pages.

## refs
  Refs (e5, or f1e5 inside same-origin frame f1) come from the latest page.snapshot(); stable for the same element
  while the document lives, reset by navigation/reload. Two ways to use one: await page.ref("e5") -> ElementHandle
  (click(), type(), evaluate(), boundingBox(), ...), or "ref/e5" as a selector: page.click("ref/e5"),
  page.type("ref/e7", "hi"), page.hover, focus, select, tap, $, $$, $eval, $$eval, fill, waitForSelector, locator.
  Frame refs route automatically: page.click("ref/f1e5") acts inside frame f1. Stale ref error (page.ref and the
  acting selector methods alike): `Ref "e5" is stale or unknown. Take a new page.snapshot() and use a fresh ref. (cause:
  No element found for selector: ref/e5)` (or `Frame f1 ... is gone.`). Exceptions: page.$/$$ return null/[] (check
  before use); page.locator("ref/e5") only reports `Timed out after waiting Nms`; waitForSelector("ref/e5") throws a
  plain Error `Waiting for selector \`ref/e5\` failed: Nms exceeded` (name "Error", not TimeoutError).
  After any navigation or big DOM change: re-snapshot, then use fresh refs. Refs from the old document never act on
  the new one. Known pages with stable CSS selectors: skip the snapshot and use them directly.

## screenshots
  await page.shot(opts?) -> { path, width, height, scale }
  opts: { name?: "file.jpg", fullPage?: boolean, clip?: { x, y, width, height } (CSS px), quality?: 80, maxEdge?: 1568,
          type?: "jpeg" | "png" (inferred from name's .png/.jpg) }
  Writes ~/.doobie/tmp/shot-<ts>-<n>.jpg (JPEG q80) and prints `[image] PATH (WxH)`; open it with your image/Read tool.
  Downscaled so the longest edge <= 1568 px. scale === 1 means image pixels map 1:1 onto CSS pixels, so a point read
  off a viewport/clip shot feeds page.mouse.click(x, y) directly (any DPR); if scale < 1, divide by scale. Never derive
  click coordinates from a fullPage shot; scroll, then shot again. Use a named page so coordinates stay valid.

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
  await page.fill("ref/e7", "text")   clear + type into text inputs/textarea/contenteditable (React-safe: native setter
                                      + input/change events); sets date/time/month/week/number/range/color inputs
                                      directly (value must match the type: "2024-01-31", "13:45"). Opts { delay } per
                                      keystroke. Throws if no element matches, for readonly/disabled fields, checkbox/
                                      radio/file inputs (use click / uploadFile) and <select> (use page.select).
  page.type(sel, text)                append keystrokes.      page.select(sel, value)   choose <select> options.
  page.click(sel, { count: 2 })       double-click.           page.keyboard.press("Enter") / .down("Shift") / .type(s).
  page.$eval(sel, el => el.value)     read a value.           (await page.ref("e7")).uploadFile("/abs/path") for files
                                      (missing files pass silently). ABSOLUTE paths for every file option: uploadFile,
                                      screenshot({ path }), pdf({ path }) resolve relative paths against the daemon's cwd.
  No key chords ("Control+a" -> Unknown key): keyboard.down("Control"); keyboard.press("a"); keyboard.up("Control")
  (all awaited; "Meta" on macOS). Dialogs (alert/confirm/prompt) are auto-dismissed and reported as `[page:NAME] dialog
  alert: msg (auto-dismissed)`; beforeunload is accepted (`(auto-accepted)`, the navigation proceeds). Register
  page.on("dialog", d => d.accept("text")) BEFORE the action to handle one yourself.

## errors
  On failure stderr gets, in order: `Name: message`, up to 5 stack frames `    at <stdin>:LINE:COL` (script lines only;
  file scripts show their basename), then one line per page the script touched: `[page NAME] URL "Title"`
  (anonymous tabs: `[page] URL "Title"`; after a failed goto: `[page NAME] OLD-URL (goto "URL" failed)`, the tab shows
  Chrome's error page). Recover by reconnecting to the same page name and checking state. `doobie stop` during a script
  -> `BrowserStoppedError: browser "KEY" was stopped while the script was running`. Exit codes: 0 ok · 1 script/daemon
  error (also Chrome not found, bad --connect, `stop NAME` with no match) · 2 usage (also `help <unknown topic>`) · 124
  deadline hit (`TimeoutError: Timed out after 30s (deadline)`, see `help scripts`). Per-action timeouts are ordinary
  errors (exit 1): `TimeoutError: Waiting for selector \`#x\` failed (cause: Waiting failed: 5000ms exceeded)`; an
  error's cause is appended as ` (cause: ...)`; e.name / e.constructor.name are the real Puppeteer names.
  Page console: console.error/warn, uncaught exceptions and auto-dismissed dialogs from touched pages are printed at the
  end on stderr as `[page:NAME] error: ...`, `warn: ...`, `uncaught: ...`, `dialog alert: ...` (max 20 lines then
  `[page] ... N more lines`, 500 chars each; `[page]` for anonymous tabs; favicon 404s dropped). --quiet-page disables.
  "No Chrome found": `doobie install` or DOOBIE_CHROME. Daemon trouble: `doobie status` (log tail), `doobie stop`, retry.
  "profile ... is in use by another Chrome (pid N)": a hand-started Chrome holds that profile dir; stop it or use another
  -b NAME. Snap Chromium (Ubuntu /snap/bin) cannot read ~/.doobie: use `doobie install` or DOOBIE_CHROME=<deb/CfT>.

## output
  stdout: console output and `[image] PATH (WxH)` lines (one per page.shot()) streamed live; the return value last.
  stderr: console.warn/error, the error block, the page console block. stderr is never capped.
  Cap: after 50k chars of stdout the rest is spilled to ~/.doobie/tmp/out-<id>.txt and at the end doobie prints
  `[... stdout capped at 50000 chars, N total; full output: PATH (e.g. sed -n '1,200p' PATH) ...]` then
  `[... last N chars ...]` + the tail (<= 5k). --no-cap disables. Prefer small returns, or saveFile("big.json", text).

## connect
  --connect with no value = auto: probes ports remembered by `doobie chrome`, then 9222-9229 on 127.0.0.1 (400 ms each).
  --connect 9222 | --connect host:9222 | --connect http://host:9222   -> reads /json/version for the websocket URL
  --connect ws://host:9222/devtools/browser/<id> -> connects directly;  --connect unix:/path/to.sock (or pipe:NAME)
  -> raw browser-level CDP, one JSON message per line (embedder hook).
  Attached browsers are never closed by --idle-timeout; `doobie stop <key>` only disconnects. Named pages work the same
  (stored per endpoint; ws URL query/credentials are stripped from keys and logs); see the user's existing tabs with
  browser.listPages(), then getPage(targetId). Only tabs you touch are extended (see `help pages`).

## chrome
  doobie chrome [--profile NAME] [--port N] [--chrome PATH] [--headless] [URL]   launch your real installed Chrome as
  a normal OS process with --remote-debugging-port on a dedicated profile (~/.doobie/chrome-profiles/NAME, default NAME
  "chrome") and remember the port in ~/.doobie/chrome-ports.json so a bare `doobie --connect` finds it. This is the path
  for Google sign-in and other logins that reject automation-launched Chrome: sign in by hand once, then automate.
  It prefers a system Chrome (then DOOBIE_CHROME/config, then `doobie install`'s Chrome for Testing, then Playwright's
  Chromium, with a warning that Google may reject those) and prints which binary it chose; --chrome PATH overrides.
  The launch is verified (Chrome must answer /json/version within 3 s); if Chrome dies, its stderr tail and the log path
  (~/.doobie/chrome-logs/NAME.log) are printed, exit 1, nothing recorded. On Linux a sandbox failure is retried once
  with --no-sandbox (remembered in launch-state.json). --headless passes --headless=new (CI/tests).
  `doobie chrome --list` prints detected Chromes. (Chrome 136+ ignores the port flag on its default profile, hence the
  dedicated --user-data-dir.) A --connect that finds nothing prints this launch hint.

## config
  ~/.doobie/config.json: { "headless": false, "idleTimeout": "30m", "chrome": "/path/to/chrome", "timeout": 30, "ignoreHttpsErrors": false }
  Precedence everywhere: flag > env > config.json > default. Env: DOOBIE_HOME (state dir, default ~/.doobie:
       daemon.sock/.pid/.log, config.json, tmp/ (shots, out-*.txt, downloads/), browsers/NAME/profile[-headless]
       [-insecure], chrome-profiles/NAME, chrome-logs/, pages/, chrome/), DOOBIE_CHROME (executable), DOOBIE_IDLE_TIMEOUT,
       DOOBIE_SOCKET. Durations: 30s, 5m, 1h, 0 (off), or milliseconds.
  Chrome lookup: DOOBIE_CHROME > config.chrome > ~/.doobie/chrome (from `doobie install`, Chrome for Testing via
  @puppeteer/browsers; no unzip needed, ~150 MB) > system Chrome/Chromium/Edge/Brave > Playwright's cached Chromium.
  `doobie install-skill [--claude|--codex|--agents]` writes SKILL.md to ~/.claude|.codex|.agents/skills/doobie (default all).

## json
  --json prints one NDJSON frame per line (same frames as the daemon socket protocol, so MCP servers/tools can wrap it):
    {"type":"stdout","data":"..."}  {"type":"stderr","data":"..."}  {"type":"image","path":"...","width":W,"height":H}
    {"type":"result","value":"<formatted string>","data":<structured value when JSON-serializable>}
    {"type":"data","payload":...} (pages/browsers/status/stop)   {"type":"done","exitCode":N,"durationMs":N} (always last)
    {"type":"error","kind":"script|timeout|daemon|version|usage","name":"...","message":"...","stack":"...","pages":[{"id","name","url","title"}]}
  The process exit code equals done.exitCode. Output is never capped in --json mode.  jq: doobie --json -e '...' |
  jq -c 'select(.type=="result").data'

## mcp
  doobie mcp [-b NAME] [--headless] [--connect URL] [-t S]    Model Context Protocol server over stdio (JSON-RPC 2.0).
  Tools: doobie_run { script, browser?, headless?, connect?, timeout? } (console output, return value, errors, page.shot()
  images as image content), doobie_pages, doobie_browsers, doobie_stop { browser? }, doobie_help { topic? }. Flags given
  to `doobie mcp` are defaults for every call; same daemon and named pages as the CLI, so CLI scripts and MCP calls share
  pages. Claude Code: `claude mcp add doobie -- doobie mcp --headless`.

## examples
  # Inspect a page you have never seen (interactive elements only); first tracked call prints the full tree
  doobie <<'EOF'
  const page = await browser.getPage("shop");
  await page.goto("https://shop.example.com", { timeout: 15000 });
  await page.waitForLoad();
  (await page.snapshot({ interactive: true, track: "shop" })).full
  EOF
  # Act by ref and verify with the incremental diff (same track name, same options)
  doobie <<'EOF'
  const page = await browser.getPage("shop");
  await page.fill("ref/e7", "running shoes");
  await page.click("ref/e8");
  const load = await page.waitForLoad();
  const snap = await page.snapshot({ interactive: true, track: "shop" });
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
  # Extract structured data with plain JS in the page (returned arrays/objects print as JSON)
  doobie --headless -e 'const p = await browser.getPage("hn"); await p.goto("https://news.ycombinator.com");
    await p.$$eval(".athing .titleline > a", as => as.slice(0, 5).map(a => ({ title: a.textContent, href: a.href })))'
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
  # Self-signed local HTTPS · recover after a failure (named page kept its state) · same-origin iframe ref (routes)
  doobie --ignore-https-errors -e 'const p = await browser.getPage("dev"); await p.goto("https://localhost:8443"); p.url()'
  doobie -e 'const p = await browser.getPage("shop"); ({ url: p.url(), title: await p.title(), shot: (await p.shot()).path })'
  doobie -e 'const p = await browser.getPage("embed"); await p.click("ref/f1e3"); (await p.ref("f1e3")).evaluate(e => e.textContent)'

## tips
  - Do not take both a snapshot and a screenshot by default; pick the cheapest check that answers the question.
  - Known selectors beat refs: page.click("#submit"); prefixes text/ aria/ xpath/ pierce/ work. Click never waits:
    waitForSelector/locator first when the element may still be loading.
  - --headless for unattended work; headed (default) to watch (separate profiles). Claude Code: allowlist `Bash(doobie *)`.
  - Long jobs: --idle-timeout 0 keeps the browser alive; `doobie stop` when done. -b NAME isolates logins/parallel work.
    For Google/OAuth logins use `doobie chrome` + `--connect`; automation-launched Chrome is often blocked.
