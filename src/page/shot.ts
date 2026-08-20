/**
 * page.shot(): JPEG screenshot into the tmp jail, downscaled to <= 1568 px
 * on the longest edge, with image pixels mapped 1:1 to CSS pixels whenever
 * no downscale is needed (so coordinates read off the image feed page.mouse).
 *
 * Math: image px = CSS px * scale, scale = min(1, maxEdge / longest CSS edge).
 * Chrome multiplies the clip scale by the device pixel ratio, so we pass
 * clip.scale = scale / dpr. For plain viewport shots Puppeteer's
 * page.screenshot drops clip.scale (it intersects the clip with the viewport
 * and loses the field), so the capture goes through the CDP session directly
 * when available, which also avoids the resize event that
 * captureBeyondViewport: true triggers.
 */
import * as fs from "node:fs";
import type { Page, ScreenshotOptions, CDPSession } from "puppeteer-core";
import { jailPath, ensureHome } from "../shared/paths.ts";
import { DEFAULTS } from "../shared/config.ts";
import { currentRun } from "../daemon/run-context.ts";

export interface ShotOptions {
  /** File name inside ~/.doobie/tmp. Default: shot-<timestamp>.jpg. A .png/.jpg/.jpeg extension selects the type. */
  name?: string;
  fullPage?: boolean;
  /** CSS-pixel clip in the page's coordinate space. */
  clip?: { x: number; y: number; width: number; height: number };
  /** JPEG quality 1-100. Default 80. */
  quality?: number;
  /** Longest edge in pixels. Default 1568. */
  maxEdge?: number;
  /** "jpeg" (default) or "png". Inferred from `name` when omitted. */
  type?: "jpeg" | "png";
}

export interface ShotResult {
  path: string;
  width: number;
  height: number;
  /** Image pixels per CSS pixel. 1 means coordinates map 1:1. */
  scale: number;
}

let counter = 0;

/** Resolve output type and file name: an explicit type wins; otherwise the name's extension; otherwise jpeg. */
export function resolveShotFile(opts: Pick<ShotOptions, "name" | "type">): { type: "jpeg" | "png"; file: string } {
  const name = opts.name;
  const m = name ? /\.(png|jpe?g)$/i.exec(name) : null;
  const extType: "jpeg" | "png" | null = m ? (m[1]!.toLowerCase() === "png" ? "png" : "jpeg") : null;
  const type: "jpeg" | "png" = opts.type ?? extType ?? "jpeg";
  const ext = type === "png" ? "png" : "jpg";
  let fileName: string;
  if (!name) fileName = `shot-${Date.now()}-${++counter}.${ext}`;
  else if (extType === type) fileName = name;
  else fileName = `${name}.${ext}`;
  return { type, file: jailPath(fileName) };
}

export async function shot(page: Page, opts: ShotOptions = {}): Promise<ShotResult> {
  ensureHome();
  const { type, file } = resolveShotFile(opts);
  const maxEdge = opts.maxEdge ?? DEFAULTS.shotMaxEdge;
  const quality = Math.max(1, Math.min(100, opts.quality ?? DEFAULTS.shotQuality));

  const metrics = await page.evaluate(() => ({
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    sw: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    sh: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    sx: window.scrollX,
    sy: window.scrollY,
  }));

  let clip: { x: number; y: number; width: number; height: number };
  const beyondViewport = !!opts.fullPage || !!opts.clip;
  if (opts.clip) {
    clip = opts.clip;
  } else if (opts.fullPage) {
    clip = { x: 0, y: 0, width: Math.max(1, metrics.sw), height: Math.max(1, metrics.sh) };
  } else {
    clip = { x: metrics.sx, y: metrics.sy, width: Math.max(1, metrics.vw), height: Math.max(1, metrics.vh) };
  }
  clip = { x: clip.x, y: clip.y, width: Math.max(1, clip.width), height: Math.max(1, clip.height) };
  const longest = Math.max(clip.width, clip.height);
  // Image px per CSS px: 1:1 unless the longest edge must shrink to fit.
  const fit = longest > maxEdge ? maxEdge / longest : 1;
  // Chrome's clip.scale is relative to device pixels (CSS px * DPR); normalise.
  const cdpScale = fit / metrics.dpr;

  const client = cdpSessionOf(page);
  if (client) {
    const { data } = (await client.send("Page.captureScreenshot", {
      format: type,
      ...(type === "jpeg" ? { quality } : {}),
      clip: { ...clip, scale: cdpScale },
      captureBeyondViewport: beyondViewport,
      optimizeForSpeed: true,
    })) as { data: string };
    fs.writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
  } else {
    const so: ScreenshotOptions = {
      type,
      path: file as `${string}.png` | `${string}.jpeg` | `${string}.jpg`,
      clip: { ...clip, scale: cdpScale },
      // Puppeteer drops clip.scale unless captureBeyondViewport is set.
      captureBeyondViewport: true,
      optimizeForSpeed: true,
    };
    if (type === "jpeg") so.quality = quality;
    await page.screenshot(so);
  }

  const dims = readDims(file, type) ?? {
    width: Math.round(clip.width * fit),
    height: Math.round(clip.height * fit),
  };
  // Report what the file actually is, so scale and size can never disagree.
  const scale = Math.round((dims.width / clip.width) * 10_000) / 10_000;
  const result: ShotResult = { path: file, width: dims.width, height: dims.height, scale };
  currentRun()?.emit({ type: "image", path: file, width: result.width, height: result.height });
  return result;
}

function cdpSessionOf(page: Page): CDPSession | null {
  const p = page as unknown as { _client?: () => CDPSession };
  try {
    const c = typeof p._client === "function" ? p._client() : null;
    return c && typeof c.send === "function" ? c : null;
  } catch {
    return null;
  }
}

/** Read width/height from a PNG or JPEG header without a decoder. */
export function readDims(file: string, type: "jpeg" | "png"): { width: number; height: number } | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (type === "png") {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan markers for SOF0/SOF2
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
