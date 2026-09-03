import { test, expect, afterAll, beforeAll } from "bun:test";
import { withPage, closeBrowser } from "./helpers/browser.ts";
import { startServer, type FixtureServer } from "./helpers/server.ts";
import { getSnapshotState, lastTimings, diffLines } from "../src/page/snapshot/snapshot.ts";

const FORM_PAGE = `<!doctype html><html><body>
<h1>Sign up</h1>
<p>Some plain text</p>
<form aria-label="signup">
  <label>Name <input id="name" value="bob"></label>
  <input type="checkbox" id="agree" checked><label for="agree">Agree</label>
  <label>Color <select id="color"><option>Red</option><option selected>Blue</option></select></label>
  <button id="go" type="button" onclick="document.title='clicked'">Go</button>
  <a href="/next">Next page</a>
</form>
</body></html>`;

function bigPage(n: number): string {
  let s = "<!doctype html><html><body><nav><a href='/'>Home</a></nav><main>";
  for (let i = 0; i < n; i++) {
    s += `<div class="row"><span>Item ${i}</span><button>Act ${i}</button><a href="/item/${i}">Open ${i}</a></div>`;
  }
  return s + "</main></body></html>";
}

let srv: FixtureServer;
let srv2: FixtureServer;

beforeAll(async () => {
  srv = await startServer({
    "/form": FORM_PAGE,
    "/next": "<h1>Next</h1>",
    "/big": bigPage(70),
    "/child": `<button id="inner">Inner button</button><p>child text</p>`,
    "/frames": `<h2>Parent</h2><iframe id="same" src="/child"></iframe><iframe id="data" src="data:text/html,<button>x</button>"></iframe>`,
    "/text": `<p>hello</p><button>Only button</button>`,
    "/long": `<ul>${Array.from({ length: 300 }, (_, i) => `<li>Item number ${i} with some text</li>`).join("")}</ul>`,
  });
  srv2 = await startServer({ "/": "<button>Other origin</button>" });
  srv.set("/xorigin", `<h2>X</h2><iframe src="${srv2.url("/")}"></iframe>`);
});

afterAll(async () => {
  await closeBrowser();
  await srv?.stop();
  await srv2?.stop();
});

test("renders roles, names, states and refs on a form", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const yaml = (await page.snapshot()) as string;
    expect(yaml).toContain('heading "Sign up" [level=1]');
    expect(yaml).toMatch(/- textbox "Name" \[ref=e\d+\]: bob/);
    expect(yaml).toMatch(/- button "Go" \[ref=e\d+\]/);
    expect(yaml).toMatch(/- link "Next page" \[ref=e\d+\]:\n\s+- \/url: \/next/);
    expect(yaml).toMatch(/- checkbox "Agree" \[checked\] \[ref=e\d+\]/);
    expect(yaml).toMatch(/- combobox "Color" \[ref=e\d+\]:\n\s+- option "Red"\n\s+- option "Blue" \[selected\]/);
    expect(yaml).toContain('- form "signup"');
    expect(yaml).toContain("- paragraph");
  });
});

test("refs work with page.$ / click / ref and are stable across snapshots", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const a = (await page.snapshot()) as string;
    const m = /- button "Go" \[ref=(e\d+)\]/.exec(a);
    expect(m).not.toBeNull();
    const ref = m![1]!;
    const h = await page.$(`ref/${ref}`);
    expect(h).not.toBeNull();
    expect(await h!.evaluate((e) => e.id)).toBe("go");
    const h2 = await page.ref(ref);
    expect(await h2.evaluate((e) => e.id)).toBe("go");
    await page.click(`ref/${ref}`);
    expect(await page.title()).toBe("clicked");
    // type into the textbox via ref
    const t = /- textbox "Name" \[ref=(e\d+)\]/.exec(a)![1]!;
    await page.type(`ref/${t}`, "by");
    expect(await page.$eval("#name", (e) => (e as HTMLInputElement).value)).toContain("by");
    // stability: same refs on a second snapshot without DOM change
    const b = (await page.snapshot()) as string;
    expect(/- button "Go" \[ref=(e\d+)\]/.exec(b)![1]).toBe(ref);
    // refs are monotonically increasing in document order
    const ids = [...a.matchAll(/\[ref=e(\d+)\]/g)].map((x) => Number(x[1]));
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
  });
});

