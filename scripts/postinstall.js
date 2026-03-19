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
  let osKey;
  switch (platform()) {
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
  switch (arch()) {
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

  const extension = platform() === 'win32' ? '.exe' : '';
  return `dev-browser-${osKey}-${archKey}${extension}`;
}

const binaryName = getBinaryName();
const binaryPath = binaryName ? join(binDir, binaryName) : null;
const downloadUrl = binaryName
  ? `https://github.com/SawyerHood/dev-browser-new/releases/download/v${version}/${binaryName}`
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
    const request = (currentUrl) => {
      get(currentUrl, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          request(new URL(response.headers.location, currentUrl));
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const file = createWriteStream(tempPath);
        file.on('error', reject);
        response.on('error', reject);
        response.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              renameSync(tempPath, destination);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
      }).on('error', reject);
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
    console.warn(`Warning: Unsupported platform for native download: ${platform()}-${arch()}`);
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
    console.warn(`Warning: Could not download native binary: ${error.message}`);
    console.warn('The package install will continue, but the CLI will not run until the binary is available.');
  }

  await fixGlobalInstallBin();
  showInstallReminder();
}

main().catch((error) => {
  console.warn(`Warning: postinstall encountered an error: ${error.message}`);
});
