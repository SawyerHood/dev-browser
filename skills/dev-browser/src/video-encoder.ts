import { exec } from "child_process";
import { mkdir, writeFile, rm, readdir } from "fs/promises";
import { join, dirname } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface EncodeOptions {
  /** Frames per second for output video (default: 30) */
  fps?: number;
  /** Output format: 'webm' or 'mp4' (default: 'webm') */
  format?: "webm" | "mp4";
}

/**
 * Check if ffmpeg is available on the system
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execAsync("ffmpeg -version");
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode an array of JPEG frames into a video file using ffmpeg.
 * Falls back to saving frames as individual images if ffmpeg is not available.
 *
 * @param frames - Array of JPEG image buffers
 * @param outputPath - Path for the output video file
 * @param options - Encoding options
 * @returns The actual output path (may differ if fallback was used)
 */
export async function encodeFramesToVideo(
  frames: Buffer[],
  outputPath: string,
  options: EncodeOptions = {}
): Promise<string> {
  const { fps = 30, format = "webm" } = options;

  if (frames.length === 0) {
    throw new Error("No frames to encode");
  }

  // Create output directory
  await mkdir(dirname(outputPath), { recursive: true });

  // Check if ffmpeg is available
  const ffmpegAvailable = await isFfmpegAvailable();

  if (!ffmpegAvailable) {
    // Fallback: save frames as individual images
    console.warn("ffmpeg not available, saving frames as images instead");
    return await saveFramesAsImages(frames, outputPath);
  }

  // Create temp directory for frames
  const tmpDir = join(dirname(outputPath), `.tmp-frames-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // Write frames as numbered JPEGs
    await Promise.all(
      frames.map((frame, i) => {
        const framePath = join(tmpDir, `frame-${String(i).padStart(6, "0")}.jpg`);
        return writeFile(framePath, frame);
      })
    );

    // Build ffmpeg command based on format
    const inputPattern = join(tmpDir, "frame-%06d.jpg");
    let ffmpegCmd: string;

    if (format === "mp4") {
      ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p -preset fast "${outputPath}"`;
    } else {
      // WebM with VP9
      ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${inputPattern}" -c:v libvpx-vp9 -pix_fmt yuv420p -crf 30 -b:v 0 "${outputPath}"`;
    }

    // Run ffmpeg
    await execAsync(ffmpegCmd);

    return outputPath;
  } finally {
    // Clean up temp directory
    try {
      await rm(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Fallback: Save frames as individual images in a directory
 */
async function saveFramesAsImages(frames: Buffer[], outputPath: string): Promise<string> {
  // Use output path as directory name (without extension)
  const framesDir = outputPath.replace(/\.[^.]+$/, "-frames");
  await mkdir(framesDir, { recursive: true });

  await Promise.all(
    frames.map((frame, i) => {
      const framePath = join(framesDir, `frame-${String(i).padStart(6, "0")}.jpg`);
      return writeFile(framePath, frame);
    })
  );

  console.log(`Saved ${frames.length} frames to ${framesDir}`);
  return framesDir;
}

/**
 * Get video metadata using ffprobe
 */
export async function getVideoMetadata(
  videoPath: string
): Promise<{ duration: number; width: number; height: number } | null> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of json "${videoPath}"`
    );
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0];
    if (!stream) return null;

    return {
      duration: parseFloat(stream.duration) || 0,
      width: parseInt(stream.width, 10) || 0,
      height: parseInt(stream.height, 10) || 0,
    };
  } catch {
    return null;
  }
}
