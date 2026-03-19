#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const cliDir = join(projectRoot, 'cli');
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const cargoTomlPath = join(cliDir, 'Cargo.toml');

let cargoToml = readFileSync(cargoTomlPath, 'utf8');
const versionLine = `version = "${version}"`;
const versionPattern = /^version\s*=\s*"[^"]*"$/m;

if (!versionPattern.test(cargoToml)) {
  console.error('Could not find the version field in cli/Cargo.toml.');
  process.exit(1);
}

if (!cargoToml.includes(versionLine)) {
  cargoToml = cargoToml.replace(versionPattern, versionLine);
  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`Updated cli/Cargo.toml to version ${version}.`);

  try {
    execSync('cargo update -p dev-browser --offline', {
      cwd: cliDir,
      stdio: 'pipe',
    });
    console.log('Updated cli/Cargo.lock.');
  } catch {
    try {
      execSync('cargo update -p dev-browser', {
        cwd: cliDir,
        stdio: 'pipe',
      });
      console.log('Updated cli/Cargo.lock.');
    } catch (error) {
      console.warn(`Warning: Could not update cli/Cargo.lock: ${error.message}`);
    }
  }
} else {
  console.log(`cli/Cargo.toml already matches package.json version ${version}.`);
}
