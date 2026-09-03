# Driving a host-owned Chromium (bb in-app browser) with dev-browser

dev-browser can attach to any Chromium that a host application owns, without a
devtools port, through the **socket source**:

```
dev-browser --connect unix:/path/to/cdp.sock -e '...'
```

## Contract (host side)

- Listen on a Unix domain socket (or a Windows named pipe, `pipe:NAME`).
- Each connection is one **browser-level CDP session**: every line the client
  sends is one JSON CDP message (`{"id":1,"method":"Target.getTargets"}`),
  every line the host sends back is one JSON CDP message (responses and
  events), exactly as they would travel over `ws://.../devtools/browser/<id>`.
- Newline-delimited JSON; no framing beyond `\n`. Messages may be large
  (screenshots); do not cap lines below ~50 MB.
- The host must support the browser-level domains Puppeteer uses on connect:
  `Target.setDiscoverTargets`, `Target.setAutoAttach` (flatten mode),
  `Target.attachToTarget`, `Target.getTargets`, `Target.createTarget` (for
  `browser.newPage()`), `Target.closeTarget`, `Browser.getVersion`, and it must
  multiplex page sessions with `sessionId` like Chrome does. The simplest
  implementation is a proxy to the real devtools websocket of the embedded
  Chromium (see `test/socket-source.test.ts` for a 40-line proxy).
- For Electron `WebContentsView` (bb), the intended path is
  `webContents.debugger.attach("1.3")` per view plus a small browser-level
  target table that maps each view to a `targetId` and answers the
  `Target.*` calls above, forwarding page-level messages to the right
  `webContents.debugger`. Only expose the views you want the agent to drive
  (never the trusted UI renderer).

## Behavior on the dev-browser side

- The browser key is `socket:unix:/path`; named pages live under that key in
  `~/.dev-browser/v1/pages/`.
- Nothing is launched or killed; `dev-browser stop socket:unix:/path` only
  disconnects.
- All page helpers (`snapshot`, `ref/`, `shot`, `waitForLoad`, `fill`) work
  unchanged because they only need a Puppeteer `Page`.
- Downloads and the idle reaper are not configured for socket browsers.

## Verified

`test/socket-source.test.ts` stands up a Unix-socket ↔ devtools-websocket proxy
in front of a headless Chrome and drives it with `--connect unix:...`.
