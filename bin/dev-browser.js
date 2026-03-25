#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import { accessSync, chmodSync, constants, existsSync, readFileSync } from 'fs';
import { arch, platform } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const version = packageJson.version;
const repoSlug = 'SawyerHood/dev-browser';
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

function ensureExecutable(binaryPath) {
  if (platform() === 'win32') {
    return;
  }

  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    chmodSync(binaryPath, 0o755);
  }
}

function main() {
  const binaryName = getBinaryName();

  if (!binaryName) {
    console.error(`Error: Unsupported platform: ${platform()}-${arch()}`);
    console.error(`Supported platforms: ${getSupportedPlatformsText()}`);
    process.exit(1);
  }

  const binaryPath = join(__dirname, binaryName);
  const releaseAssetUrl = `https://github.com/${repoSlug}/releases/download/v${version}/${binaryName}`;

  if (!existsSync(binaryPath)) {
    console.error(`Error: Native binary not found for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    console.error('');
    console.error('The postinstall step downloads this binary from GitHub releases.');
    console.error('Reinstall the package to retry the download, or verify this release includes');
    console.error(`the asset "${binaryName}" for your platform.`);
    console.error(`Expected release asset URL: ${releaseAssetUrl}`);
    process.exit(1);
  }

  try {
    ensureExecutable(binaryPath);
  } catch (error) {
    console.error(`Error: Cannot make the native binary executable: ${error.message}`);
    process.exit(1);
  }

  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('error', (error) => {
    console.error(`Error executing native binary: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

main();
