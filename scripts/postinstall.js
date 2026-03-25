#!/usr/bin/env node

import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { get } from 'https';
import { arch, platform } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const binDir = join(projectRoot, 'bin');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const packageName = packageJson.name;
const version = packageJson.version;
const repoSlug = 'SawyerHood/dev-browser';
const releasesBaseUrl = `https://github.com/${repoSlug}/releases/download`;
const supportedTargets = Object.freeze({
  'darwin-arm64': 'dev-browser-darwin-arm64',
  'darwin-x64': 'dev-browser-darwin-x64',
  'linux-arm64': 'dev-browser-linux-arm64',
  'linux-musl-x64': 'dev-browser-linux-musl-x64',
  'linux-x64': 'dev-browser-linux-x64',
  'win32-x64': 'dev-browser-windows-x64.exe',
});

function isMusl() {
  if (platform() !== 'linux') {
    return false;
  }

  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) {
      return false;
    }
  } catch {
    // Fall through to the ldd probe.
  }

  try {
    const output = execSync('ldd --version 2>&1', { encoding: 'utf8' });
    return output.toLowerCase().includes('musl');
  } catch {
    return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  }
}

function getTargetKey() {
  const currentPlatform = platform();
  const currentArch = arch();

  if (currentPlatform === 'darwin') {
    if (currentArch === 'arm64' || currentArch === 'aarch64') {
      return 'darwin-arm64';
    }

    if (currentArch === 'x64' || currentArch === 'x86_64') {
      return 'darwin-x64';
    }

    return null;
  }

  if (currentPlatform === 'linux') {
    if (currentArch === 'x64' || currentArch === 'x86_64') {
      return isMusl() ? 'linux-musl-x64' : 'linux-x64';
    }

    if (currentArch === 'arm64' || currentArch === 'aarch64') {
      return isMusl() ? null : 'linux-arm64';
    }
  }

  if (currentPlatform === 'win32') {
    if (currentArch === 'x64' || currentArch === 'x86_64') {
      return 'win32-x64';
    }
  }

  return null;
}

function getBinaryName() {
  const targetKey = getTargetKey();
  return targetKey ? supportedTargets[targetKey] : null;
}

function getSupportedPlatformsText() {
  return Object.keys(supportedTargets).join(', ');
}

function shouldFailInstall() {
  return !existsSync(join(projectRoot, '.git'));
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function failOrWarn(message) {
  if (shouldFailInstall()) {
    throw new Error(message);
  }

  console.warn(`Warning: ${message}`);
  console.warn('Continuing because this appears to be a local checkout, not a packaged npm install.');
}

const binaryName = getBinaryName();
const binaryPath = binaryName ? join(binDir, binaryName) : null;
const downloadUrl = binaryName
  ? `${releasesBaseUrl}/v${version}/${binaryName}`
  : null;

function getNpmGlobalPaths() {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    return {
      prefix,
      binDir: platform() === 'win32' ? prefix : join(prefix, 'bin'),
      nodeModulesDir:
        platform() === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules'),
    };
  } catch {
    return null;
  }
}

function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isGlobalInstall() {
  if (process.env.npm_config_global === 'true') {
    return true;
  }

  const globalPaths = getNpmGlobalPaths();
  if (!globalPaths) {
    return false;
  }

  const expectedRoot = normalizePath(join(globalPaths.nodeModulesDir, packageName));
  return normalizePath(projectRoot) === expectedRoot;
}

async function downloadFile(url, destination) {
  const tempPath = `${destination}.download`;
  rmSync(tempPath, { force: true });

  return new Promise((resolve, reject) => {
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const resolveOnce = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    const request = (currentUrl, redirectsRemaining = 10) => {
      const req = get(
        currentUrl,
        {
          headers: {
            Accept: 'application/octet-stream',
            'User-Agent': `${packageName}/${version}`,
          },
        },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            if (redirectsRemaining === 0) {
              response.resume();
              rejectOnce(new Error(`Too many redirects while downloading ${url}`));
              return;
            }

            response.resume();
            request(new URL(response.headers.location, currentUrl), redirectsRemaining - 1);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            rejectOnce(new Error(`HTTP ${response.statusCode ?? 'unknown'} from ${currentUrl}`));
            return;
          }

          const file = createWriteStream(tempPath);
          const onStreamError = (error) => {
            rejectOnce(new Error(`${currentUrl}: ${formatErrorMessage(error)}`));
          };

          file.on('error', onStreamError);
          response.on('error', onStreamError);
          response.on('aborted', () => {
            rejectOnce(new Error(`Download aborted for ${currentUrl}`));
          });
          response.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              try {
                renameSync(tempPath, destination);
                resolveOnce();
              } catch (error) {
                rejectOnce(error);
              }
            });
          });
        },
      );

      req.on('error', (error) => {
        rejectOnce(new Error(`${currentUrl}: ${formatErrorMessage(error)}`));
      });

      req.setTimeout(30_000, () => {
        req.destroy(new Error(`Request timed out after 30s for ${currentUrl}`));
      });
    };

    request(url);
  }).catch((error) => {
    rmSync(tempPath, { force: true });
    throw error;
  });
}

