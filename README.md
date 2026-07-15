<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

Brought to you by [Do Browser](https://dobrowser.io).

A browser automation tool that lets AI agents and developers control browsers with sandboxed JavaScript scripts.

**Key features:**

- **Sandboxed execution** - Scripts run in a QuickJS WASM sandbox with no host access
- **Persistent pages** - Navigate once, interact across multiple scripts
- **Auto-connect** - Connect to your running Chrome or launch a fresh Chromium
- **Full Playwright API** - goto, click, fill, locators, evaluate, screenshots, and more

## Demo

https://github.com/user-attachments/assets/c6cf7fb9-b1dc-46ed-93b9-6e7240990c53

## CLI Installation

```bash
npm install -g dev-browser
dev-browser install    # installs Playwright + Chromium
```

### Quick start

```bash
# Launch a headless browser and run a script
dev-browser --headless <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());
EOF

# Connect to your running Chrome (enable at chrome://inspect/#remote-debugging)
dev-browser --connect <<'EOF'
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
EOF
```

### PowerShell (Windows)

```powershell
@"
const page = await browser.getPage("main");
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
console.log(await page.title());
"@ | dev-browser
```

With `--connect`:

```powershell
@"
const page = await browser.getPage("main");
console.log(await page.title());
"@ | dev-browser --connect
```

### Windows notes

PowerShell install:

```powershell
npm install -g dev-browser
dev-browser install
```

To attach to a running Chrome instance on Windows:

```powershell
chrome.exe --remote-debugging-port=9222
dev-browser --connect
```

Windows npm installs download the native `dev-browser-windows-x64.exe` release asset during `postinstall`, and the generated npm shims invoke that executable directly.

### Using with AI agents

After installing, tell your agent to run `dev-browser --help` — the help output includes the current LLM usage guide and API reference.

For agents that discover local skills, install or refresh the embedded skill explicitly:

```bash
dev-browser install-skill --codex   # ~/.codex/skills/dev-browser/SKILL.md
dev-browser install-skill --claude  # ~/.claude/skills/dev-browser/SKILL.md
dev-browser install-skill --agents  # ~/.agents/skills/dev-browser/SKILL.md
```

Flags may be combined. With an interactive terminal, `dev-browser install-skill` prompts for targets. In non-interactive environments it updates all three locations, including Codex, so an older copied skill does not survive a CLI upgrade.

### Idle browser cleanup

Daemon-launched named Chromium instances can be closed automatically after they have been idle for a configured duration:

```bash
dev-browser --idle-timeout 5m < script.js
DEV_BROWSER_IDLE_TIMEOUT_MS=300000 dev-browser status
```

The flag accepts `30s`, `5m`, `1h`, or raw milliseconds. You can also set a user default in `~/.dev-browser/config.json`:

```json
{
  "idleTimeout": "5m"
}
```

Precedence is `--idle-timeout`, then `DEV_BROWSER_IDLE_TIMEOUT_MS`, then `idleTimeout` in the user config, then disabled. Set any source to `0` to disable cleanup. The effective setting is sent to an already-running daemon and shown by `dev-browser status`.

Cleanup is applied independently to each named browser. Activity is measured from both the start and completion of each request, so running requests are never reaped. Only Chromium instances launched by dev-browser are eligible; browsers attached with `--connect` are never closed by idle cleanup. Closing an idle browser does not delete its profile directory, cookies, or login state, and the next request relaunches it from the same persistent profile. `dev-browser stop` keeps its existing behavior of stopping the daemon and all managed browser connections.

<details>
<summary>Allowing dev-browser in Claude Code without permission prompts</summary>

By default, Claude Code asks for approval each time it runs a bash command. You can pre-approve `dev-browser` so it runs without permission checks by adding it to the `allow` list in your settings.

**Per-project** — add to `.claude/settings.json` in your project root:

```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)"
    ]
  }
}
```

**Per-user (global)** — add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)"
    ]
  }
}
```

The pattern `Bash(dev-browser *)` matches any command starting with `dev-browser ` followed by arguments (e.g. `dev-browser --headless`, `dev-browser --connect`). This is safe because dev-browser scripts run in a sandboxed QuickJS WASM environment with no host filesystem or network access.

You can also allow related commands in the same list:

```json
{
  "permissions": {
    "allow": [
      "Bash(dev-browser *)",
      "Bash(npx dev-browser *)"
    ]
  }
}
```

> **Tip:** If you've already been prompted and clicked "Always allow", Claude Code adds the specific command pattern automatically. The settings file approach lets you pre-approve it before the first run.

</details>

<details>
<summary>Legacy Claude Code plugin installation</summary>

### Claude Code

```
/plugin marketplace add sawyerhood/dev-browser
/plugin install dev-browser@sawyerhood/dev-browser
```

Restart Claude Code after installation.

</details>

## Script API

Scripts run in a sandboxed QuickJS runtime (not Node.js). Available globals:

```javascript
// Browser control
browser.getPage(nameOrId)    // Get/create named page, or connect to tab by targetId
browser.newPage()            // Create anonymous page (cleaned up after script)
browser.listPages()          // List all tabs: [{id, url, title, name}]
browser.closePage(name)      // Close a named page

// File I/O (restricted to ~/.dev-browser/tmp/)
await saveScreenshot(buf, name)   // Save screenshot buffer, returns path
await writeFile(name, data)       // Write file, returns path
await readFile(name)              // Read file, returns content

// Output
console.log/warn/error/info       // Routed to CLI stdout/stderr
```

Pages are full [Playwright Page objects](https://playwright.dev/docs/api/class-page) — `goto`, `click`, `fill`, `locator`, `evaluate`, `screenshot`, and everything else, including `page.snapshotForAI({ track?, depth?, timeout? })`, which returns `{ full, incremental? }` for AI-friendly page snapshots.

Every page also exposes two computer-use toolsets:

- `page.cua.*` — pixel/vision tier: `screenshot()` saves a JPEG whose pixels map 1:1 onto CSS coordinates at any DPR and returns `{ path, width, height }`; `click`, `doubleClick`, `drag`, `move`, `scroll`, `keypress`, and `type` act at those coordinates.
- `page.domCua.*` — DOM-id tier: `getVisibleDom()` snapshots visible interactive elements as pseudo-HTML lines with `node_id=N`; `click`, `doubleClick`, and `scroll` act by node id (ids are only valid against the latest snapshot of the current document), plus `type` and `keypress` for the focused element.

## Benchmarks

| Method                  | Time    | Cost  | Turns | Success |
| ----------------------- | ------- | ----- | ----- | ------- |
| **Dev Browser**         | 3m 53s  | $0.88 | 29    | 100%    |
| Playwright MCP          | 4m 31s  | $1.45 | 51    | 100%    |
| Playwright Skill        | 8m 07s  | $1.45 | 38    | 67%     |
| Claude Chrome Extension | 12m 54s | $2.81 | 80    | 100%    |

_See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
