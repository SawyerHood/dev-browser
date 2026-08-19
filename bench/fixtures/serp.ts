/**
 * Large fixture page resembling a search results page:
 * ~1500 DOM nodes, 300 links, 100 buttons. Deterministic (no randomness).
 * Used by the "snapshot large" benchmark.
 */
const WORDS = ["browser", "automation", "daemon", "puppeteer", "snapshot", "agent", "script", "page", "ref", "chrome"];

function words(seed: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(seed * 7 + i * 3) % WORDS.length]!);
  return out.join(" ");
}

export const SERP_RESULTS = 100;

export function serpHtml(results = SERP_RESULTS): string {
  const items: string[] = [];
  for (let i = 0; i < results; i++) {
    const host = `site${i % 17}.example.com`;
    items.push(
      `<div class="g" data-i="${i}">` +
        `<a href="https://${host}/p/${i}" class="title"><h3>Result ${i + 1}: ${words(i, 5)}</h3></a>` +
        `<cite>${host} &rsaquo; p &rsaquo; ${i}</cite>` +
        `<div class="snippet">Aug ${(i % 28) + 1}, 2026 &mdash; ${words(i + 1, 18)}.</div>` +
        `<div class="actions"><a href="https://${host}/cached/${i}">Cached</a><a href="/similar?q=${i}">Similar</a>` +
        `<button type="button" class="save" aria-label="Save result ${i + 1}">Save</button></div>` +
        `</div>`,
    );
  }
  const tabs = ["All", "Images", "Videos", "News", "Maps", "More"]
    .map((t, i) => `<a href="/search?tbm=${i}" role="tab" ${i === 0 ? 'aria-selected="true"' : ""}>${t}</a>`)
    .join("");
  const pages = Array.from({ length: 10 }, (_, i) => `<a href="/search?start=${i * 10}" aria-label="Page ${i + 1}">${i + 1}</a>`).join("");
  const related = Array.from({ length: 8 }, (_, i) => `<li><a href="/search?q=${words(i, 2).replace(" ", "+")}">${words(i, 3)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>browser automation - Search</title>
<style>body{font:14px arial;margin:0}.g{margin:0 0 24px 180px;max-width:600px}h3{font-size:18px;margin:0}cite{color:#006621;font-style:normal}.tabs a{margin-right:16px}.actions a{margin-right:8px}</style>
</head>
<body>
<header role="banner">
  <form role="search" action="/search"><input type="search" name="q" value="browser automation" aria-label="Search"><button type="submit">Search</button><button type="button" aria-label="Clear">x</button></form>
  <nav class="tabs" aria-label="Search modes">${tabs}</nav>
</header>
<main role="main" id="rso"><p class="stats">About 1,230,000 results (0.42 seconds)</p>
${items.join("")}
</main>
<aside id="related"><h2>Related searches</h2><ul>${related}</ul></aside>
<nav role="navigation" aria-label="Pagination"><a href="/search?start=0" aria-label="Previous">&lsaquo;</a>${pages}<a href="/search?start=100" aria-label="Next">&rsaquo;</a></nav>
<footer><a href="/settings">Settings</a> <a href="/privacy">Privacy</a> <a href="/terms">Terms</a></footer>
</body>
</html>`;
}
