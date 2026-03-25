import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const daemonDir = fileURLToPath(new URL("../../../", import.meta.url));
const tsxCliPath = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)
);

export async function ensureSandboxClientBundle(): Promise<void> {
  await execFileAsync(process.execPath, [tsxCliPath, "scripts/bundle-sandbox-client.ts"], {
    cwd: daemonDir,
  });
}
