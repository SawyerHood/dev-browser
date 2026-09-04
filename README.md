<p align="center">
  <img src="assets/header.png" alt="Dev Browser - browser automation for coding agents" width="100%">
</p>

Brought to you by [Do Browser](https://dobrowser.io).

`dev-browser` lets coding agents control Chrome with short JavaScript scripts. The browser stays open between calls,
so an agent can navigate once, inspect the page, act, and verify the result without starting over each time.

**Key features:**

- **Persistent pages.** Named tabs carry state across scripts.
- **Compact snapshots.** Accessibility trees give agents readable output and stable element refs.
- **Real Puppeteer.** Scripts use the Puppeteer Page API plus a small set of agent-focused helpers.
- **Launch or attach.** Start an isolated Chrome profile or connect to a browser you already have open.

## Demo

https://github.com/user-attachments/assets/c6cf7fb9-b1dc-46ed-93b9-6e7240990c53

## CLI installation

```bash
npm install -g dev-browser
dev-browser install    # only needed if dev-browser cannot find Chrome
```

The release binary includes Bun and Puppeteer. Node is not required after installation. macOS and glibc Linux are
supported; Windows and musl Linux are not yet supported.

Snap-packaged Chromium cannot read the default `~/.dev-browser/v1` directory. On Ubuntu, use `dev-browser install`
or point `DEV_BROWSER_CHROME` at another Chrome binary.

If your package manager blocks lifecycle scripts, run `npm rebuild -g dev-browser`, `pnpm approve-builds -g
dev-browser`, or `bun pm -g trust dev-browser`. The CLI will also try to download its binary on first use. For a
private mirror, set `DEV_BROWSER_DOWNLOAD_BASE`; set `DEV_BROWSER_SKIP_DOWNLOAD=1` if you install the binary yourself.

### Quick start

```bash
# Launch a headless browser and run a script
dev-browser --headless <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF

# Attach to Chrome started with `dev-browser chrome`
dev-browser chrome
dev-browser --connect <<'EOF'
console.log(await browser.listPages());
EOF
```

Chrome 136 and newer ignore remote-debugging flags on the default profile. `dev-browser chrome` handles this by using
a dedicated profile and checking that Chrome actually started.

### Using it with coding agents

Tell the agent to run `dev-browser --help`. The built-in guide covers the current API and the preferred
look → act → verify workflow.

Agents that discover local skills can install the bundled skill explicitly:

```bash
dev-browser install-skill --codex   # ~/.codex/skills/dev-browser/SKILL.md
dev-browser install-skill --claude  # ~/.claude/skills/dev-browser/SKILL.md
dev-browser install-skill --agents  # ~/.agents/skills/dev-browser/SKILL.md
```

Run `dev-browser install-skill` without flags to update all three locations.

### Idle browser cleanup

Launched browsers close after 30 minutes without a script by default. Change that per command, in the environment, or
in `~/.dev-browser/v1/config.json`:

```bash
dev-browser --idle-timeout 5m < script.js
DEV_BROWSER_IDLE_TIMEOUT=1h dev-browser -e 'await browser.listPages()'
```

```json
{
  "idleTimeout": "5m"
}
```

Durations accept `30s`, `5m`, `1h`, or raw milliseconds. Set the value to `0` to keep a launched browser open until
`dev-browser stop`. Attached browsers are never closed by idle cleanup. Profiles, cookies, and login state remain on
disk when a launched browser closes.

<details>
<summary>Allowing dev-browser in Claude Code without permission prompts</summary>

Add `dev-browser` to the `allow` list in `.claude/settings.json` for one project or `~/.claude/settings.json` for every
project:

```json
{
  "permissions": {
    "allow": ["Bash(dev-browser *)"]
  }
}
```

This allows any matching command without another prompt. Only do this where you trust the scripts being run:
`node:vm` gives each script fresh globals, but it is not a security sandbox.

</details>

<details>
<summary>Legacy Claude Code plugin installation</summary>

```text
/plugin marketplace add sawyerhood/dev-browser
/plugin install dev-browser@sawyerhood/dev-browser
```

Restart Claude Code after installation.

</details>

## Script API

Scripts get these globals:

```javascript
// Browser control
browser.getPage(nameOrId)    // Get/create a named page, or attach by target ID
browser.newPage()            // Create an anonymous page; close it yourself
browser.listPages()          // [{ id, url, title, name }]
browser.closePage(name)      // Close a named page

// File I/O, restricted to ~/.dev-browser/v1/tmp
saveFile(name, data)
readFile(name)

// Output
console.log()
console.warn()
console.error()
```

Top-level `await` works, and the last expression becomes the command result. Pages are real [Puppeteer Page
objects](https://pptr.dev/api/puppeteer.page) with a few additions:

```javascript
await page.snapshot({ interactive: true }) // Accessibility tree with refs such as e12
await page.click("ref/e12")                 // Refs work in Puppeteer selector methods
await page.ref("e12")                       // ElementHandle for a ref
await page.shot()                           // JPEG path and CSS-pixel dimensions
await page.waitForLoad()                    // Wait for navigation, requests, and DOM activity to settle
await page.fill("#email", "me@example.com")
```

Each command runs in a fresh `node:vm` context inside the daemon. This keeps script globals separate, but it is not a
security boundary. When a command finishes or times out, its page, locator, browser-context, and registry operations
are closed so detached work cannot interfere with the next command.

Scripts may run concurrently. Browser and page creation are serialized, as are input operations on different tabs
through a bring-to-front lock. Two scripts using the same named page can still interleave.

See [`dev-browser --help`](docs/help.md) for the full API, error behavior, configuration, JSON output, MCP tools, and
examples.

## Connecting to an existing browser

`--connect` accepts auto-discovery, a port, an HTTP URL, a WebSocket URL, or a raw CDP Unix socket:

```bash
dev-browser chrome --profile work
dev-browser --connect -e 'await browser.listPages()'
dev-browser --connect 9222 -e 'await browser.listPages()'
dev-browser --connect 'wss://provider.example?token=…' -e 'await browser.listPages()'
```

Attached browsers belong to the user. dev-browser extends only the tabs a script asks for and never closes the browser
because of an idle timeout. Credentials are redacted from logs and status output, while differently authenticated
endpoints remain separate sessions.

## MCP

```bash
claude mcp add dev-browser -- dev-browser mcp --headless
```

The server exposes `dev_browser_run`, `dev_browser_pages`, `dev_browser_browsers`, `dev_browser_stop`, and
`dev_browser_help` over the same warm daemon as the CLI.

## Upgrading to 1.0

Version 1.0 replaces the Playwright/QuickJS implementation from dev-browser 0.2 with the Puppeteer/Bun implementation
developed as doobie. Its state lives under `~/.dev-browser/v1`, separate from both older installations.

To copy durable doobie state:

```bash
doobie stop
dev-browser migrate-from-doobie
```

`migrate-from-doobie` leaves `~/.doobie` untouched. Scripts written for dev-browser 0.2 need to replace helpers such as
`snapshotForAI()` and `getByRef()` with `snapshot()` and `ref/eN`. Computer-use helpers under `page.cua` and
`page.domCua` are not part of 1.0.

## Benchmarks

Measured on Linux with a headless browser and warm daemon, medians of 9 runs:

| Scenario | Time |
| --- | ---: |
| Empty script | ~13 ms |
| `getPage("x")` + `page.title()` | ~14 ms |
| `page.snapshot()` on a SERP-like page | ~18 ms |
| `page.shot()` | ~36 ms |
| Cold daemon and Chrome launch | ~280 ms |

Run them with `bun run build && bun run bench/run.ts --runs 9`. The older end-to-end comparison is in
[dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval).

## Development

```bash
bun install
bun run dev -- -e '1+1'
bun test
bun run build
```

Design notes live in [docs/design-decisions.md](docs/design-decisions.md).

## Releasing

See [RELEASING.md](RELEASING.md) for release-candidate testing, npm trusted publishing, and post-release verification.

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
