import { HostBridge, type HostBridgeOptions } from "./host-bridge.js";
import { SandboxTransport, type SandboxTransportOptions } from "./sandbox-transport.js";
import type { ClientConnectionLike, PlaywrightClientLike } from "./playwright-internals.js";

type DeliveryScheduler = (task: () => void) => void;

export interface ProtocolBridgeOptions
  extends Omit<HostBridgeOptions, "sendToSandbox">,
    Omit<SandboxTransportOptions, "sendToHost"> {
  schedule?: DeliveryScheduler;
}

function defaultSchedule(task: () => void): void {
  setImmediate(task);
}

function scheduleDelivery(
  schedule: DeliveryScheduler,
  deliver: () => void | Promise<void>
): void {
  schedule(() => {
    Promise.resolve(deliver()).catch((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });
  });
}

export class ProtocolBridge {
  readonly hostBridge: HostBridge;
  readonly sandboxTransport: SandboxTransport;
  readonly connection: ClientConnectionLike;

  private readonly schedule: DeliveryScheduler;
  private disposed = false;

  constructor(options: ProtocolBridgeOptions = {}) {
    this.schedule = options.schedule ?? defaultSchedule;

    let sandboxTransport: SandboxTransport;

    this.hostBridge = new HostBridge({
      preLaunchedBrowser: options.preLaunchedBrowser,
      sharedBrowser: options.sharedBrowser,
      denyLaunch: options.denyLaunch,
      sdkLanguage: options.sdkLanguage,
      sendToSandbox: (json) => {
        scheduleDelivery(this.schedule, () => sandboxTransport.receiveFromHost(json));
      },
    });

    sandboxTransport = new SandboxTransport({
      connection: options.connection,
      sendToHost: (json) => {
        scheduleDelivery(this.schedule, () => this.hostBridge.receiveFromSandbox(json));
      },
    });

    this.sandboxTransport = sandboxTransport;
    this.connection = sandboxTransport.connection;
  }

  initializePlaywright(): Promise<PlaywrightClientLike> {
    return this.sandboxTransport.initializePlaywright();
  }

  async dispose(cause?: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.sandboxTransport.dispose(cause);
    await this.hostBridge.dispose();
  }
}

export function createProtocolBridge(options: ProtocolBridgeOptions = {}): ProtocolBridge {
  return new ProtocolBridge(options);
}
