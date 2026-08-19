/**
 * Small fixture page (~3 KB, ~60 elements): a login form, a nav, a short list.
 * Used by the "snapshot small" benchmark.
 */
export function smallHtml(): string {
  const navItems = ["Home", "Docs", "Pricing", "Blog", "Sign in"]
    .map((t, i) => `<li><a href="/${t.toLowerCase().replace(" ", "-")}" id="nav${i}">${t}</a></li>`)
    .join("");
  const features = [
    "One warm daemon",
    "Named pages",
    "Snapshot refs",
    "Puppeteer scripts",
  ]
    .map((f, i) => `<li class="feature"><strong>${f}</strong> <span>item ${i + 1}</span></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>doobie bench: small</title>
<style>body{font:14px system-ui;margin:24px}nav ul{display:flex;gap:12px;list-style:none;padding:0}form label{display:block;margin:6px 0}</style>
</head>
<body>
<header><h1>doobie</h1><nav aria-label="Main"><ul>${navItems}</ul></nav></header>
<main>
  <section id="intro"><h2>Sign in</h2><p>Enter your details to continue. <a href="/help">Need help?</a></p>
    <form id="login" action="/login" method="post">
      <label>Email <input type="email" name="email" placeholder="you@example.com" required></label>
      <label>Password <input type="password" name="password" required></label>
      <label><input type="checkbox" name="remember" checked> Remember me</label>
      <label>Region <select name="region"><option>US</option><option>EU</option><option>APAC</option></select></label>
      <button type="submit" id="submit">Sign in</button>
      <button type="button" id="reset">Reset</button>
    </form>
  </section>
  <section id="about"><h2>About</h2>
    <p>doobie is a browser automation CLI for coding agents. Scripts are plain Puppeteer; a warm daemon keeps Chrome
    alive between calls so each invocation costs milliseconds, not seconds. Pages are addressed by name, snapshots hand
    back stable element refs, and screenshots land on disk as JPEGs the agent can read back. There is exactly one daemon
    per home directory, one socket, and one NDJSON frame protocol shared by the CLI and any future MCP server.</p>
    <p>This page exists only as a benchmark fixture: it is deliberately small (about three kilobytes of HTML and roughly
    sixty elements) so that the snapshot cost it measures is dominated by fixed per-call overhead rather than by DOM size.</p>
  </section>
  <section id="features"><h2>Features</h2><ul>${features}</ul></section>
</main>
<footer><p>&copy; 2026 doobie &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></p>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="logo" width="1" height="1">
</footer>
</body>
</html>`;
}
