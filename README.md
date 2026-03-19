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
- **Zero startup cost** - Rust CLI binary, Node daemon runs in the background

## CLI Installation

```bash
npm install -g dev-browser
dev-browser install    # installs Playwright + Chromium
```

> Windows is not currently supported.

### Quick start

```bash
# Launch a headless browser and run a script
dev-browser --headless <<'EOF'
const page = await browser.getPage("main");
await page.goto("https://example.com");
console.log(await page.title());
EOF

# Connect to your running Chrome (enable at chrome://inspect/#remote-debugging)
dev-browser --connect <<'EOF'
const tabs = await browser.listPages();
console.log(JSON.stringify(tabs, null, 2));
EOF
```

### Using with AI agents

After installing, just tell your agent to run `dev-browser --help` — the help output includes a full LLM usage guide with examples and API reference. No plugin or skill installation needed.

<details>
<summary>Legacy plugin installation (Claude Code / Amp / Codex)</summary>

### Claude Code

```
/plugin marketplace add sawyerhood/dev-browser
/plugin install dev-browser@sawyerhood/dev-browser
```

Restart Claude Code after installation.

### Amp / Codex

Copy the skill to your skills directory:

```bash
# For Amp: ~/.claude/skills | For Codex: ~/.codex/skills
SKILLS_DIR=~/.claude/skills  # or ~/.codex/skills

mkdir -p $SKILLS_DIR
git clone https://github.com/sawyerhood/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser $SKILLS_DIR/dev-browser
rm -rf /tmp/dev-browser-skill
```

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

Pages are full [Playwright Page objects](https://playwright.dev/docs/api/class-page) — `goto`, `click`, `fill`, `locator`, `evaluate`, `screenshot`, and everything else.

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
