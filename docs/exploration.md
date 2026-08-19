# dev-browser v2 — Exploration / Design Input

Merged from 12 exploration reports over `ref/dev-browser` (Rust CLI + Node daemon + QuickJS/Playwright) and `do-browser` (Chrome extension + sandbox iframe + Puppeteer). All `file:line` citations are preserved from the reports; `[dev-browser]` / `[do-browser]` marks the repo.

## 1. Executive summary

- dev-browser today = Rust CLI (clap, ~1.5k lines) -> Unix socket NDJSON -> long-lived Node daemon -> per-request QuickJS WASM sandbox running a vendored Playwright *client* bundle bridged to an in-process Playwright server -> Chromium via `launchPersistentContext` or `connectOverCDP`.
- Measured: ~8ms CLI floor, ~100-150ms fixed per script (bundle eval ~75-95ms + init), ~1.0-1.1ms added per awaited Playwright call (setTimeout(0) in drain loop), +60ms per 128KB screenshot (base64 through interpreted JS).
- do-browser today = agent `bash` tool -> `js -e <<'EOF'` -> postMessage EVAL_REQUEST -> hidden sandboxed iframe running puppeteer-core 24.31 over a fake-Target CDP transport -> chrome.debugger on one tab. Output is plain-text `[Console Output]/[Return Value]/[Execution Time]`, images via `logImage` re-encoded to WebP <=1568px.
- do-browser parity surface (from e2e): globals `listTabs/createTab/closeTab/connectToPage/waitForPageLoad/getSnapshot/getElementByRef/clearInput/logImage/readFile/writeFile/listFiles/deleteFile/mkdir/exists/stat/bash`, expression-then-statement eval, console prefixes `[warn]/[error]/[info]`, YAML ARIA snapshot with `[ref=eN]`.
- Biggest lessons: exact-pin the automation lib (protocol drift broke every install), one absolute deadline per request incl. lock wait + launch + teardown, cancel on disconnect, bind-first cold start, never re-run side-effecting code on fallback, version-handshake CLI/daemon, keep defaults (not prompt text) agent-friendly.
- Biggest pain to design out: forked Playwright client in WASM, per-request sandbox rebuild, dropped return values, path-only screenshots, no `--json`, no single-browser stop, no read timeout, daemon logs discarded, invisible Node/npm two-step install.
- Puppeteer differences that matter: `puppeteer.connect({browserWSEndpoint|transport})`, ElementHandle-centric API (no Locator auto-wait by default, `page.locator()` exists), `waitUntil:'networkidle0/2'`, sync `page.url()`, sync `target._targetId`, no `snapshotForAI`/aria-ref engine (must port do-browser's in-page ARIA script).
- Open design questions center on: daemon vs. direct connect, sandbox boundary (QuickJS vs `node:vm` vs isolated-vm vs none), snapshot format/bounding, return-value channel, image channel, and timeout layering.

## 2. dev-browser today

### 2.1 Architecture (ASCII)

```
 agent shell
   |  dev-browser [flags] < script.js        (Rust binary, ~8ms; npm shim patched to exec binary directly)
   v
 cli/src/main.rs ---- ensure_daemon() ----> probe ~/.dev-browser/daemon.sock (daemon.rs:94-96)
   |                       | miss: flock daemon-spawn.lock, extract daemon.mjs/sandbox-client.js, spawn
   |                       |       `node ~/.dev-browser/daemon.mjs` setsid+stdio null, poll 100ms<=5s (daemon.rs:35-66,143-163)
   |  NDJSON {id,type:execute,browser,script,timeoutMs,idleTimeoutMs,headless?,ignoreHTTPSErrors?,connect?}
   v
 daemon/src/daemon.ts (net.createServer; 10M-char frame cap daemon.ts:30,482-498)
   |-- idleReaper.configure(idleTimeoutMs)            (daemon.ts:288-290)
   |-- executeRequest -> RequestSession(deadline)      (execute-request.ts:58-225)
   |      withBrowserLock(browser) {                   (lock.ts:26-61; per-name serialization)
   |        prepareBrowser: ensureBrowser/launchPersistentContext | connectOverCDP/autoConnect (browser-manager.ts:95-218,371-457)
   |        runScript -> new QuickJSSandbox per request (script-runner-quickjs.ts:41-69)
   |      }
   v
 QuickJS WASM (quickjs-emscripten 0.32, 512MB limit)         Node host
   [forked Playwright client bundle ~460KB]  --__transport_send-->  HostBridge: DispatcherConnection+PlaywrightDispatcher
   globals: browser{getPage,newPage,listPages,closePage},   <--__transport_receive--   (preLaunchedBrowser, sharedBrowser, denyLaunch)
   saveScreenshot/writeFile/readFile, console, setTimeout          (host-bridge.ts:29-52; quickjs-sandbox.ts:385-392)
   v                                                                 v
   page.* (Playwright Page + snapshotForAI/getByRef/cua/domCua)  -> in-process Playwright server -> Chromium
 stdout/stderr frames streamed back; terminal complete|error (execute-request.ts:95-107,159-176)
```

### 2.2 Request lifecycle

1. CLI reads script (stdin `read_to_string` main.rs:558-562 or file main.rs:275), resolves idle timeout (config.rs:57-64), builds request id `${prefix}-${epoch_ms}-${pid}` (main.rs:568-574).
2. `ensure_daemon`: throwaway connect probe; on miss flock + spawn + poll (daemon.rs:35-66). Two connects per command minimum (daemon.rs:36, main.rs:386).
3. Daemon parses with zod (protocol.ts:92-135), reconfigures idle reaper, enqueues per-connection promise queue (daemon.ts:506-517).
4. `RequestSession`: `deadline = now+timeoutMs` (default 30s daemon.ts:25), one unref'd timer emits `Script timed out after Ns and was terminated.` and aborts (execute-request.ts:82-92); transport disconnect aborts with `RequestDisconnectedError` (execute-request.ts:149-157).
5. Under per-browser keyed lock: `throwIfAbortedOrExpired` -> prepareBrowser (launch/connect gets `timeout = remaining deadline` browser-manager.ts:484-491) -> runScript -> check again (execute-request.ts:179-225). Queued request whose deadline passes never runs (execute-request.test.ts:55-92).
6. runScript: new `QuickJSSandbox`, `initialize()` (eval prelude + bundle via `new Function`, `connection.initializePlaywright()`), `executeScript(\`(async () => {\n${script}\n})()\`)` (script-runner-quickjs.ts:66), return value discarded (quickjs-sandbox.ts:557-588), anonymous pages closed at dispose (quickjs-sandbox.ts:580,745-772).
7. console.log/info -> `{type:'stdout',data}`; warn/error -> stderr frames (quickjs-sandbox.ts:634-642); CLI `print!`/`eprint!` + flush (main.rs:401-412).
8. Terminal `complete` -> exit 0; `error` (formatError: `Name: message\nstack`, format-error.ts:1-14) -> stderr, exit 1; EOF -> "Daemon connection closed unexpectedly" exit 1 (connection.rs:415-427). No CLI read timeout (connection.rs:392-396).

### 2.3 Agent-facing API table

| Command / global | Signature | Semantics | Source |
|---|---|---|---|
| run from stdin | `dev-browser [FLAGS] < script.js` | TTY stdin -> help, exit 2 | main.rs:339-349 |
| `run` | `dev-browser [FLAGS] run <FILE>` | flags must precede `run` (`--connect` num_args 0..=1 ambiguity) | main.rs:164-219 |
| `--browser` | `--browser <NAME>` default `default` | named persistent profile `~/.dev-browser/browsers/<name>/chromium-profile`; per-name lock | main.rs:106-162; browser-manager.ts:371-419 |
| `--connect` | `--connect [URL]`, missing = `auto` | DevToolsActivePort file then ports 9222-9229 (750ms probe); http -> /json/version; ws as-is | browser-manager.ts:129-218,535-647 |
| `--headless` / `--ignore-https-errors` | flags | differing from running instance relaunches browser (loses tabs) | browser-manager.ts:108-125 |
| `--timeout` | `--timeout <SECONDS>` >=1, default 30 | daemon-side deadline covering launch+script; not propagated to Playwright per-action timeouts | main.rs:99,357-359; execute-request.ts:120-239 |
| `--idle-timeout` | global; `30s|5m|1h|ms|0` | flag > `DEV_BROWSER_IDLE_TIMEOUT_MS` > `~/.dev-browser/config.json` > 0; last CLI call wins globally; launched browsers only | config.rs:23-64; idle-browser-reaper.ts |
| `install` | `dev-browser install` | `npm install` + `playwright install chromium` in ~/.dev-browser | daemon.rs:82-92,283-324 |
| `install-skill` | `[--claude] [--agents] [--codex]` | writes embedded SKILL.md; TTY multiselect else all three | skill.rs:240-334 |
| `browsers` | — | table NAME/TYPE/STATUS/PAGES | main.rs:453-503 |
| `status` | — | PID/Uptime/Browsers/Idle/Socket/Managed | main.rs:505-556 |
| `stop` | — | stops daemon + all browsers; no single-browser stop exposed (daemon has `browser-stop`) | main.rs:315-334; daemon.ts:320-333 |
| `--help` | — | long_about + clap + llm-guide.txt ~15KB (~4k tokens); no `--version` | main.rs:22-104; llm-guide.txt |
| exit codes | — | 0 complete; 1 error; 2 TTY-no-script/clap | main.rs:258-268 |
| `browser.getPage` | `(nameOrTargetId) -> Page` | named page created lazily, persists across scripts; 16+ hex id attaches existing tab unnamed | browser-manager.ts:229-248; quickjs-sandbox.ts:470-476 |
| `browser.newPage` | `() -> Page` | anonymous; closed at script end | quickjs-sandbox.ts:477-483,718-725 |
| `browser.listPages` | `() -> [{id,url,title,name|null}]` | CDP session per page for targetId; title race 1.5s | browser-manager.ts:255-293,875-938 |
| `browser.closePage` | `(name)` | named only; throws `Page "b/name" not found` | browser-manager.ts:295-309 |
| `saveScreenshot` | `(buf, name) -> absPath` | ~/.dev-browser/tmp, sanitized `[A-Za-z0-9._-]`, O_NOFOLLOW 0600 | quickjs-sandbox.ts:507-517; temp-files.ts:45-60,165-189 |
| `writeFile` / `readFile` | `(name,data)->path` / `(name)->string` | same jail; utf8 only | quickjs-sandbox.ts:518-537 |
| `console.*` | — | log/info stdout, warn/error stderr; util.inspect depth 6 | quickjs-sandbox.ts:38-51 |
| `setTimeout/clearTimeout` | — | host-backed; no setInterval/queueMicrotask | quickjs-host.ts:220-275 |
| `Buffer` / `URL` / `performance` | polyfills | Buffer.from(string) base64-only; toString('utf8') is Latin1; URL does no parsing | quickjs-sandbox.ts:282-358 |
| `page.snapshotForAI` | `({track?,depth?,timeout?}) -> {full, incremental?}` | Playwright aria snapshot, refs `eN`/`fNeN` | page.ts:1150-1157 |
| `page.getByRef` | `(ref) -> Locator` | validates `/^(?:f\d+)?e\d+$/`, `locator('aria-ref='+ref)` | page.ts:920-924 |
| `page.cua.*` | click/doubleClick/drag/move/scroll/keypress/type/screenshot | pixel coords; screenshot JPEG q80 css-scale -> `{path,width,height}`; `waitForNavigation` default false | cua.ts:42-237; cuaKeys.ts |
| `page.domCua.*` | getVisibleDom/click/doubleClick/scroll/type/keypress | `<tag node_id=N ...>` lines; 200/50 element budget, 200 lines/20k chars; stale error | domCua.ts:7-198; domCuaInjected.ts |
| blocked | require/process/fetch/WebSocket/import/TextEncoder/atob/crypto/structuredClone/setInterval | sandbox-security.test.ts:354-446 |
| wire | NDJSON `{id,type:execute|browsers|browser-stop|status|install|stop}` / `{stdout|stderr|result|complete|error}` | `result` never emitted for execute | protocol.ts:3-83; daemon.ts:308-364 |

### 2.4 Measured numbers (dev-browser, this machine, quickjs-emscripten 0.32 release-sync)

- CLI `--help` floor: ~8ms. End-to-end `console.log(1)` with warm daemon + headless browser: 103-156ms; `getPage + title`: ~150ms.
- `getQuickJS()` WASM 5-19ms first call; `newRuntime+newContext` ~4ms; eval bundle-as-string-literal ~14ms; `new Function(bundle)()` ~75-95ms (263ms cold); QuickJS heap after bundle+Connection ~2.8MB.
- Per awaited call inside sandbox: `page.title()` 1.25-1.31ms, `page.evaluate(()=>1)` 1.33-1.36ms, `locator.textContent` 1.2-1.4ms, guest `await setTimeout(0)` 1.1-1.2ms, hostCall `readFile` 0.16-0.19ms. Plain Playwright same ops 0.24/0.24/0.49ms. Cause: `setTimeout(0)` after each drain (quickjs-host.ts:418-420).
- Micro: host->guest `callFunction` ~10us; guest->host native call ~38us; guest JSON.stringify+parse small message ~23us; `new Error().stack` ~6us; full send->respond->settle ~106us.
- `page.screenshot()` 128KB: 104ms sandbox vs 44ms plain; `saveScreenshot` 36ms; `cua.screenshot` 187ms; `browser.newPage()` + auto-close ~70ms per request.
- `snapshotForAI` simple page: 12ms, 24k chars. Installed sandbox-client.js: 459,713 chars.
- No repo benchmarks of CLI cold/warm latency exist; only README's qualitative "near-instant startup" (commit 9ddbc13, later removed in 0.2.1).

### 2.5 Files and env

- `~/.dev-browser/{daemon.sock,daemon.pid,daemon-spawn.lock,daemon.mjs,sandbox-client.js,package.json,node_modules/,browsers/<name>/chromium-profile,tmp/,config.json}` (local-endpoint.ts:100-132; temp-files.ts:10).
- Env: `DEV_BROWSER_DAEMON` (.js/.mjs/.cjs via node, .ts via tsx, else exec; daemon.rs:171-233), `DEV_BROWSER_IDLE_TIMEOUT_MS`, `PW_CHROMIUM_ATTACH_TO_OTHER=1` default (daemon.ts:42-49).
- Embedded: `EMBEDDED_DAEMON`, `EMBEDDED_SANDBOX_CLIENT`, `EMBEDDED_PACKAGE_JSON` {playwright 1.58.2, playwright-core 1.58.2, quickjs-emscripten ^0.32.0} duplicated in daemon.rs:17-26 and daemon.ts:31-40; SKILL.md via skill.rs:199.
- Release: esbuild bundle (externals playwright/quickjs-emscripten/@jitl/*) -> 6 Rust targets -> npm OIDC + GitHub release binaries (release.yml:30-90; daemon/package.json:9).

## 3. do-browser today

### 3.1 Architecture (ASCII)

```
 LLM --bash tool--> just-bash (virtual fs /workspace) --`js -e <<'EOF'`--> execInSandbox(code, timeout)   (bash-tools.ts:392-486)
                                                                                  |
   sidepanel page / offscreen doc: SandboxHost -> CdpHandler   <--postMessage-->  hidden <iframe src=/sandbox.html> (CSP sandbox + unsafe-eval)
      |  EVAL_REQUEST{id,code,timeout} / EVAL_RESULT{output,hasError,images,aborted}     (CdpHandler.ts:168-213)
      |  CDP_REQUEST/CDP_RESPONSE/CDP_EVENT/CDP_ATTACH/CDP_CLOSE                          (SandboxTransport.ts:56-127)
      v
   ICdpBackend: LocalCdpBackend -> chrome.debugger.sendCommand({tabId,sessionId})        (LocalCdpBackend.ts:191-314)
                PortCdpBackend -> runtime.Port "dc-cdp" -> SW cdp-port-server -> LocalCdpBackend (remote/offscreen path)
      fake Browser.getVersion / Target.getBrowserContexts / setDiscoverTargets / setAutoAttach
      -> synthetic targets tabTargetId/pageTargetId, sessions tabTargetSessionId/pageTargetSessionId (LocalCdpBackend.ts:36-52,214-269)
      "pageTargetSessionId" -> chrome.debugger root session (284-290); other sessionIds passthrough (OOPIF/workers)
      + glow overlay inject (3 CDP calls) + Runtime.evaluate heartbeat every 3s (542-616)

   sandbox iframe: puppeteer-core-browser.js 24.31 connect({transport, defaultViewport:null}) -> waitForTarget(page) -> target.page()
     single-slot cache {cachedBrowser,cachedPage,cachedTabId} (sandbox/index.ts:76-78,614-685)
     globals: listTabs/connectToPage/createTab/closeTab/logImage/waitForPageLoad/getSnapshot/getElementByRef/clearInput/
              readFile/writeFile/listFiles/deleteFile/mkdir/exists/stat/bash/workspace/checkAbort/getAbortSignal (index.ts:782-829)

   remote "dc browser exec": dc CLI -> Worker /api/dc -> D1 -> ComputerLink DO -> WS {t:'exec'} -> ext SW -> offscreen -> same iframe
```

### 3.2 Eval lifecycle

1. `js` parses `-e code` | heredoc stdin (latin1->utf8 decode bash-tools.ts:53-56) | file; `--timeout <ms>` (bash-tools.ts:396-452).
2. `execInSandbox(code, timeout ?? 30000)` posts EVAL_REQUEST; host timer rejects `Execution timeout` at `timeout+1000` (CdpHandler.ts:168-213). JS_HELP says default 10000 (bash-tools.ts:68) — stale.
3. Sandbox: new AbortController, reset `logImageState`, monkeypatch console (warn/error/info prefixed) (index.ts:728-765).
4. Try `new Function(...globals, 'return (async () => { return (<code>); })()')`; on ANY throw (syntax, runtime, or timeout) retry `'return (async () => { <code> })()'`; each raced vs `setTimeout(reject Error('Timeout'))` — no cancellation (index.ts:831-845).
5. Success: `[Console Output]\n<logs|'(no console output)'>\n\n[Return Value]\n<formatValue>\n\n[Execution Time]\n<N>ms` (index.ts:851-879); error: `[Error]|[Aborted]\n<msg>\n\n[Console Output]...\n\n[Execution Time]` (880-917). formatValue: strings raw, objects `JSON.stringify(v,null,2)` (702-712).
6. `capSandboxOutput` 1,000,000 chars (output-size-guard.ts:1-22) -> EVAL_RESULT with `images: string[]` (PNG base64).
7. Host re-encodes images to WebP <=1568px q0.82 (CdpHandler.ts:22-23,492-601); `js` pushes to `pendingImages` side-channel; `bash` tool drains into image content parts or, for text-only models, writes `/workspace/screenshots/shot-N` + read_image hint (bash-tools.ts:381-385,826-857).
8. `capToolOutput` 30,000 chars: head + `[... TRUNCATED ...]` + 2000-char tail + spill to `/tmp/tool-outputs/js-<ts>.txt` with `sed -n '1,200p'` hints (tool-output-cap.ts:3-130). bash wraps `stdout:\n...\n\nexit code: N` (bash-tools.ts:806-820).
9. Abort: `{type:'ABORT'}` -> `currentAbortController.abort()`; cooperative only via `checkAbort()/getAbortSignal()` (index.ts:106-133; CdpHandler.ts:219-232). Debugger detached at every agent_end (use-redo-chat.ts:380) -> CDP_CLOSE -> cache cleared.

### 3.3 Agent-facing API table

| Command / global | Signature | Semantics | Source |
|---|---|---|---|
| `bash` tool | `{description (<=5 words), command}` | `stdout:/stderr:/exit code:` framing + image parts | bash-tools.ts:258-264,795-878 |
| `js` | `js -e '<code>'` / `js -e <<'EOF'` / `js <file>` / `--timeout <ms>` / `--help` | exit 1 if hasError | bash-tools.ts:392-486 |
| `readFile`/`writeFile` tools | `{path}` / `{path,content}` | readFile output uncapped | bash-tools.ts:880-951 |
| `read_image` | `{path, question?}` | vision: native image part; text-only: backend description | interpret-image.ts:7-123 |
| `listTabs` | `() -> [{id,title,url,active}]` | currentWindow query; 10s timeout | index.ts:157-190; LocalCdpBackend.ts:317-333 |
| `connectToPage` | `(tabId) -> Page` | activates tab (swallowed errors), single-slot cache, closes prev Browser, 10s timeouts on connect/waitForTarget/page | index.ts:614-685 |
| `createTab` | `(url?) -> TabInfo` | background tab unless activation allowed; not auto-connected | index.ts:198-232; LocalCdpBackend.ts:335-348 |
| `closeTab` | `(tabId)` | detaches debugger first; clears cache | index.ts:237-280 |
| `logImage` | `(base64Png) -> void` | PNG magic-byte check, throws otherwise; `[Image #N logged]`; no enforced cap (7 tested) | logImage.ts:50-74; eval-screenshots.spec.ts |
| `waitForPageLoad` | `(page,{timeout=2000,pollInterval=100}) -> {success,readyState,pendingRequests:0,waitTimeMs,timedOut}` | readyState poll only; never throws; logs 2 console lines | waitForPageLoad.ts:33-86 |
| `getSnapshot` | `(page) -> string` | YAML ARIA tree, main + same-origin iframes depth 3 appended | getPageSnapshot.ts:85-177 |
| `getElementByRef` | `(pageOrFrame, 'eN') -> ElementHandle` | resolves last snapshot of that frame only; throws listing all refs | getPageSnapshot.ts:68-76; ariaSnapshot.ts:817-823 |
| `clearInput` | `(el)` | focus, click x4, select, 50ms, Backspace | index.ts:326-353 |
| fs globals | readFile/writeFile/listFiles/deleteFile/mkdir/exists/stat | just-bash virtual fs RPC 30s | fs-message-client.ts:93-218 |
| `bash` global | `(cmd,{cwd?}) -> {stdout,stderr,exitCode}` | 60s; resolves on non-zero | fs-message-client.ts |
| `checkAbort`/`getAbortSignal` | — | cooperative abort; undocumented in prompt | index.ts:121-133 |
| hidden context | `[Active Tab] id=.. | title | url` before each prompt | use-redo-chat.ts:759-768 |
| `dc browser` (remote) | `list|exec [--name]|tabs|screenshot [--tab]` | exec default timeout 300s max 600s; stdout cap 256KiB; images dropped | browser-command.ts:29-285; protocol.ts:41-52; io.ts:51-59 |

### 3.4 Snapshot format spec (with example)

Mechanism: in-page IIFE `ARIA_SNAPSHOT_SCRIPT` (ariaSnapshot.ts:13-829, hand-port of Playwright's injected ariaSnapshot) injected via `frame.evaluate(string)` in MAIN world; idempotent (`if (window.__ariaSnapshot_get) return;` line 16). 2 CDP round trips per frame (inject + get), ~5 per same-origin iframe. Refs: `'e' + (++lastRef)` per-frame closure counter, cached on `element._ariaRef` and reused if role+name unchanged (663-672); assigned iff `box.visible && receivesPointerEvents` (665) — includes generic/img/heading. `window.__ariaSnapshotRefs` rebuilt each call (806-815). Root = `document.body`; aria-hidden-but-visible included; off-viewport elements with size included; no node/depth/char cap (only 900-char name omission at 753, generic collapsing 687/702-716).

Grammar (renderAriaTree 741-804): `- <role> ["<name>"] [checked|checked=mixed] [disabled] [expanded] [active] [level=N] [pressed|pressed=mixed] [selected] [ref=eN] [cursor=pointer]` then `: <inline text>` or child lines `  - /url: ...`, `  - /placeholder: ...`, `  - text: ...`; 2-space indent; keys YAML-quoted if needed (126-162). Iframes appended after parent YAML as `  # iframe eN (url):` + 4-space-indented child YAML, or `  # iframe eN: [cross-origin or inaccessible]` (getPageSnapshot.ts:115-149). Iframe refs restart at e1 (collide; refPrefix never wired, getPageSnapshot.ts:25 vs ariaSnapshot.ts:586).

Real example (Google homepage, 3,095 chars / 66 lines / 47 refs, 14ms eval; sample-v1-messages.json):
```
- generic [ref=e2]:
  - navigation [ref=e3]:
    - link "About" [ref=e4] [cursor=pointer]:
      - /url: https://about.google/?fg=1&...
    - generic [ref=e8]:
      - button "Search Labs" [ref=e16] [cursor=pointer]:
        - img [ref=e17]
      - 'button "Google Account: Sawyer Hood (kirbyhood@gmail.com)" [ref=e26] [cursor=pointer]':
        - img [ref=e28]
  - img "Google" [ref=e36]
  - search [ref=e44]:
    - generic [ref=e46]:
      - combobox "Search" [active] [ref=e55]
      - button "Google Search" [ref=e78] [cursor=pointer]
  - contentinfo [ref=e82]:
    - link "Privacy" [ref=e91] [cursor=pointer]:
      - /url: https://policies.google.com/privacy?hl=en&fg=1
    - button [ref=e96] [cursor=pointer]:
      - generic [ref=e97]: Settings
```
Other observed lines: `- heading "Filters and Topics" [level=1] [ref=e80]`, `- link [disabled] [ref=e95]:`, `- combobox "Search" [ref=e27]: eggs eggs` (input value inline), `- text: "-"`. Google SERP: 68,565 chars / 1,049 lines / 728 refs (max e1699), 37% `generic` lines -> hit 30k cap.

### 3.5 waitForPageLoad algorithm

Shipped (waitForPageLoad.ts:33-86): `console.log('[waitForPageLoad] Waiting up to Xms...')`; loop while elapsed < timeout(2000): `page.evaluate(() => document.readyState)`; if `'complete'` return `{success:true, readyState, pendingRequests:0, waitTimeMs, timedOut:false}`; swallow evaluate errors (navigating); sleep pollInterval(100). On timeout: one more evaluate; `{success: readyState==='complete', readyState, pendingRequests:0, waitTimeMs:timeout, timedOut:true}`; never throws. No network-idle, no DOM-stable check, no load-event listener; returns immediately if readyState already complete (useless right after a click that starts navigation). System prompt (system-prompt.md:466-512) describes a richer version (timeout 10000, poll 50, minimumWait 100, waitForNetworkIdle filtering ads/tracking) — that was dev-browser v1's client.ts:62-118, not what ships.

### 3.6 Remote path (`dc browser`) wire format, for reference

- Frames (`@dobrowser/dc-protocol` protocol.ts:60-147): `{t:'exec',id,command,env?,timeoutMs?}` -> `{t:'exec_result',id,stdout,stderr,exitCode}`; `read`/`file_chunk{seq,data,last}`; `write_begin/write_chunk/write_end` -> `ok`; `err{code: not_found|too_large|io|bad_request|busy|aborted}`; `revoked`; `PING_FRAME='{"t":"ping"}'`.
- Caps: `EXEC_STDIO_CAP` 256KiB/stream, `FILE_CHUNK_BYTES` 256KiB, `REMOTE_FILE_CAP` 25MiB, default exec timeout 300s, max 600s; close codes 4001 revoked / 4002 superseded (protocol.ts:41-52).
- Hops: dc CLI -> POST /api/dc -> D1 findComputer (uncached per call) -> DO `/exec` -> WS -> SW `core.ts` -> `dc-remote.ts` gate -> offscreen `execInSandbox` -> iframe; result: `hasError` -> stderr+exit 1 else stdout+exit 0, images dropped (io.ts:51-59). `screenshot` = exec writeFile b64 + DO `/read` + cleanup exec, returned via `files[]` side channel (browser-command.ts:153-285).
- Session gate: busy if local agent running; 60s idle teardown; notification + badge; Stop bumps generation -> `aborted` (remote-session.ts:15,280-411).

### 3.7 do-browser agent prompt doctrine (system-prompt.md, 1,347 lines)

- "Always inspect the page first... Never assume you know how a page is structured" (182-194); workflow snapshot -> find ref -> getElementByRef -> act -> new snapshot.
- Write/Run/Evaluate/Decide/Repeat loop; "Each `js` call should do ONE thing"; "Always return or log the current state"; plain JS in evaluate; explain before acting (196-216).
- Single call when atomic/read-only; multiple when verifying/branching/exploring (218-230). Verify starting position; verify targets before looping; reuse one worker tab; bash for heavy text (232-320).
- logImage: viewport over fullPage; limit 5 per call; always via logImage not raw base64 (378-409). Heredoc when >2 lines (48).
- Error recovery: screenshot + url/title; check state (url, title, bodyText 500, forms, buttons); try/catch with timeout 5000 (987-1046). Stale: spill path `/tmp/truncated-output...` vs real `/tmp/tool-outputs/` (1325-1331; tool-output-cap.ts:5).

## 4. Latency and token tricks catalog (merged, deduped)

Process/transport:
- Native Rust CLI, LTO/strip release profile; npm postinstall rewrites global bin symlink/.cmd/.ps1 to exec the binary (no Node on hot path) — `[dev-browser]` Cargo.toml:15-19; postinstall.js:274-341; RELEASING.md:344-349.
- Long-lived detached daemon keeps Node + Playwright + Chromium + named pages warm; liveness = bare socket connect — `[dev-browser]` daemon.rs:94-96,143-163.
- Embedded bundle extracted only when content differs (tmp+rename) — `[dev-browser]` daemon.rs:264-281.
- Cold start: flock spawn lock + 100ms poll <=5s instead of fixed sleep — `[dev-browser]` daemon.rs:40-65,98-120.
- Unix socket + NDJSON, no handshake RTT; stdout/stderr streamed and flushed per frame — `[dev-browser]` main.rs:401-412; execute-request.ts:95-107.
- WS held open from extension SW to DO; app-level PING every 25s keeps MV3 SW alive; DO `setWebSocketAutoResponse(PING->PONG)` answers from hibernation — `[do-browser]` connection.ts:24-25; computer-do.ts:320-325.
- Outbox (cap 100) + waiter grace `timeoutMs+10s` yields late-but-correct results over brief disconnects — `[do-browser]` core.ts:66,92-97; link-core.ts:55,137-142.
- Supersede stale socket (close 4002); backoff resets after >30s healthy — `[do-browser]` computer-do.ts:434-442; connection.ts:202-204.

Browser/session reuse:
- `ensureBrowser` reuses launched entry without Playwright calls if flags unchanged; connected entry reused if `isConnected()` — `[dev-browser]` browser-manager.ts:108-121,135-137,205-213.
- Named pages in a Map -> `getPage(name)` is lookup + `isClosed()` — `[dev-browser]` browser-manager.ts:229-235.
- Single-slot Browser/Page cache per tabId across evals — `[do-browser]` sandbox/index.ts:76-78,622-626.
- Lazy `chrome.debugger.attach` on first command; skip if same tab — `[do-browser]` LocalCdpBackend.ts:135,272-282.
- Fake browser-level Target domain answered locally; synthetic events deferred `setTimeout(0)` so response precedes events — `[do-browser]` LocalCdpBackend.ts:191-270.
- `connect({defaultViewport:null})` avoids `Emulation.setDeviceMetricsOverride` — `[do-browser]` sandbox/index.ts:643.
- Headed `viewport:null` (no emulation layer) — `[dev-browser]` browser-manager.ts:383-385.
- Offscreen host + SandboxHost created once and reused; 60s idle teardown — `[do-browser]` offscreen/main.ts:19-52; remote-session.ts:15.

Bounding/cancellation:
- One absolute deadline over lock wait + launch + script + teardown; queued-and-expired never runs; late output suppressed; exactly one terminal frame — `[dev-browser]` execute-request.ts:58-225.
- Abort propagates into Playwright `_activeProgressControllers`; guest `#abortWakeup` race — `[dev-browser]` host-bridge.ts:58-71; quickjs-sandbox.ts:622-628,662-679.
- Launch/connect timeout = remaining deadline — `[dev-browser]` browser-manager.ts:484-491.
- listPages title lookups concurrent with one shared 1.5s window (4500ms -> 1500ms) — `[dev-browser]` browser-manager.ts:259-286,875-891.
- Idle reaper: single unref'd timer at earliest deadline, recheck under lock — `[dev-browser]` idle-browser-reaper.ts:107-145,166-196.
- Per-call 10s/5s timeouts on attach/connect/waitForTarget/page/close so dead sessions fail fast — `[do-browser]` sandbox/index.ts:600-607,632-676.
- Host timeout `timeout+1000` so sandbox's own Timeout (with console logs) usually wins — `[do-browser]` CdpHandler.ts:173-181.
- 10M-char frame cap with synchronous socket pause — `[dev-browser]` daemon.ts:482-498.

Sandbox internals:
- Bundle source cached in module-level promise; WASM module cached after first `getQuickJS()` — `[dev-browser]` quickjs-sandbox.ts:36,61-69.
- Host->guest inbox drained whole in one loop; host-call results resolve in microtasks (no setTimeout hop: 0.17ms vs 1.3ms) — `[dev-browser]` quickjs-sandbox.ts:692-702; quickjs-host.ts:338-341.
- `Promise.race(pendingHostOperations)` wake-up instead of pure polling — `[dev-browser]` quickjs-sandbox.ts:673.
- Transport dispatches onmessage in a fresh macrotask (matches WS transport semantics) — `[do-browser]` SandboxTransport.ts:82-90.
- Expression-first eval so `2+2` / `await page.title()` need no `return` — `[do-browser]` sandbox/index.ts:833-837.

Token economy:
- SKILL.md ~900 bytes defers to `--help`; guide loaded on demand — `[dev-browser]` SKILL.md:19; skill.rs:199.
- Guide doctrine: "one decision-sized step", batch inspect/act/verify when target known, "log only the state needed", "cheapest state check; don't take both snapshot and screenshot", short `--timeout 10` and `{timeout:5000}` everywhere, `domcontentloaded` on dev servers — `[dev-browser]` llm-guide.txt:2-6,40-45,105-120,191.
- `snapshotForAI({track})` -> log `.incremental` diff after acting — `[dev-browser]` llm-guide.txt:27-38.
- `cua`/`domCua` click `waitForNavigation` default false (removed ~1s grace + up to 10s load) — `[dev-browser]` cua.ts:48,227-237; commit a5ecfca.
- domCua budgets 200/50 elements, 200 lines/20k chars, 160-char text, viewport-visible interactive only — `[dev-browser]` domCua.ts:7-12; domCuaInjected.ts:189,206.
- cua.screenshot JPEG q80 `scale:'css'` -> 1:1 coords at any DPR — `[dev-browser]` cua.ts:156-183.
- Screenshots returned as paths, not inline — `[dev-browser]` llm-guide.txt:97-103.
- Images PNG -> WebP <=1568px q0.82 on host, attached as content parts not text; text-only fallback via `read_image` — `[do-browser]` CdpHandler.ts:22-23,492-576; bash-tools.ts:829-857.
- Two-layer output cap: 1MB in sandbox, 30k chars head/tail + spill file + `sed -n` paging — `[do-browser]` output-size-guard.ts; tool-output-cap.ts:3-130.
- Plain-text result sections, strings unquoted, `(no console output)` placeholder — `[do-browser]` sandbox/index.ts:702-713,852-865.
- Hidden `[Active Tab]` context message avoids a `listTabs()` call — `[do-browser]` use-redo-chat.ts:759-768.
- Prompt: small scripts, return state at end, reuse one worker tab, bash pipelines for heavy text, "be terse" — `[do-browser]` system-prompt.md:15,208-230,266-320.
- Screenshot bytes bypass model context via `files[]` side channel / chunked `file_chunk` frames — `[do-browser]` browser-command.ts:153-178; dc-cli/main.ts:126-139.
- Snapshot token reducers: inline-generic collapse, nameless generic unwrap, single-text inline, `[cursor=pointer]` only outermost, name==text dedupe, names>900 dropped — `[do-browser]` ariaSnapshot.ts:687,702-716,734,753,785-794.
- Ref stability via `_ariaRef` expando enables reuse without re-snapshot — `[do-browser]` ariaSnapshot.ts:666-669.
- Claude Code allowlist `Bash(dev-browser *)` removes permission prompts — `[dev-browser]` README.md:116-162.
- Benchmark claim: 29 turns/3m53s/$0.88 vs Playwright MCP 51/4m31s/$1.45 — `[dev-browser]` README.md:205-214.

## 5. Parity checklist for v2

dev-browser CLI / daemon behaviors:
- [ ] Script from stdin (non-TTY) and `run <FILE>`; TTY + no subcommand -> help exit 2 (main.rs:339-349)
- [ ] `--browser NAME` named persistent profile; per-name serialization (browser-manager.ts:371-419; lock.ts)
- [ ] `--connect [URL|auto]` with DevToolsActivePort + port 9222-9229 discovery, http /json/version, ws passthrough, 404 fallback, helpful error with launch command (browser-manager.ts:129-218,739-768; auto-connect.test.ts)
- [ ] `--headless`, `--ignore-https-errors` (relaunch semantics, or better: no relaunch) (browser-manager.ts:108-125)
- [ ] `--timeout SECONDS` default 30; message `Script timed out after Ns and was terminated.`; covers launch+script; queued-expired never runs; late output suppressed; one terminal frame (execute-request.test.ts:55-231)
- [ ] Client disconnect cancels in-flight script and pending browser ops within ~2s; page reusable immediately (sandbox-integration.test.ts:191-249)
- [ ] `--idle-timeout` (flag > env > config.json > off), launched-only, recheck under lock (idle-browser-reaper.test.ts)
- [ ] `browsers`, `status`, `stop`; ADD single-browser stop (#107/#108/#128 open)
- [ ] `install-skill [--claude|--agents|--codex]` with TTY multiselect / non-TTY all (skill.rs:292-334,427-473)
- [ ] Exit codes 0/1/2; stdout/stderr streaming in order (main.rs:392-430)
- [ ] Cold start: spawn lock, bind-first with stale-socket probe, pid after bind, ownsEndpoint cleanup (daemon.ts:436-459,539-542; daemon.rs:35-66)
- [ ] Frame cap on request size (daemon.ts:30,482-498)
- [ ] Graceful shutdown: stop accepting, stopAll, 500ms socket grace, unlink only if owner (daemon.ts:379-411)
- [ ] Windows named pipe endpoint (or explicit non-goal) (local-endpoint.test.ts:12-34)
- [ ] `PW_CHROMIUM_ATTACH_TO_OTHER`-class Chrome 147 attach workaround if relevant to Puppeteer (daemon.ts:42-49)

dev-browser script globals:
- [ ] `browser` frozen null-prototype exactly `[closePage,getPage,listPages,newPage]` (sandbox-security.test.ts:445-446)
- [ ] `getPage(name)` persists URL/title/window.name across scripts; `getPage(targetId)` attaches existing tab unnamed (named-pages.test.ts:90-125; browser-manager-pages.test.ts:87-105)
- [ ] `newPage()` anonymous closed after script (named-pages.test.ts:127-156)
- [ ] `listPages()` -> `[{id,title,url,name|null}]`; bounded title lookup (named-pages.test.ts:158-201; browser-manager-title-timeout.test.ts)
- [ ] `closePage(name)` (named-pages.test.ts:203-237)
- [ ] `saveScreenshot/writeFile/readFile` jailed to tmp dir; sanitization `[A-Za-z0-9._-]`, reject `..`, absolute, null byte, symlink; `page.screenshot({path})` rewritten (sandbox-file-io.test.ts:116-275)
- [ ] `console.log('sandbox',42,{ok:true})` -> `sandbox 42 { ok: true }`; nothing on host stdout; stderr empty in normal ops (sandbox-integration.test.ts:251-265; sandbox-security.test.ts:478-495)
- [ ] `Buffer.isBuffer`, `setTimeout/clearTimeout` (sandbox-integration.test.ts:267-285)
- [ ] No require/process/fetch/WebSocket/import/constructor-chain escape; memory limit -> /out of memory/; `while(true)` -> interrupted (sandbox-security.test.ts:354-403)
- [ ] Page API matrix: goto(waitUntil)/url/title/waitForURL glob/goBack/goForward/reload; content/textContent/innerHTML/innerText/getAttribute; evaluate/$eval/$$eval; fill/type/press/check/uncheck/isChecked/selectOption/click; waitForTimeout/waitForSelector(state)/waitForFunction/isHidden; locator chain+filter+all+first/last/nth; screenshot/fullPage; keyboard/mouse; `page.on('console')`; frames (playwright-api.test.ts) — map each to Puppeteer equivalent or documented gap
- [ ] `page.snapshotForAI({track,depth,timeout}) -> {full, incremental?}` and `getByRef('e12'|'f2e5')` incl. iframe refs (playwright-api.test.ts:732-813) — needs a Puppeteer-side implementation
- [ ] `page.cua.*` full contract: button validation msg, modifiers hold/release on error, key aliases + chord rewrites (ctrl+y), drag steps, scroll, screenshot dims/clip/fullPage/downscale, navigation settle opt-in (cua.test.ts:373-936)
- [ ] `page.domCua.*` full contract: line format, attr order, budgets/truncation markers, sticky ids >=1e6 via sessionStorage, staleness after reload/nav/cross-origin/frame nav, cross-invocation ids, string nodeId coercion (dom-cua.test.ts:430-971)
- [ ] Error text `Name: message` + stack; timeout message only (format-error.test.ts)
- [ ] `--help` long guide content (llm-guide.txt:1-192) and SKILL.md trigger phrases (SKILL.md:2-3)

do-browser behaviors (e2e + source):
- [ ] Eval globals: listTabs/createTab/closeTab/connectToPage/waitForPageLoad/getSnapshot/getElementByRef/clearInput/logImage/readFile/writeFile/listFiles/deleteFile/mkdir/exists/stat/bash (+ workspace/checkAbort/getAbortSignal) (sandbox/index.ts:782-829)
- [ ] Expression-mode then statement-mode eval; top-level await; `const x=1;` -> `undefined` (eval-basic.spec.ts; eval-errors.spec.ts:31-35) — but do NOT re-run on runtime errors
- [ ] Output sections `[Console Output]`/`[Return Value]`/`[Execution Time] Nms`; `[Error]`/`[Aborted]` first on failure with console preserved (eval-basic.spec.ts; eval-errors.spec.ts:43-51)
- [ ] Console prefixes `[warn]`/`[error]`/`[info]`; console.error does not set hasError (eval-basic.spec.ts:17-34)
- [ ] Return formatting: string raw, null/undefined literal, objects pretty JSON (index.ts:702-713)
- [ ] Timeout: hasError + 'Timeout' or rejection /[Tt]imeout/ (eval-errors.spec.ts:16-29)
- [ ] `listTabs` shape `{id:number,title,url,active}`; `createTab()`/`createTab(url)`; `closeTab` reduces count by 1 (eval-navigation.spec.ts)
- [ ] `connectToPage` Page: goto/goBack/goForward/reload/title/url(sync)/click/type/select/hover/focus/$/$eval/evaluate/waitForSelector({visible})/screenshot({encoding:'base64'}) (eval-interaction.spec.ts; eval-navigation.spec.ts)
- [ ] `waitForPageLoad` result shape and never-throw (eval-page-load.spec.ts; waitForPageLoad.ts:16-27)
- [ ] `getSnapshot` YAML: role words ('navigation','searchbox'/'textbox'), names, `/e\d+/` ref on same line as name (eval-snapshot.spec.ts:16-98)
- [ ] `getElementByRef` -> ElementHandle with `.evaluate`, `.type` (eval-snapshot.spec.ts:77-114)
- [ ] `clearInput` then type replaces (eval-interaction.spec.ts:65-83)
- [ ] `logImage` accumulates 1/3/7 images; PNG only (eval-screenshots.spec.ts)
- [ ] fs: write/read/mkdir/exists/listFiles/stat/deleteFile (dirs too) under /workspace (eval-filesystem.spec.ts)
- [ ] `bash(cmd)` pipes, `>&2`, `exit 42`, resolves non-zero (eval-bash.spec.ts)
- [ ] 1MB sandbox cap + 30k tool cap with spill + paging hints (output-size-guard.ts; tool-output-cap.ts)
- [ ] Images -> WebP <=1568px q0.82, no upscale (CdpHandler.test.ts:223-332)
- [ ] Remote `dc browser exec|tabs|screenshot` semantics if in scope (browser-command.ts:188-288)

Docs/ergonomics parity:
- [ ] SKILL.md with trigger phrases + install + idle-timeout paragraph; auto-overwrite on install (SKILL.md:1-21; skill.rs:336-421)
- [ ] Guide sections: script-size doctrine, snapshot/ref workflow, approach selection, cua/domCua workflows, screenshots, waiting, dev-server domcontentloaded, error recovery, cheat sheet, --connect, tips (llm-guide.txt:1-192)
- [ ] PowerShell here-string docs (README.md:44-61)
- [ ] Claude Code `Bash(dev-browser *)` allowlist recipe (README.md:116-162)
- [ ] `[Active Tab]`-style context hint equivalent for CLI (e.g. `browsers`/`status` compact) (use-redo-chat.ts:759-768)
- [ ] do-browser `js --help` text / JS_HELP equivalent (bash-tools.ts:58-210)

Security parity:
- [ ] Temp-dir jail: reject absolute, `..`, null bytes, symlinks (base and targets), O_NOFOLLOW, 0600 (temp-files.ts:45-60,72-108,133-145,165-206)
- [ ] No host-path reachability through automation APIs (setInputFiles/saveAs/har; #109, PR #113)
- [ ] Sandbox has no require/process/fetch/WebSocket/import; memory + CPU limits (sandbox-security.test.ts)
- [ ] Browser name sanitized as path segment (PR #120)
- [ ] Binary/download checksum (#73 C1)

## 6. Lessons from history (problems fixed; what to design out)

- Protocol drift: caret `^1.52.0` vs validators built for 1.58.2 -> npm resolved 1.59 -> `ValidationError` on every script on every platform (#89/#90/#93; fixed by exact pin 5459700). Design out: no shipped protocol-validated client copy; pin Puppeteer exactly; bundle it.
- v1 -> 0.2.0 rewrite deleted the extension/relay and replaced `client.page(name)`, `getAISnapshot`, `waitForPageLoad` with CLI + named pages + `snapshotForAI`; ~25 v1 issues closed wholesale (9ddbc13). v1 client imported 12.4MB Playwright per agent process (PR #25).
- Hangs bounded one by one: listPages title (#71, ea752ba, 1.5s race then concurrent in #118); absolute request deadline incl. lock queue/setup/teardown + cancel-on-disconnect (#118 execute-request.ts); Chrome 147 connectOverCDP hang (#103, `PW_CHROMIUM_ATTACH_TO_OTHER=1`, env change needs daemon restart); heavy-JS sites hanging `page.evaluate`/snapshots (v1 #36/#43, `waitUntil:'commit'` workaround); relay attaching to worker targets (v1 #42). Design out: every await bounded by one budget, from day one.
- Daemon races: duplicate daemons on cold start (#110 -> flock + bind-first + ownsEndpoint), browser-stop racing scripts (#111 -> same lock), unbounded frame buffer (#112 -> 10M cap), concurrent `npm install` corruption (#73/#76 -> mutex). Design out: minimal daemon surface, restart cheap and versioned.
- Error messages dropped until 0.2.8 (QuickJS `Error.stack` lacks header; format-error.ts). Design in: structured error frame with name/message/stack separately.
- Headed viewport emulation mismatch (#86 -> `viewport:null`); `--ignore-https-errors` needed flag (#78); `--browser` unsanitized path segment (PR #120 open).
- Navigation-wait flip: cua/domCua click implicit ~1s grace + 10s load (0.2.8) -> default off (#118). Design in: explicit, documented, stable defaults.
- domcontentloaded: maintainer refused to patch Playwright defaults (#97/#98), fixed in guide only (fc0184b). `--timeout` doesn't govern per-action 30s defaults (PR #120). Lesson: defaults beat prompt text; wire `--timeout` into action timeouts.
- Google sign-in impossible with automation-launched Chrome (#130, #9); only OS-spawned Chrome + later CDP attach works; Chrome 136+ ignores remote-debugging flags on default profile. Design in: first-class attach-to-user-Chrome path.
- Windows: named pipes (#66), EBUSY, PowerShell here-strings (#85), pipe-handle inheritance hang on cold start (#116 open), Job Object kills daemon (PR #129 open).
- Sandbox escape via raw Playwright objects (`setInputFiles('/etc/passwd')`, #109; PR #113 deny-list). Design in: allow-list of host-touching operations.
- Security audit #73: unverified binary download (C1), dead `vm` runner removed (C2), install races (I5).
- Stop-one-browser asked 4 times, never shipped (#69, #107/#108, #128, PR #122); idle reaper shipped disabled (#128).
- Guide churn: every behavior change required rewriting llm-guide + 3 SKILL.md copies; 0.2.9 made non-interactive install overwrite all.
- do-browser: expression/statement fallback double-executes on runtime error/timeout (index.ts:831-845); timeout defaults inconsistent (10s docs vs 30s host); `pendingRequests` hardcoded 0; stale system prompt (helper count, deleteFile, spill path, non-Puppeteer `page.textContent`).

## 7. Pain points / things NOT to carry forward

- Forked, `@ts-nocheck`'d Playwright client + protocol validators inside QuickJS; bundle parsed twice (string literal + `new Function`) per request; ~100-150ms floor; no pooling/bytecode cache (quickjs-sandbox.ts:365-377; forked-client/README.md).
- `setTimeout(0)` in the await-drain loop -> ~1ms per awaited call (5x plain) (quickjs-host.ts:418-420).
- Binary as base64 through JSON and a pure-JS Buffer polyfill (+60ms/128KB screenshot); `Buffer.from('text')` throws; `toString('utf8')` is Latin1; `URL` stub (quickjs-sandbox.ts:241-352).
- Return values discarded (`executeScript -> void`); `result` frame never sent for execute; agent must `console.log(JSON.stringify(...))` (quickjs-sandbox.ts:557-588; main.rs:435-445).
- Errors: `QuickJS promise rejected:` prefix, duplicated message+call log, ANSI dim codes from webColors, `<input>:N:N` frames, missing `page.click:` apiName, offset line numbers (quickjs-platform.ts; quickjs-host.ts:566-571).
- Three timeout layers (CPU interrupt, guest wrapper, RequestSession) with inconsistent messages (tests accept /timed out|terminated|interrupted/).
- Page objects discovered via `setTimeout(0)` polling up to 1000 attempts (quickjs-sandbox.ts:437-451); `__create__` fan-out for every existing context/page/frame on init.
- `page.on('console')` events only during drain; lost after settle; listener errors latched to unrelated await.
- Per-page CDP session + `Target.getTargetInfo` + detach in `listPages` (browser-manager.ts:893-938); names live only in memory (lost on daemon restart).
- Two connects per command; no request-id matching; no read timeout; daemon stdio nulled (no crash diagnostics); no version handshake; idle-timeout global mutable state; config.json read per run.
- `--connect` num_args 0..=1 swallows `run`; no `--version`; no `--json`; no script args; ~15KB `--help` dump with near-empty SKILL.md; docs duplicated in 4 places.
- Two-step install (npm binary download without checksum, then `npm install` + `playwright install chromium`), hard Node/npm dependency at runtime, `.npmrc` ignored (#101), duplicated package.json/pipe-name/target tables across Rust and TS.
- Headless/ignoreHTTPSErrors toggle relaunches browser; connected entries linger as `disconnected` zombies; `closePage` name-only.
- Per-browser lock wraps whole script: one long script blocks everything on that browser; no parallel tabs in one browser.
- Three element-targeting tiers (aria refs, domCua ids, cua coords) plus raw selectors, each with its own staleness rules; guide spends many lines on choosing (llm-guide.txt:40-95).
- domCua serialized-function fragility (`String(fn)`, no minify), sessionStorage id scheme, frameKey `${url}@${indexPath}` collisions; cua.screenshot OffscreenCanvas re-encode workaround (cua.ts:178-211).
- do-browser: four serialization hops per CDP message (+2 in remote mode), glow overlay 3 CDP calls + 3s heartbeat, ACTIVATE_TAB round trip per connectToPage, debugger detach at every agent_end (full re-connect next turn), single-slot tab cache thrash, fake static targetInfo, unguarded `handleSandboxMessage` source, never-cleared timeout timers, console monkeypatch not safe for concurrent evals, PNG-only `logImage`, uncapped `readFile` tool, required `description` param per bash call, `stdout:`+section boilerplate, no streaming output, 300s remote default timeout, base64-of-base64 screenshot path, images dropped on remote path, snapshot refs on every visible element (728 refs on a SERP), iframe ref collisions, MAIN-world globals/expandos, no snapshot bounding.

## 8. Puppeteer vs Playwright: concrete differences that matter

- Connect over CDP: dev-browser uses `chromium.connectOverCDP(endpoint,{timeout})` and `contexts[0] ?? newContext()` (browser-manager.ts:421-457) plus `launchPersistentContext` (371-419); do-browser uses `puppeteer.connect({transport, defaultViewport:null})` + `browser.waitForTarget(t=>t.type()==='page')` + `target.page()` (sandbox/index.ts:641-677) over a custom `ConnectionTransport`. Puppeteer offers `browserWSEndpoint`/`browserURL` (fetches /json/version) and custom `transport` natively — no equivalent of Playwright's in-process dispatcher/server split, so there is no need (and no way) to run a "client" bundle against a server; the Puppeteer `Browser` object is the only handle, and it must live where the CDP socket lives.
- Launch: Puppeteer `launch({userDataDir, headless, ignoreHTTPSErrors, defaultViewport:null, args})` uses a system/bundled Chrome via `@puppeteer/browsers` — replaces `playwright install chromium` (daemon.rs:283-324) and the persistent-context model; there is no BrowserContext-per-profile, the default context is the profile.
- Target/page identity: Puppeteer `page.target()._targetId` / `target.url()` are synchronous; dev-browser pays a CDP session per page to get targetId and a title race (browser-manager.ts:893-938). Puppeteer `target.page()` can attach any existing tab, and `browser.targets()` + `targetcreated` events replace `listPages` round trips. But do-browser's fake Target model (static `about:blank` infos, single tab) shows what breaks when discovery is synthesized (LocalCdpBackend.ts:36-52; pain points).
- Locators vs ElementHandle: dev-browser's whole targeting surface is Locator-based (`getByRef -> locator('aria-ref=')`, `locator.filter/all/nth`, auto-wait, actionability) (page.ts:920-924; playwright-api.test.ts:632-715). Puppeteer's tests/evals use `page.$`, `$eval`, `ElementHandle.click/type/evaluate`, `waitForSelector({visible})` (eval-interaction.spec.ts); Puppeteer has `page.locator()` (with wait/actionability) but no `aria-ref` engine, no `getByRole`, no `filter({hasText})`. `getByRef` must be implemented as `getElementByRef` (do-browser ariaSnapshot `window.__ariaSnapshotRefs`, getPageSnapshot.ts:68-76) or via `Runtime.callFunctionOn` on the in-page ref map.
- Auto-wait/timeouts: Playwright actions carry 30s actionability auto-wait; dev-browser asks the agent to pass `{timeout:5000}` and PR #120 wants `context.setDefaultTimeout` tied to `--timeout`. Puppeteer ElementHandle actions do not auto-wait (click on detached/hidden throws or scrolls), `page.setDefaultTimeout/setDefaultNavigationTimeout` exist, `protocolTimeout` default 180s guards hung CDP (do-browser has no per-command timeout; CdpHandler.ts:298-308 pain point).
- networkidle: Playwright `waitUntil:'networkidle'` (500ms quiet) vs Puppeteer `'networkidle0'`/`'networkidle2'`; neither filters ads/tracking — hence v1's custom `waitForPageLoad` (client.ts:62-118) and do-browser's readyState poll; dev-browser's guide pushes `domcontentloaded` (llm-guide.txt:116-120).
- Snapshots: Playwright ships `_snapshotForAI` with tracked `incremental` diffs and `aria-ref` selectors (page.ts:1150-1157); Puppeteer has only `page.accessibility.snapshot()` (CDP AX tree, no refs). v2 must port do-browser's in-page ARIA script (ariaSnapshot.ts:13-829) — optionally into an isolated world, with bounding and frame-prefixed refs.
- Tracing/artifacts: dev-browser stubs tracing/video/HAR/artifacts in the fork (forked-client/README.md:154-182) — not agent-facing; Puppeteer `tracing.start/stop` and `page.pdf()` exist natively if wanted.
- Screenshots: Playwright `scale:'css'` ignored on `viewport:null` forced cua's OffscreenCanvas workaround (cua.ts:178-211); Puppeteer `screenshot({encoding:'base64', type:'jpeg', quality, captureBeyondViewport, clip})` returns base64 directly (do-browser uses `encoding:'base64'` for `logImage`, eval-screenshots.spec.ts).
- Events/console: Playwright `page.on('console')` only fired during drain in QuickJS (pain point); Puppeteer `page.on('console')` is a normal Node EventEmitter if the script runs in Node or a sandbox sharing the event loop.
- CDP session access: Playwright `context.newCDPSession(page)`; Puppeteer `page.createCDPSession()` / `page._client()` — cheaper raw CDP for things like `Target.getTargetInfo`, `Emulation`, `Input.dispatch*` (cua tier).
- Key naming: Playwright `ControlOrMeta`, `keyboard.down/up/press` (cuaKeys.ts maps ctrl -> ControlOrMeta); Puppeteer has no `ControlOrMeta` — chord rewrites need platform detection.
- Bundling: do-browser bundles `puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js` with a BidiMapper stub (wxt.config.ts:69-72); in Node no shim needed, but `puppeteer-core` pulls chromium-bidi and ws — size/startup to measure.

Puppeteer-side mapping of dev-browser test matrix (playwright-api.test.ts) to verify during design:
- `page.textContent/innerHTML/innerText/getAttribute/inputValue/isChecked/isHidden` -> `$eval` helpers (Puppeteer has none of these on Page; do-browser prompt wrongly lists them, system-prompt.md:805-953).
- `page.fill` -> `ElementHandle.type` after `clearInput` (do-browser index.ts:326-353) or `evaluate` set value + input event; `page.check/uncheck/selectOption` -> `click`/`page.select`.
- `waitForURL(glob)` -> `page.waitForFunction` on location or `waitForNavigation` + URL match; `waitForLoadState` -> `waitForNavigation({waitUntil})`.
- `locator.all()/filter/nth` -> `page.$$` + filtering in evaluate, or `page.locator()` (limited).
- `page.on('console')` identical; `page.frames()/mainFrame()/childFrames()` identical; `frame.locator` -> `frame.$`.
- `page.keyboard/mouse` near-identical (no `ControlOrMeta`; `mouse.wheel({deltaX,deltaY})` signature differs).
- `elementHandle.screenshot({path})` exists; path jail rewrite must be reimplemented.

## 9. Open questions for the design/grilling session

1. Daemon or no daemon? Puppeteer can `connect({browserWSEndpoint})` per invocation (Chrome keeps running via `--remote-debugging-port`), removing daemon lifecycle bugs (#110-#112, #116, logs nulled) at the cost of per-call Node startup (~40-80ms) + connect + target discovery. Tradeoff: warm named pages/locks/idle reaper vs zero long-lived state.
2. If a daemon: Rust CLI + Node daemon again, or single Node binary (SEA/bun) with a thin client? Rust saves ~30-60ms per call but duplicated tables (package.json, pipe names, targets), include_str! build coupling, no version handshake. What is the measured floor we are targeting (none recorded in repo)?
3. Sandbox boundary: QuickJS WASM (current: ~100-150ms + 1ms/call + base64 binary), `node:vm` (shares event loop, weak isolation, dead runner removed in #73 C2), `isolated-vm`, worker thread, or no sandbox with a host-touching allow-list (PR #113)? Who is the threat — page content, or the agent script? README sells "Bash(dev-browser *)" allowlist on the sandbox.
4. Per-request sandbox rebuild vs pooled/warm context: must named-page state, listeners (`page.on('console')`), and timers survive between scripts? Pooling breaks "fresh globals" tests (sandbox-security.test.ts:430-446).
5. Return-value channel: keep console-only (dev-browser), or do-browser's `[Return Value]` sections, or a `--json` frame `{stdout,stderr,result,error,images,durationMs}`? Tradeoff: token cost of boilerplate vs machine-parseable output (tests split on '[Return Value]').
6. Eval mode: expression-first with statement fallback (must not re-run on runtime error — detect SyntaxError at `new Function` construction only) vs dev-browser's async-IIFE wrapper with explicit `return`? 
7. Image channel: path under a tmp jail (dev-browser), inline base64 blocks in JSON, or `logImage`-style side channel with WebP <=1568px? How does a CLI hand an image to Claude Code/Codex without a Read round trip?
8. Snapshot engine: port do-browser's in-page ARIA script (2 CDP RTs, no bounding, refs on all visible, iframe collisions) or a new walker with viewport/interactive-only modes, node/char caps, frame-prefixed refs (`f2e5`), tracked incremental diffs (Playwright parity), isolated world? What's the default mode and budget (SERP = 68KB)?
9. Element targeting tiers: keep all three (aria refs, domCua node ids, cua coords) or collapse domCua into the snapshot (refs + bounding boxes) and keep cua as the vision tier? Each tier costs guide lines and staleness rules.
10. Auto-wait semantics on Puppeteer: expose `page.locator()` (auto-wait) as the primary API, `ElementHandle` for do-browser parity, or both? How does `--timeout` propagate to `setDefaultTimeout` and per-action waits (PR #120)?
11. Timeout layering: one absolute deadline (request) + per-action default derived from it, versus separate CPU/wall/host layers with different messages. What message/exit code on expiry, and does partial stdout survive?
12. Page identity and naming: names in daemon memory (lost on restart) vs persisted (profile dir / `window.name` / Target id mapping); expose targetIds stably without per-call CDP attach (PR #127)?
13. Concurrency: per-browser lock serializing whole scripts (safety, simple) vs per-page locks / parallel scripts in one browser. Does any agent rely on serialization?
14. Attach to real user Chrome (Google sign-in #130): first-class `--connect auto` with DevToolsActivePort discovery, or an extension relay like v1/do-browser (chrome.debugger, infobar, one tab at a time)? Non-goal for v2?
15. Install story: single static binary bundling Node runtime + puppeteer-core + `@puppeteer/browsers` download of Chrome for Testing, vs npm + `dev-browser install`. Checksum verification (#73 C1)? Custom executable path (PR #35)?
16. Idle/cleanup: idle reaper default on (5m?) vs off; `stop <name>`; daemon self-exit when no browsers; explicit `doctor --gc` (PR #122)?
17. Output caps: adopt do-browser's 1MB/30k head-tail + spill file, or stream unbounded and trust the agent? Where does the spill live in a CLI (tmp jail)?
18. Windows: named pipes + Job Object breakaway + PowerShell docs, or Unix-only for v2?
19. Docs delivery: ~15KB `--help` + 900-byte SKILL.md vs a compact SKILL.md with API table and `--help` topics (`--help snapshot`), given guide churn and four duplicated copies.
20. Script arguments/env (`--arg k=v`, `--json-args`) and `--version`/capabilities handshake — needed for v2 day one or deferrable?
21. Remote mode (serve/MCP/`dc browser`-style WS): in scope? It constrains the transport (NDJSON over socket vs frames over WS with 256KiB caps, outbox, grace windows).
22. Anonymous-page policy: auto-close `newPage()` tabs at script end (dev-browser) vs leave tabs open and rely on `closeTab` (do-browser). Auto-close costs ~70ms/request and loses state on error; leaving them leaks tabs.
23. Console/event delivery: stream stdout frames live (dev-browser) vs batch into sections at end (do-browser). Streaming gives partial progress on timeout; batching gives a single parseable blob.
24. Default headed vs headless, and viewport policy (`viewport:null` headed, 1280x720 headless): which default for agents, and does headless toggle relaunch?
25. Which do-browser-only globals are in scope for a CLI: `bash()`, virtual fs (`/workspace`), `workspace.*` Sheets, `checkAbort()`? A CLI already has a real shell and fs; only the tmp jail and abort semantics seem portable.
26. Is exact text parity of the do-browser eval envelope (`[Console Output]...`) or the dev-browser frame protocol (stdout/stderr/complete/error) the compatibility target for existing agent skills/evals — or is a new contract acceptable because both guides will be rewritten anyway?
