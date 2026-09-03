/**
 * Entry for `bun build --compile`. Embeds the daemon bundle as a file asset
 * so the client bundle stays tiny and starts fast.
 */
// @ts-ignore - bundler asset import
import daemonAsset from "../../build/daemon.js" with { type: "file" };
import { runCli } from "./main.ts";

globalThis.__DEV_BROWSER_DAEMON_ASSET = daemonAsset as string;
runCli();
