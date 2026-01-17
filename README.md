<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

A browser automation plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that lets Claude control your browser to test and verify your work as you develop.

**Key features:**

- **Persistent pages** - Navigate once, interact across multiple scripts
- **Flexible execution** - Full scripts when possible, step-by-step when exploring
- **LLM-friendly DOM snapshots** - Structured page inspection optimized for AI

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [Node.js](https://nodejs.org) (v18 or later) with npm

## Installation

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

**Amp only:** Start the server manually before use:

```bash
cd ~/.claude/skills/dev-browser && npm install && npm run start-server
```

### Chrome Extension (Optional)

The Chrome extension allows Dev Browser to control your existing Chrome browser instead of launching a separate Chromium instance. This gives you access to your logged-in sessions, bookmarks, and extensions.

**Installation:**

1. Download `extension.zip` from the [latest release](https://github.com/sawyerhood/dev-browser/releases/latest)
2. Unzip the file to a permanent location (e.g., `~/.dev-browser-extension`)
3. Open Chrome and go to `chrome://extensions`
4. Enable "Developer mode" (toggle in top right)
5. Click "Load unpacked" and select the unzipped extension folder

**Using the extension:**

1. Click the Dev Browser extension icon in Chrome's toolbar
2. Toggle it to "Active" - this enables browser control
3. Ask Claude to connect to your browser (e.g., "connect to my Chrome" or "use the extension")

When active, Claude can control your existing Chrome tabs with all your logged-in sessions, cookies, and extensions intact.

## Permissions

To skip permission prompts, add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Skill(dev-browser:dev-browser)", "Bash(npx tsx:*)"]
  }
}
```

Or run with `claude --dangerously-skip-permissions` (skips all prompts).

## Configuration

Browser settings are configured in a `config.json` file. Dev Browser searches for this file in order:

1. `DEV_BROWSER_CONFIG` environment variable (explicit path)
2. `.dev-browser/config.json` in current directory or any parent (project config)
3. `$XDG_CONFIG_HOME/dev-browser/config.json` (default: `~/.config/dev-browser/`)
4. `~/.dev-browser/config.json` (legacy)

**Example config:**

```json
{
  "cdpPort": 9223,
  "browser": {
    "mode": "auto",
    "path": "/usr/bin/google-chrome"
  }
}
```

| Setting | Description |
|---------|-------------|
| `cdpPort` | Chrome DevTools Protocol port (default: 9223) |
| `browser.mode` | `"auto"`, `"external"`, or `"standalone"` |
| `browser.path` | Path to Chrome executable |
| `browser.userDataDir` | Browser profile directory (optional) |

**Project-level config:** Place `.dev-browser/config.json` in your project root to share browser settings with your team or use different settings per project.

**Containers/CI:** Set `DEV_BROWSER_CONFIG=/path/to/config.json` to specify an explicit config path.

## Usage

Just ask Claude to interact with your browser:

> "Open localhost:3000 and verify the signup flow works"

> "Go to the settings page and figure out why the save button isn't working"

## Benchmarks

| Method                  | Time    | Cost  | Turns | Success |
| ----------------------- | ------- | ----- | ----- | ------- |
| **Dev Browser**         | 3m 53s  | $0.88 | 29    | 100%    |
| Playwright MCP          | 4m 31s  | $1.45 | 51    | 100%    |
| Playwright Skill        | 8m 07s  | $1.45 | 38    | 67%     |
| Claude Chrome Extension | 12m 54s | $2.81 | 80    | 100%    |

_See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

### How It's Different

| Approach                                                         | How It Works                                      | Tradeoff                                               |
| ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp)    | Observe-think-act loop with individual tool calls | Simple but slow; each action is a separate round-trip  |
| [Playwright Skill](https://github.com/lackeyjb/playwright-skill) | Full scripts that run end-to-end                  | Fast but fragile; scripts start fresh every time       |
| **Dev Browser**                                                  | Stateful server + agentic script execution        | Best of both: persistent state with flexible execution |

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
