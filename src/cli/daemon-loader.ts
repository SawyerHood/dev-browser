/**
 * Load the daemon bundle lazily.
 *
 * Compiled binary: `src/cli/compiled-entry.ts` embeds build/daemon.js as a
 * file asset and stores its path in globalThis.__DOOBIE_DAEMON_ASSET.
 * Dev (`bun run src/cli/main.ts`): import the TypeScript source directly.
 * The path is computed at runtime so the bundler never pulls the daemon
 * (and puppeteer) into the client bundle.
 */
export interface DaemonModule {
  startDaemon(opts?: { socketPath?: string }): Promise<void>;
  installChrome(args: string[]): Promise<number>;
  installSkill(args: string[]): Promise<number>;
  chromeCommand(args: string[]): Promise<number>;
  mcpMain(flags: import("./args.ts").GlobalFlags): Promise<number>;
}

declare global {
  // eslint-disable-next-line no-var
  var __DOOBIE_DAEMON_ASSET: string | undefined;
}

export async function loadDaemonModule(): Promise<DaemonModule> {
  const asset = globalThis.__DOOBIE_DAEMON_ASSET;
  if (asset) return (await import(asset)) as DaemonModule;
  const devPath = ["..", "daemon", "bundle.ts"].join("/");
  return (await import(new URL(devPath, import.meta.url).href)) as DaemonModule;
}
