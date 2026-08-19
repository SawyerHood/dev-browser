/**
 * page.shot(): JPEG screenshot into the tmp jail, downscaled to <= 1568 px
 * on the longest edge, with image pixels mapped 1:1 to CSS pixels whenever
 * no downscale is needed (so coordinates read off the image feed page.mouse).
 */
import * as fs from "node:fs";
import type { Page, ScreenshotOptions } from "puppeteer-core";
import { jailPath, ensureHome } from "../shared/paths.ts";
import { DEFAULTS } from "../shared/config.ts";
import { currentRun } from "../daemon/run-context.ts";

export interface ShotOptions {
  /** File name inside ~/.doobie/tmp. Default: shot-<timestamp>.jpg */
  name?: string;
  fullPage?: boolean;
  /** CSS-pixel clip in the page's coordinate space. */
  clip?: { x: number; y: number; width: number; height: number };
  /** JPEG quality 1-100. Default 80. */
  quality?: number;
  /** Longest edge in pixels. Default 1568. */
  maxEdge?: number;
  /** "jpeg" (default) or "png". */
  type?: "jpeg" | "png";
}

export interface ShotResult {
  path: string;
  width: number;
  height: number;
  /** Image pixels per CSS pixel. 1 means coordinates map 1:1. */
  scale: number;
  fullPage: boolean;
}

let counter = 0;

export async function shot(page: Page, opts: ShotOptions = {}): Promise<ShotResult> {
  ensureHome();
  const type = opts.type ?? "jpeg";
  const ext = type === "png" ? "png" : "jpg";
  const name = opts.name ?? `shot-${Date.now()}-${++counter}.${ext}`;
  const file = jailPath(name.includes(".") ? name : `${name}.${ext}`);
  const maxEdge = opts.maxEdge ?? DEFAULTS.shotMaxEdge;
  const quality = opts.quality ?? DEFAULTS.shotQuality;

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
  if (opts.clip) {
    clip = opts.clip;
  } else if (opts.fullPage) {
    clip = { x: 0, y: 0, width: Math.max(1, metrics.sw), height: Math.max(1, metrics.sh) };
  } else {
    clip = { x: metrics.sx, y: metrics.sy, width: Math.max(1, metrics.vw), height: Math.max(1, metrics.vh) };
  }
  const longest = Math.max(clip.width, clip.height);
  // scale is relative to CSS px * DPR; normalise to 1 image px per CSS px, then shrink to fit.
  const fit = longest > maxEdge ? maxEdge / longest : 1;
  const scale = fit / metrics.dpr;

  const so: ScreenshotOptions = {
    type,
    path: file as `${string}.png` | `${string}.jpeg` | `${string}.jpg`,
    clip: { ...clip, scale },
    captureBeyondViewport: !!opts.fullPage || !!opts.clip,
    optimizeForSpeed: true,
  };
  if (type === "jpeg") so.quality = Math.max(1, Math.min(100, quality));
  await page.screenshot(so);

  const dims = readDims(file, type) ?? {
    width: Math.round(clip.width * fit),
    height: Math.round(clip.height * fit),
  };
  const result: ShotResult = { path: file, width: dims.width, height: dims.height, scale: fit, fullPage: !!opts.fullPage };
  currentRun()?.emit({ type: "image", path: file, width: result.width, height: result.height });
  return result;
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