function ensureExecutable(path) {
  if (platform() !== 'win32') {
    chmodSync(path, 0o755);
  }
}

function showInstallReminder() {
  console.log('');
  console.log('Run `dev-browser install` to install Playwright + Chromium.');
  console.log('');
}

async function fixGlobalInstallBin() {
  if (!isGlobalInstall() || !binaryPath || !existsSync(binaryPath)) {
    return;
  }

  if (platform() === 'win32') {
    fixWindowsShims();
    return;
  }

  fixUnixSymlink();
}

function fixUnixSymlink() {
  const globalPaths = getNpmGlobalPaths();
  if (!globalPaths) {
    return;
  }

  const symlinkPath = join(globalPaths.binDir, packageName);

  try {
    const stat = lstatSync(symlinkPath);
    if (!stat.isSymbolicLink()) {
      return;
    }
  } catch {
    return;
  }

  try {
    unlinkSync(symlinkPath);
    symlinkSync(binaryPath, symlinkPath);
    console.log('Optimized global install: npm bin symlink now targets the native binary.');
  } catch (error) {
    console.warn(`Warning: Could not optimize the global symlink: ${error.message}`);
  }
}

function fixWindowsShims() {
  const globalPaths = getNpmGlobalPaths();
  if (!globalPaths) {
    return;
  }

  const cmdShim = join(globalPaths.binDir, `${packageName}.cmd`);
  const ps1Shim = join(globalPaths.binDir, `${packageName}.ps1`);
  if (!existsSync(cmdShim)) {
    return;
  }

  const relativeBinaryPath = `node_modules\\${packageName}\\bin\\${binaryName}`;
  const absoluteBinaryPath = join(globalPaths.binDir, relativeBinaryPath);
  if (!existsSync(absoluteBinaryPath)) {
    return;
  }

  try {
    writeFileSync(cmdShim, `@ECHO off\r\n"%~dp0${relativeBinaryPath}" %*\r\n`);
    writeFileSync(
      ps1Shim,
      `#!/usr/bin/env pwsh\r\n$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "$basedir\\${relativeBinaryPath}" $args\r\nexit $LASTEXITCODE\r\n`,
    );
    console.log('Optimized global install: Windows shims now target the native binary.');
  } catch (error) {
    console.warn(`Warning: Could not optimize Windows shims: ${error.message}`);
  }
}

async function main() {
  if (!binaryName || !binaryPath || !downloadUrl) {
    failOrWarn(
      [
        `Unsupported platform for native download: ${platform()}-${arch()}.`,
        `Supported platforms: ${getSupportedPlatformsText()}.`,
      ].join('\n'),
    );
    return;
  }

  mkdirSync(binDir, { recursive: true });

  if (existsSync(binaryPath)) {
    ensureExecutable(binaryPath);
    console.log(`Native binary already present: ${binaryName}`);
    await fixGlobalInstallBin();
    showInstallReminder();
    return;
  }

  console.log(`Downloading native binary for ${platform()}-${arch()}...`);
  console.log(`URL: ${downloadUrl}`);

  try {
    await downloadFile(downloadUrl, binaryPath);
    ensureExecutable(binaryPath);
    console.log(`Downloaded native binary: ${binaryName}`);
  } catch (error) {
    failOrWarn(
      [
        `Could not download native binary "${binaryName}" for ${platform()}-${arch()}.`,
        `Tried: ${downloadUrl}`,
        `Cause: ${formatErrorMessage(error)}`,
        'This package cannot run without the native binary.',
      ].join('\n'),
    );
    return;
  }

  await fixGlobalInstallBin();
  showInstallReminder();
}

main().catch((error) => {
  console.error(`Error: dev-browser postinstall failed: ${formatErrorMessage(error)}`);
  process.exitCode = 1;
});
