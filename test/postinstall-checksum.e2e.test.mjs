import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(__dirname, '..');
const postinstallSourcePath = join(workspaceRoot, 'scripts', 'postinstall.js');
const rootPackageJsonPath = join(workspaceRoot, 'package.json');

const postinstallSource = await readFile(postinstallSourcePath, 'utf8');
const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, 'utf8'));
const currentVersion = rootPackageJson.version;
const checksumRequiredFromVersion = readChecksumsRequiredFromVersion(postinstallSource);
const legacyVersion = getPreviousVersion(checksumRequiredFromVersion);
const binaryName = getBinaryName();

if (!binaryName) {
  throw new Error(`Unsupported test platform: ${platform()}-${arch()}`);
}

test('postinstall checksum verification end-to-end', async (t) => {
  await t.test('happy path: binary + valid checksum succeeds', async (t) => {
    const fakeBinary = Buffer.from('fake-binary-happy-path');
    const releaseRoot = await createReleaseRoot({
      binaryContent: fakeBinary,
      binaryName,
      includeChecksums: true,
      version: currentVersion,
    });
    t.after(() => rm(releaseRoot, { force: true, recursive: true }));

    const server = await startReleaseServer(releaseRoot);
    t.after(() => server.close());

    const packageDir = await createTempPackage({
      releaseBaseUrl: server.releaseBaseUrl,
      version: currentVersion,
    });
    t.after(() => rm(packageDir, { force: true, recursive: true }));

    const result = await runPostinstall(packageDir);
    const installedBinaryPath = join(packageDir, 'bin', binaryName);

    assert.equal(result.exitCode, 0, formatResult(result));
    assert.ok(existsSync(installedBinaryPath), 'expected the binary to remain on disk');
    assert.equal(await readFile(installedBinaryPath, 'utf8'), fakeBinary.toString('utf8'));
    assert.match(result.stdout, /Verified SHA-256 checksum/);
    assert.match(result.stdout, /Downloaded native binary/);
  });

  await t.test('tampered binary: wrong checksum fails and deletes the binary', async (t) => {
    const releaseRoot = await createReleaseRoot({
      binaryContent: Buffer.from('fake-binary-tampered'),
      binaryName,
      checksumOverrideContent: Buffer.from('different-content-for-checksum'),
      includeChecksums: true,
      version: currentVersion,
    });
    t.after(() => rm(releaseRoot, { force: true, recursive: true }));

    const server = await startReleaseServer(releaseRoot);
    t.after(() => server.close());

    const packageDir = await createTempPackage({
      releaseBaseUrl: server.releaseBaseUrl,
      version: currentVersion,
    });
    t.after(() => rm(packageDir, { force: true, recursive: true }));

    const result = await runPostinstall(packageDir);
    const installedBinaryPath = join(packageDir, 'bin', binaryName);

    assert.notEqual(result.exitCode, 0, 'expected checksum verification to fail');
    assert.equal(existsSync(installedBinaryPath), false, 'expected the binary to be deleted');
    assert.match(result.stderr, /Checksum mismatch/);
    assert.match(result.stderr, /Deleted .* due to failed checksum verification/);
  });

  await t.test('missing SHASUMS256.txt: checksum-era release fails closed', async (t) => {
    const releaseRoot = await createReleaseRoot({
      binaryContent: Buffer.from('fake-binary-missing-checksum'),
      binaryName,
      includeChecksums: false,
      version: currentVersion,
    });
    t.after(() => rm(releaseRoot, { force: true, recursive: true }));

    const server = await startReleaseServer(releaseRoot);
    t.after(() => server.close());

    const packageDir = await createTempPackage({
      releaseBaseUrl: server.releaseBaseUrl,
      version: currentVersion,
    });
    t.after(() => rm(packageDir, { force: true, recursive: true }));

    const result = await runPostinstall(packageDir);
    const installedBinaryPath = join(packageDir, 'bin', binaryName);

    assert.notEqual(result.exitCode, 0, 'expected missing checksums to fail for current releases');
    assert.equal(existsSync(installedBinaryPath), false, 'expected the binary to be deleted');
    assert.match(result.stderr, /Could not download SHASUMS256\.txt/);
    assert.match(result.stderr, /checksum verification is required for releases >=/);
  });

  await t.test('missing SHASUMS256.txt: pre-checksum release warns and succeeds', async (t) => {
    const fakeBinary = Buffer.from('fake-binary-legacy-release');
    const releaseRoot = await createReleaseRoot({
      binaryContent: fakeBinary,
      binaryName,
      includeChecksums: false,
      version: legacyVersion,
    });
    t.after(() => rm(releaseRoot, { force: true, recursive: true }));

    const server = await startReleaseServer(releaseRoot);
    t.after(() => server.close());

    const packageDir = await createTempPackage({
      releaseBaseUrl: server.releaseBaseUrl,
      version: legacyVersion,
    });
    t.after(() => rm(packageDir, { force: true, recursive: true }));

    const result = await runPostinstall(packageDir);
    const installedBinaryPath = join(packageDir, 'bin', binaryName);

    assert.equal(result.exitCode, 0, formatResult(result));
    assert.ok(existsSync(installedBinaryPath), 'expected the binary to remain on disk');
    assert.equal(await readFile(installedBinaryPath, 'utf8'), fakeBinary.toString('utf8'));
    assert.match(result.stderr, /Continuing without checksum verification for this older release/);
  });
});

