<p align="center">
  <img src="assets/header.png" alt="Dev Browser - Browser automation for Claude Code" width="100%">
</p>

A browser automation plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that lets Claude control your web browser to close the loop on your development workflows.

## Why Dev Browser?

This plugin is optimized for **testing and verifying as you develop**. Claude can interact with your running application, fill out forms, click buttons, and verify that your changes work—all without leaving your coding session.

### How It's Different

| Approach                                                             | How It Works                                      | Tradeoff                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**Playwright MCP**](https://github.com/microsoft/playwright-mcp)    | Observe-think-act loop with individual tool calls | Simple but slow; each action is a separate round-trip. The MCP also takes up a lot of context window space.                                                                              |
| [**Playwright skill**](https://github.com/lackeyjb/playwright-skill) | Full scripts that run end-to-end                  | Fast but fragile; scripts start fresh every time, so failures mean starting over. Very context efficient.                                                                                |
| **Dev Browser**                                                      | Stateful server + agentic script execution        | Best of both worlds. In between Playwright MCP and Playwright skill in terms of context efficiency. In practice it can be more context efficient because it is less likely to get stuck. |

**Dev Browser** runs a persistent Playwright server that maintains browser state across script executions. This means:

- **Pages stay alive** - Navigate to a page once, interact with it across multiple scripts
- **Flexible execution** - Run full Playwright scripts when the agent knows what to do, or fall back to step-by-step observation when exploring
- **Codebase-aware** - The plugin includes instructions for Claude to look at your actual code to inform debugging
- **LLM-friendly inspection** - Get structured DOM snapshots optimized for AI understanding, similar to browser-use

In practice, Claude will often explore a page step-by-step first, then generate reusable scripts to speed up repetitive actions.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- [Node.js](https://nodejs.org) (v18 or later) with npm

## Installation

### For Claude Code

#### Step 1: Add the Marketplace

In Claude Code, run:

```
/plugin marketplace add sawyerhood/dev-browser
```

#### Step 2: Install the Plugin

```
/plugin install dev-browser@sawyerhood/dev-browser
```

#### Step 3: Use It!

Prompt Claude to use it!

> **Restart Claude Code** after installation to activate the plugin.

### For Amp

[Amp](https://ampcode.com) automatically detects skills from your `.claude/skills` directory with zero configuration required.

**Note:** Since Amp can't run background processes, you'll need to manually start the dev-browser server in a separate terminal before using this skill.

#### Step 1: Install the Skill

```bash
# Create skills directory if it doesn't exist
mkdir -p ~/.claude/skills

# Clone the repo and copy the skill
git clone https://github.com/sawyerhood/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser ~/.claude/skills/dev-browser
rm -rf /tmp/dev-browser-skill
```

#### Step 2: Start the Server

Before using the skill, start the dev-browser server in a separate terminal:

```bash
cd ~/.claude/skills/dev-browser
npm install  # First time only
npm run start-server
```

Keep this terminal running while you use Amp.

#### Step 3: Use It!

Prompt Claude to use it! Amp will automatically load the skill when needed.

> Learn more about [Amp's skill support](https://ampcode.com/manual#agent-skills).

### For Codex (CLI)

Codex automatically detects skills from your `~/.codex/skills` directory when you run it with `codex --enable skills`.

#### Step 1: Install the Skill

```bash
# Create skills directory if it doesn't exist
mkdir -p ~/.codex/skills

# Clone the repo and copy the skill
git clone https://github.com/sawyerhood/dev-browser /tmp/dev-browser-skill
cp -r /tmp/dev-browser-skill/skills/dev-browser ~/.codex/skills/dev-browser
rm -rf /tmp/dev-browser-skill
```

#### Step 2: Use It!

Restart Codex (using `codex --enable skills`) after installation, then ask it to use dev-browser.

## Permissions Configuration

By default, Claude will prompt for permission on every script execution. You can configure it to allowlist specific commands to bypass this.

### Option 1: Skip All Permissions

You can also run it in YOLO mode bypassing all permission prompts:

```bash
claude --dangerously-skip-permissions
```

**Note:** This skips all security prompts, so only use in trusted environments.

### Option 2: Allowlist Specific Commands

Add to your `~/.claude/settings.json` (user-level, applies to all projects):

```json
{
  "permissions": {
    "allow": ["Skill(dev-browser:dev-browser)", "Bash(npx tsx:*)"],
    "deny": [],
    "ask": []
  }
}
```

This allowlists the dev-browser skill and the `npx tsx` command that runs the browser automation scripts, regardless of which directory the skill is installed in.

For project-level settings, add to `.claude/settings.json` in your project root.

## Usage

Once installed, just ask Claude to interact with your browser. Here are some example prompts:

**Testing your app:**

> "Open my local dev server at localhost:3000 and create an account to verify the signup flow"

**Debugging UI issues:**

> "Go to the settings page and figure out why the save button isn't working"

**Close the loop visually**

> "Can you use the frontend design skill to make the landing page more visually appealing? Use dev-browser to iterate on the design until it looks good."

## Benchmarks

_Averaged over 3 runs per method. See [dev-browser-eval](https://github.com/SawyerHood/dev-browser-eval) for methodology._

| Method                  | Time    | Cost (USD) | Turns | Success Rate |
| ----------------------- | ------- | ---------- | ----- | ------------ |
| **Dev Browser**         | 3m 53s  | $0.88      | 29    | 100% (3/3)   |
| Playwright MCP          | 4m 31s  | $1.45      | 51    | 100% (3/3)   |
| Playwright Skill        | 8m 07s  | $1.45      | 38    | 67% (2/3)    |
| Claude Chrome Extension | 12m 54s | $2.81      | 80    | 100% (3/3)   |

**Dev Browser advantages:**

- **14% faster** than Playwright MCP, **52% faster** than Playwright Skill, **70% faster** than Claude Chrome Extension
- **39% cheaper** than Playwright MCP/Skill, **69% cheaper** than Claude Chrome Extension
- **43% fewer turns** than Playwright MCP, **24% fewer** than Playwright Skill, **64% fewer** than Claude Chrome Extension

## License

MIT

## Author

[Sawyer Hood](https://github.com/sawyerhood)
