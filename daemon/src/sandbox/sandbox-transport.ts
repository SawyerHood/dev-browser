import {
  Connection,
  nodePlatform,
  type ClientConnectionLike,
  type PlaywrightClientLike,
  type WireMessage,
} from "./playwright-internals.js";

export interface SandboxTransportOptions {
  sendToHost: (json: string) => void;
  connection?: ClientConnectionLike;
}

export class SandboxTransport {
  readonly connection: ClientConnectionLike;

  private readonly sendToHost: (json: string) => void;

  constructor(options: SandboxTransportOptions) {
    this.connection = options.connection ?? new Connection(nodePlatform);
    this.sendToHost = options.sendToHost;
    this.connection.onmessage = (message) => {
      this.send(message);
    };
  }

  send(message: WireMessage): void {
    this.sendToHost(JSON.stringify(message));
  }

  receive(json: string): void {
    this.connection.dispatch(JSON.parse(json) as WireMessage);
  }

  receiveFromHost(json: string): void {
    this.receive(json);
  }

  initializePlaywright(): Promise<PlaywrightClientLike> {
    return this.connection.initializePlaywright();
  }

  dispose(cause?: string): void {
    this.connection.close(cause);
  }
}
