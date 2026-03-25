import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { getDevBrowserBaseDir } from "./local-endpoint.js";

const SAFE_PATH_SEGMENT_PATTERN = /[^A-Za-z0-9._-]/g;
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

export const DEV_BROWSER_BASE_DIR = getDevBrowserBaseDir();
export const DEV_BROWSER_TMP_DIR = path.join(DEV_BROWSER_BASE_DIR, "tmp");

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value;
}

function isWithinDirectory(rootDir: string, candidatePath: string): boolean {
  if (candidatePath === rootDir) {
    return true;
  }

  const rootWithSeparator = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  return candidatePath.startsWith(rootWithSeparator);
}

function sanitizePathSegment(segment: string): string {
  if (segment.length === 0) {
    throw new Error("File paths must not contain empty path segments");
  }
  if (segment === "." || segment === ".." || segment.includes("..")) {
    throw new Error("File paths must not contain '.' or '..' segments");
  }

  const sanitized = segment.replace(SAFE_PATH_SEGMENT_PATTERN, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    throw new Error("File paths must resolve to a valid filename");
  }

  return sanitized;
}

function sanitizeRelativePath(fileName: unknown): string[] {
  const rawPath = requireNonEmptyString(fileName, "File name");
  if (rawPath.includes("\0")) {
    throw new Error("File names must not contain null bytes");
  }
  if (path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
    throw new Error("Absolute paths are not allowed");
  }

  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error("Absolute paths are not allowed");
  }

  return normalized.split("/").map(sanitizePathSegment);
}

async function assertControlledDirectory(directoryPath: string, label: string): Promise<void> {
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
}

async function assertSafeParentDirectories(
  rootDir: string,
  destinationPath: string,
  createParents: boolean
): Promise<void> {
  const relativeParent = path.relative(rootDir, path.dirname(destinationPath));
  if (relativeParent.length === 0) {
    return;
  }

  const segments = relativeParent.split(path.sep).filter((segment) => segment.length > 0);
  let currentPath = rootDir;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    if (createParents) {
      await mkdir(currentPath, {
        recursive: true,
      });
    }

    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Temp path parent must not be a symlink: ${currentPath}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Temp path parent must be a directory: ${currentPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !createParents) {
        return;
      }
      throw error;
    }
  }
}

function normalizeSymlinkError(error: unknown, destinationPath: string): Error {
  if ((error as NodeJS.ErrnoException).code === "ELOOP") {
    return new Error(`Refusing to follow symlinked temp file: ${destinationPath}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function assertDestinationIsNotSymlink(destinationPath: string): Promise<void> {
  try {
    const stats = await lstat(destinationPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlinked temp file: ${destinationPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

export async function ensureDevBrowserTempDir(): Promise<string> {
  await mkdir(DEV_BROWSER_BASE_DIR, {
    recursive: true,
  });
  await assertControlledDirectory(DEV_BROWSER_BASE_DIR, "Dev Browser base directory");

  await mkdir(DEV_BROWSER_TMP_DIR, {
    recursive: true,
  });
  await assertControlledDirectory(DEV_BROWSER_TMP_DIR, "Dev Browser temp directory");

  return path.resolve(DEV_BROWSER_TMP_DIR);
}

export async function resolveDevBrowserTempPath(
  fileName: unknown,
  options: {
    createParents?: boolean;
  } = {}
): Promise<string> {
  const rootDir = await ensureDevBrowserTempDir();
  const segments = sanitizeRelativePath(fileName);
  const destinationPath = path.resolve(rootDir, ...segments);

  if (!isWithinDirectory(rootDir, destinationPath)) {
    throw new Error("Resolved temp file path escapes the controlled temp directory");
  }

  await assertSafeParentDirectories(rootDir, destinationPath, options.createParents ?? false);
  return destinationPath;
}

export async function writeDevBrowserTempFile(
  fileName: unknown,
  data: string | Uint8Array
): Promise<string> {
  const destinationPath = await resolveDevBrowserTempPath(fileName, {
    createParents: true,
  });
  await assertDestinationIsNotSymlink(destinationPath);

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW_FLAG,
      0o600
    );
    await handle.writeFile(data);
  } catch (error) {
    throw normalizeSymlinkError(error, destinationPath);
  } finally {
    await handle?.close();
  }

  return destinationPath;
}

export async function readDevBrowserTempFile(fileName: unknown): Promise<string> {
  const destinationPath = await resolveDevBrowserTempPath(fileName);
  await assertDestinationIsNotSymlink(destinationPath);

  let handle: FileHandle | undefined;
  try {
    handle = await open(destinationPath, constants.O_RDONLY | NOFOLLOW_FLAG);
    return await handle.readFile({
      encoding: "utf8",
    });
  } catch (error) {
    throw normalizeSymlinkError(error, destinationPath);
  } finally {
    await handle?.close();
  }
}
