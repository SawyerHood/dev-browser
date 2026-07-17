import {
  DispatcherConnection,
  type DispatcherConnectionLike,
  PlaywrightDispatcher,
  type PlaywrightDispatcherLike,
  RootDispatcher,
  type RootDispatcherLike,
  createPlaywright,
} from "./playwright-internals.js";
import { checkProtocolMessage, formatPolicyError } from "./sandbox-policy.js";

export interface HostBridgeOptions {
  sendToSandbox: (json: string) => void;
  preLaunchedBrowser?: unknown;
  sharedBrowser?: boolean;
  denyLaunch?: boolean;
  sdkLanguage?: string;
}

export class HostBridge {
  private readonly dispatcherConnection: DispatcherConnectionLike;
  private readonly rootDispatcher: RootDispatcherLike;
  private readonly playwright: unknown;
  private readonly sendToSandbox: (json: string) => void;
  private readonly options: Omit<HostBridgeOptions, "sendToSandbox">;

  private playwrightDispatcher?: PlaywrightDispatcherLike;
  private disposed = false;

  constructor(options: HostBridgeOptions) {
    this.sendToSandbox = options.sendToSandbox;
    this.options = {
      preLaunchedBrowser: options.preLaunchedBrowser,
      sharedBrowser: options.sharedBrowser,
      denyLaunch: options.denyLaunch,
      sdkLanguage: options.sdkLanguage ?? "javascript",
    };
    this.playwright = createPlaywright({
      sdkLanguage: this.options.sdkLanguage ?? "javascript",
    });
    this.dispatcherConnection = new DispatcherConnection(false);
    this.dispatcherConnection.onmessage = (message) => {
      this.sendToSandbox(JSON.stringify(message));
    };
    this.rootDispatcher = new RootDispatcher(this.dispatcherConnection, async (rootScope) => {
      this.playwrightDispatcher = new PlaywrightDispatcher(rootScope, this.playwright, {
        preLaunchedBrowser: this.options.preLaunchedBrowser,
        sharedBrowser: this.options.sharedBrowser,
        denyLaunch: this.options.denyLaunch,
      });
      return this.playwrightDispatcher;
    });
  }

  async receiveFromSandbox(json: string): Promise<void> {
    const message = JSON.parse(json) as Record<string, unknown>;
    const violation = checkProtocolMessage(message);
    if (violation) {
      const id = typeof message.id === "number" ? message.id : 0;
      this.sendToSandbox(
        JSON.stringify({
          id,
          error: {
            error: {
              name: "Error",
              message: formatPolicyError(violation),
              stack: "",
            },
          },
        })
      );
      return;
    }
    await this.dispatcherConnection.dispatch(message);
  }

  async stopPendingOperations(error: Error): Promise<void> {
    const dispatchers = this.dispatcherConnection._dispatcherByGuid;
    if (!dispatchers) {
      await this.rootDispatcher.stopPendingOperations(error);
      return;
    }

    const controllers = new Set(
      [...new Set(dispatchers.values())].flatMap((dispatcher) => [
        ...(dispatcher._activeProgressControllers ?? []),
      ])
    );
    await Promise.all([...controllers].map((controller) => controller.abort(error)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.dispatcherConnection.onmessage = () => {};

    let cleanupError: unknown;
    try {
      await this.stopPendingOperations(new Error("Sandbox bridge disposed"));
    } catch (error) {
      cleanupError = error;
    }
    try {
      await this.playwrightDispatcher?.cleanup();
    } catch (error) {
      cleanupError ??= error;
    } finally {
      this.rootDispatcher._dispose();
    }

    if (cleanupError) {
      throw cleanupError;
    }
  }
}