test("stale ref after navigation throws with 'stale'", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const a = (await page.snapshot()) as string;
    const ref = /- button "Go" \[ref=(e\d+)\]/.exec(a)![1]!;
    await page.goto(srv.url("/next"));
    let err: Error | null = null;
    try {
      await page.ref(ref);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain("stale");
    // new document starts over (body is e1 but collapses; the heading is e2)
    const b = (await page.snapshot()) as string;
    const ids = [...b.matchAll(/\[ref=e(\d+)\]/g)].map((x) => Number(x[1]));
    expect(Math.min(...ids)).toBeLessThanOrEqual(2);
  });
});

test("interactive mode drops plain text but keeps the button", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/text"));
    const full = (await page.snapshot()) as string;
    expect(full).toContain("hello");
    const inter = (await page.snapshot({ interactive: true })) as string;
    expect(inter).not.toContain("hello");
    expect(inter).toMatch(/- button "Only button" \[ref=e\d+\]/);
    expect(inter).not.toContain("paragraph");
  });
});

test("scope by ref and by selector", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const full = (await page.snapshot()) as string;
    const formRef = /- form "signup" \[ref=(e\d+)\]/.exec(full)![1]!;
    const byRef = (await page.snapshot({ scope: formRef })) as string;
    expect(byRef.startsWith('- form "signup"')).toBe(true);
    expect(byRef).not.toContain("heading");
    const bySel = (await page.snapshot({ scope: "form" })) as string;
    expect(bySel).toBe(byRef);
    await expect(page.snapshot({ scope: "#nope" })).rejects.toThrow(/matched no element/);
  });
});

test("depth limits nesting", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const d1 = (await page.snapshot({ depth: 1 })) as string;
    expect(d1.split("\n").every((l) => !l.startsWith(" "))).toBe(true);
    const d2 = (await page.snapshot({ depth: 2 })) as string;
    expect(d2).toContain('  - form "signup"');
    expect(d2).not.toContain('    - button "Go"');
    const full = (await page.snapshot()) as string;
    expect(full).toContain('    - button "Go"');
  });
});

test("boxes appends [box=x,y,w,h] after the ref", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const yaml = (await page.snapshot({ boxes: true })) as string;
    const m = /- button "Go" \[ref=e\d+\] \[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/.exec(yaml);
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBeGreaterThan(0);
    expect(Number(m![4])).toBeGreaterThan(0);
    const box = await page.$eval("#go", (e) => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    });
    expect([Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])]).toEqual(box);
  });
});

test("maxChars truncates at a line boundary with the marker", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/long"));
    const yaml = (await page.snapshot({ maxChars: 1000 })) as string;
    const lines = yaml.split("\n");
    const last = lines[lines.length - 1]!;
    expect(last).toMatch(/^# \.\.\. truncated at 1000 chars \(\d+ more lines\)\. Narrow with snapshot\(\{ scope: 'eN' \}\) or snapshot\(\{ interactive: true \}\)\.$/);
    const body = lines.slice(0, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(1000);
    expect(lines[lines.length - 2]).toMatch(/^\s*- listitem/);
    const m = /\((\d+) more lines\)/.exec(last)!;
    expect(Number(m[1])).toBeGreaterThan(200);
    // default cap is not hit on a normal page
    const full = (await page.snapshot()) as string;
    expect(full).not.toContain("truncated");
  });
});

test("track returns an incremental diff", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/text"));
    const first = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    expect(first.incremental).toBe(first.full);
    const second = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    expect(second.incremental).toBe("(no changes)");
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.textContent = "Added";
      document.body.appendChild(b);
    });
    const third = (await page.snapshot({ track: "t" })) as { full: string; incremental: string };
    expect(third.full).toContain('button "Added"');
    const added = third.incremental.split("\n").filter((l) => l.startsWith("+ "));
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(added.some((l) => l.includes('button "Added"'))).toBe(true);
    // lines are +/-, one "  " context line before each hunk, "…" between hunks
    expect(third.incremental.split("\n").every((l) => l.startsWith("+ ") || l.startsWith("- ") || l.startsWith("  ") || l === "…")).toBe(true);
    expect(third.incremental.split("\n")[0]).toMatch(/^  /);
    expect(getSnapshotState(page).tracked.get("t")).toBe(third.full);
    // a different track name starts fresh
    const other = (await page.snapshot({ track: "u" })) as { full: string; incremental: string };
    expect(other.incremental).toBe(other.full);
  });
});

