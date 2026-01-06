# Multi-Agent Concurrency Support

This document explains how dev-browser supports multiple concurrent agents and the design decisions behind the implementation.

## The Problem

When multiple AI agents (e.g., Claude Code sub-agents) run browser automation tasks in parallel, they need to avoid conflicts. The original dev-browser design assumed a single server on a fixed port, which creates a bottleneck:

> "dev-browser is in fact a single point of congestion now, nullifying the advantages of dev browser"
> — [PR #15 discussion](https://github.com/SawyerHood/dev-browser/pull/15#issuecomment-3698722432)

## Solution: Dynamic Port Allocation

Each agent automatically gets its own HTTP API server on a unique port:

```
Agent 1 ──► server (port 9222) ──┐
Agent 2 ──► server (port 9224) ──┼──► Shared Browser (CDP 9223)
Agent 3 ──► server (port 9226) ──┘
```

### How It Works

1. **Port Auto-Assignment**: When `port` is not specified, the server finds an available port in the configured range (default: 9222-9300, step 2)

2. **Port Discovery**: Server outputs `PORT=XXXX` to stdout, which agents parse to know which port to connect to

3. **Server Tracking**: Active servers are tracked in `~/.dev-browser/active-servers.json` for coordination

4. **Shared Browser**: In external browser mode, all servers connect to the same browser via CDP, minimizing resource usage

## Design Decisions

### Options Considered

#### Option 1: Manual Port Assignment (Rejected)

From [PR #15](https://github.com/SawyerHood/dev-browser/pull/15), the initial proposal was to add `--port` and `--cdp-port` CLI flags for manual assignment.

**Why rejected**: Requires agents to coordinate port selection, adds complexity to agent implementation, and creates potential for conflicts.

#### Option 2: Singleton Server with Named Pages (Rejected)

Have one persistent server handling all agents, using page names for isolation.

**Why rejected**: Incompatible with the plugin architecture where each agent spawns its own server process. Also creates a true single point of failure.

#### Option 3: Dynamic Port Allocation (Chosen)

Servers automatically discover and claim available ports.

**Why chosen**:
- Zero configuration required
- Agents don't need to coordinate
- Works with existing plugin architecture
- Each agent is isolated (failure doesn't affect others)
- Memory overhead is acceptable (~140MB per server)

### Memory Considerations

Each dev-browser server uses approximately:
- **Node.js + Playwright + Express**: ~140MB
- **Browser (if standalone mode)**: ~300MB additional

In external browser mode, multiple servers share one browser, making the per-agent overhead just ~140MB.

## Configuration

Create `~/.dev-browser/config.json` to customize behavior:

```json
{
  "portRange": {
    "start": 9222,
    "end": 9300,
    "step": 2
  },
  "cdpPort": 9223
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `portRange.start` | 9222 | First port to try for HTTP API |
| `portRange.end` | 9300 | Last port to try |
| `portRange.step` | 2 | Port increment (avoids CDP port collision) |
| `cdpPort` | 9223 | Chrome DevTools Protocol port |

## Usage Examples

### Multiple Agents (External Browser Mode)

```bash
# Terminal 1: Start Chrome for Testing, then:
BROWSER_PATH="/path/to/chrome" npx tsx scripts/start-external-browser.ts
# Output: PORT=9222

# Terminal 2: Second agent
npx tsx scripts/start-external-browser.ts
# Output: PORT=9224

# Terminal 3: Third agent
npx tsx scripts/start-external-browser.ts
# Output: PORT=9226

# All agents share the same browser on CDP port 9223
```

### Multiple Agents (Standalone Mode)

```bash
# Terminal 1: First agent launches its own browser
npx tsx scripts/start-server.ts
# Output: PORT=9222

# Terminal 2: Second agent launches separate browser
npx tsx scripts/start-server.ts
# Output: PORT=9224
```

### Programmatic Usage

```typescript
import { serve, serveWithExternalBrowser } from "dev-browser";

// Port is automatically assigned
const server1 = await serve(); // Gets port 9222
const server2 = await serve(); // Gets port 9224

console.log(`Server 1 on port ${server1.port}`);
console.log(`Server 2 on port ${server2.port}`);

// Or with external browser
const external1 = await serveWithExternalBrowser();
const external2 = await serveWithExternalBrowser();
// Both connect to same browser on CDP 9223
```

## Troubleshooting

### "No available ports in range"

Too many servers running. Check active servers:

```bash
cat ~/.dev-browser/active-servers.json
```

Clean up stale entries (servers that crashed):

```bash
rm ~/.dev-browser/active-servers.json
```

### Port Conflicts

If a specific port is required, set `PORT` environment variable:

```bash
PORT=9250 npx tsx scripts/start-external-browser.ts
```

### Checking Server Status

```bash
# List all active servers
cat ~/.dev-browser/active-servers.json

# Test a specific server
curl http://localhost:9222/
# Returns: {"wsEndpoint":"ws://...","mode":"external-browser","port":9222}
```

## References

- [PR #15: Multi-port support discussion](https://github.com/SawyerHood/dev-browser/pull/15)
- [PR #20: External browser mode](https://github.com/SawyerHood/dev-browser/pull/20)
