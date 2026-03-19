#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import { accessSync, chmodSync, constants, existsSync } from 'fs';
import { arch, platform } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case 'darwin':
      osKey = 'darwin';
      break;
    case 'linux':
      osKey = isMusl() ? 'linux-musl' : 'linux';
      break;
    case 'win32':
      osKey = 'win32';
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case 'x64':
    case 'x86_64':
      archKey = 'x64';
      break;
    case 'arm64':
    case 'aarch64':
      archKey = 'arm64';
      break;
    default:
      return null;
  }

  const extension = os === 'win32' ? '.exe' : '';
  return `dev-browser-${osKey}-${archKey}${extension}`;
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
    process.exit(1);
  }

  const binaryPath = join(__dirname, binaryName);

  if (!existsSync(binaryPath)) {
    console.error(`Error: Native binary not found for ${platform()}-${arch()}`);
    console.error(`Expected: ${binaryPath}`);
    console.error('');
    console.error('The postinstall step downloads this binary from GitHub releases.');
    console.error('Reinstall the package to retry the download, or verify this release includes');
    console.error(`the asset "${binaryName}" for your platform.`);
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
