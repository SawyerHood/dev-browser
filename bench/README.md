# dev-browser benchmarks

Measures the numbers from `docs/design-decisions.md` §8 against an isolated
`DEV_BROWSER_HOME` temp dir and a warm headless daemon. Everything is cleaned up at
the end (daemon stopped, temp home removed), also on error.

```
bun run bench/run.ts [--check] [--bin PATH] [--runs N]
```

- Uses `dist/dev-browser` when it exists (`bun run build`), else `bun run src/cli/main.ts`
  (slower cold start and per-call client time). `--bin` overrides. The chosen
  binary is printed first; `--bin dev` forces the `bun run` path.
- `--runs N` is the sample count per item (default 15); the table shows medians.
- `--check` exits 1 if any measured item is over its target. Items that are
  skipped because the API is not implemented yet count as pass.

| item | what is timed | target |
| --- | --- | --- |
| `1+1` | wall time of one `dev-browser --headless -e '1+1'` process | 25 ms |
| `getPage+title` | wall time, `getPage("bench")` + `title()` | 40 ms |
| `evaluate(()=>1)` | wall time, `getPage` + one evaluate | 40 ms (informal) |
| `snapshot small` | `page.snapshot()` timed inside the script, ~3 KB page, ~60 elements | 30 ms |
| `snapshot large` | same, SERP-like page (~1500 nodes, 300 links, 100 buttons) | 150 ms |
| `shot viewport` | `page.shot()` timed inside the script | 120 ms |
| `per-call overhead` | (50x `await page.evaluate(()=>1)` in a script / 50) minus the same loop via raw `puppeteer.connect` to the daemon's Chrome | 0.1 ms |
| `cold start` | stop daemon, remove socket, time the first `1+1` (daemon spawn + Chrome launch), median of 3 | 1500 ms |

Fixtures live in `bench/fixtures/` (`small.ts`, `serp.ts`) and are served by a
local `Bun.serve` on 127.0.0.1. `bench/fixtures/fixtures.test.ts` pins their
size (`bun test bench/fixtures`).

## In-process micro-harness

```
bun run bench/inproc.ts [--runs N]
```

Calls `runScript` from `src/daemon/run.ts` directly with a fake `emit` and a
`BrowserManager`: no socket, no client process. Compare its `1+1` median with
the `1+1` row of `bench/run.ts` to see how much of the end-to-end time is the
client (process start + socket round trip) vs the daemon.

## CI

CI runs `bun run build && bun run bench/run.ts --check` on Linux (headless
Chrome, `--no-sandbox` is applied automatically when the sandbox is
unavailable). Medians are noisy on shared runners; bump `--runs` rather than
the targets if it flakes.