function readChecksumsRequiredFromVersion(source) {
  const match = source.match(/const checksumsRequiredFromVersion = '([^']+)';/);
  assert.ok(match, 'expected postinstall.js to define checksumsRequiredFromVersion');
  return match[1];
}

function parseVersion(version) {
  const parts = version.split('.').map((part) => Number(part));
  assert.equal(parts.length, 3, `invalid semver version: ${version}`);
  assert.ok(parts.every((part) => Number.isInteger(part) && part >= 0), `invalid semver version: ${version}`);
  return parts;
}

function getPreviousVersion(version) {
  const parts = parseVersion(version);

  if (parts[2] > 0) {
    parts[2] -= 1;
    return parts.join('.');
  }

  if (parts[1] > 0) {
    parts[1] -= 1;
    parts[2] = 0;
    return parts.join('.');
  }

  if (parts[0] > 0) {
    parts[0] -= 1;
    parts[1] = 0;
    parts[2] = 0;
    return parts.join('.');
  }

  throw new Error(`Cannot derive an older version from ${version}`);
}

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
  const currentPlatform = platform();
  const currentArch = arch();

  if (currentPlatform === 'darwin') {
    if (currentArch === 'arm64' || currentArch === 'aarch64') {
      return 'dev-browser-darwin-arm64';
    }

    if (currentArch === 'x64' || currentArch === 'x86_64') {
      return 'dev-browser-darwin-x64';
    }

    return null;
  }

  if (currentPlatform === 'linux') {
    if (currentArch === 'x64' || currentArch === 'x86_64') {
      return isMusl() ? 'dev-browser-linux-musl-x64' : 'dev-browser-linux-x64';
    }

    if (currentArch === 'arm64' || currentArch === 'aarch64') {
      return isMusl() ? null : 'dev-browser-linux-arm64';
    }
  }

  if (currentPlatform === 'win32') {
    if (currentArch === 'x64' || currentArch === 'x86_64') {
      return 'dev-browser-windows-x64.exe';
    }
  }

  return null;
}

async function createReleaseRoot({
  binaryContent,
  binaryName,
  checksumOverrideContent,
  includeChecksums,
  version,
}) {
  const releaseRoot = await mkdtemp(join(tmpdir(), 'dev-browser-release-'));
  const versionDir = join(releaseRoot, 'releases', 'download', `v${version}`);
  await mkdir(versionDir, { recursive: true });

  const binaryPath = join(versionDir, binaryName);
  await writeFile(binaryPath, binaryContent);

  if (includeChecksums) {
    const checksumTarget = checksumOverrideContent ?? binaryContent;
    const shasumContents = `${sha256(checksumTarget)}  ${binaryName}\n`;
    await writeFile(join(versionDir, 'SHASUMS256.txt'), shasumContents);
  }

  return releaseRoot;
}

async function startReleaseServer(rootDir) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const requestPath = resolve(rootDir, `.${url.pathname}`);

      if (!requestPath.startsWith(rootDir)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }

      const body = await readFile(requestPath);
      response.writeHead(200, {
        'Content-Type': requestPath.endsWith('.txt')
          ? 'text/plain; charset=utf-8'
          : 'application/octet-stream',
      });
      response.end(body);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        response.writeHead(404);
        response.end('not found');
        return;
      }

      response.writeHead(500);
      response.end('server error');
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP port for the test server');
  }

  return {
    close: async () => {
      server.close();
      await once(server, 'close');
    },
    releaseBaseUrl: `http://127.0.0.1:${address.port}/releases/download`,
  };
}

async function createTempPackage({ releaseBaseUrl, version }) {
  const packageDir = await mkdtemp(join(tmpdir(), 'dev-browser-package-'));
  const scriptsDir = join(packageDir, 'scripts');
  await mkdir(scriptsDir, { recursive: true });

  const patchedPostinstallSource = postinstallSource.replace(
    "import { get } from 'https';",
    "import { get as getHttp } from 'http';\nimport { get as getHttps } from 'https';",
  )
    .replace(
      /const releasesBaseUrl = .*;\n/,
      `const releasesBaseUrl = ${JSON.stringify(releaseBaseUrl)};\n`,
    )
    .replace(
      'function getNpmGlobalPaths() {',
      `function get(url, options, callback) {
  const getter = String(url).startsWith('http://') ? getHttp : getHttps;
  return getter(url, options, callback);
}

function getNpmGlobalPaths() {`,
    );

  assert.notEqual(
    patchedPostinstallSource,
    postinstallSource,
    'expected to patch releasesBaseUrl in the temp postinstall copy',
  );

  await writeFile(join(packageDir, 'scripts', 'postinstall.js'), patchedPostinstallSource);
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: rootPackageJson.name,
        type: 'module',
        version,
      },
      null,
      2,
    ),
  );

  return packageDir;
}

async function runPostinstall(packageDir) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(process.execPath, ['scripts/postinstall.js'], {
      cwd: packageDir,
      env: {
        ...process.env,
        npm_config_global: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('exit', (exitCode, signal) => {
      resolve({
        exitCode: signal ? null : exitCode,
        signal,
        stderr: stderr.join(''),
        stdout: stdout.join(''),
      });
    });
  });
}

function formatResult(result) {
  return `exitCode=${result.exitCode} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