test("diffLines produces +/- lines in order", () => {
  // one unchanged context line before each hunk, "…" between hunks
  expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toBe("  a\n- b\n+ x\n…\n  c\n+ d");
  expect(diffLines(["a", "b"], ["x", "b"])).toBe("- a\n+ x");
  expect(diffLines(["a"], ["a"])).toBe("");
});

test("same-origin iframe is nested with f1 refs and clickable", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/frames"));
    // wait for the child frame to load
    await page.waitForFunction(() => {
      const f = document.querySelector("#same") as HTMLIFrameElement;
      return f.contentDocument?.readyState === "complete" && !!f.contentDocument.querySelector("#inner");
    });
    const yaml = (await page.snapshot()) as string;
    expect(yaml).toMatch(/- iframe \[ref=e\d+\]:\n(\s+- generic \[ref=f1e\d+\]:\n)?\s+- button "Inner button" \[ref=f1e\d+\]/);
    expect(yaml).toMatch(/- iframe \[ref=e\d+\] \[cross-origin\]/);
    // nested indentation: child lines are deeper than the iframe line
    const lines = yaml.split("\n");
    const iIdx = lines.findIndex((l) => /- iframe \[ref=e\d+\]:/.test(l));
    const iIndent = /^\s*/.exec(lines[iIdx]!)![0].length;
    const cIndent = /^\s*/.exec(lines[iIdx + 1]!)![0].length;
    expect(cIndent).toBe(iIndent + 2);
    const ref = /- button "Inner button" \[ref=(f1e\d+)\]/.exec(yaml)![1]!;
    expect(getSnapshotState(page).frames.has("f1")).toBe(true);
    const h = await page.ref(ref);
    expect(await h.evaluate((e) => e.id)).toBe("inner");
    await page.$eval("#same", (f) => {
      (f as HTMLIFrameElement).contentWindow!.document.querySelector("#inner")!.addEventListener("click", () => {
        document.title = "frame-clicked";
      });
    });
    await page.click(`ref/${ref}`);
    expect(await page.title()).toBe("frame-clicked");
    // scope into the frame by frame ref
    const scoped = (await page.snapshot({ scope: ref })) as string;
    expect(scoped).toMatch(/^- button "Inner button"( \[active\])? \[ref=f1e\d+\]/);
  });
});

test("cross-origin iframe (other port) renders the marker and is not recursed", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/xorigin"));
    const yaml = (await page.snapshot()) as string;
    expect(yaml).toMatch(/- iframe \[ref=e\d+\] \[cross-origin\]/);
    expect(yaml).not.toContain("Other origin");
    expect(getSnapshotState(page).frames.size).toBe(0);
  });
});

test("~200 element page snapshots in < 40 ms host-to-host", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/big"));
    const elements = await page.evaluate(() => document.querySelectorAll("*").length);
    expect(elements).toBeGreaterThanOrEqual(200);
    // warm: first call installs the script
    await page.snapshot();
    const times: number[] = [];
    const inPage: number[] = [];
    let yaml = "";
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      yaml = (await page.snapshot()) as string;
      times.push(performance.now() - t0);
      inPage.push(lastTimings.frames[0]!);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    console.log(
      `snapshot ${elements} elements, ${yaml.length} chars, ${yaml.split("\n").length} lines: ` +
        `host-to-host median ${median.toFixed(1)} ms (min ${times[0]!.toFixed(1)} ms), evaluate ${Math.min(...inPage).toFixed(1)} ms`,
    );
    expect(median).toBeLessThan(40);
  });
});

test("waitForSelector('ref/eN') and locator('ref/eN').click() work", async () => {
  await withPage(async (page) => {
    await page.goto(srv.url("/form"));
    const yaml = (await page.snapshot()) as string;
    const ref = /- button "Go" \[ref=(e\d+)\]/.exec(yaml)![1]!;
    const h = await page.waitForSelector(`ref/${ref}`, { visible: true });
    expect(h).not.toBeNull();
    expect(await h!.evaluate((e) => e.id)).toBe("go");
    await page.locator(`ref/${ref}`).setTimeout(3000).click();
    expect(await page.title()).toBe("clicked");
  });
});

