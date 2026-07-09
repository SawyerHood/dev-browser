import { formatError } from "./format-error.js";
import type { ExecuteRequest, Response } from "./protocol.js";

export interface ExecuteRequestTransport {
  isOpen(): boolean;
  onDisconnect(listener: () => void): () => void;
  send(message: Response): Promise<void>;
}

interface ScriptOutput {
  onStdout(data: string): void;
  onStderr(data: string): void;
}

export interface ExecuteRequestDependencies {
  prepareBrowser(
    request: ExecuteRequest,
    context: { deadline: number; signal: AbortSignal }
  ): Promise<void>;
  runScript(
    request: ExecuteRequest,
    output: ScriptOutput,
    context: { deadline: number; signal: AbortSignal }
  ): Promise<void>;
  withBrowserLock<T>(
    browser: string,
    action: () => Promise<T>,
    options: { signal: AbortSignal }
  ): Promise<T>;
}

class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Script timed out after ${formatTimeoutDuration(timeoutMs)} and was terminated.`);
    this.name = "ScriptTimeoutError";
  }
}

class RequestDisconnectedError extends Error {
  constructor() {
    super("Client disconnected");
    this.name = "RequestDisconnectedError";
  }
}

function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs % 1_000 === 0) {
    return `${timeoutMs / 1_000}s`;
  }

  return `${timeoutMs}ms`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

class RequestSession {
  readonly deadline: number;
  readonly signal: AbortSignal;

  readonly #controller = new AbortController();
  readonly #detachDisconnect: () => void;
  readonly #request: ExecuteRequest;
  readonly #timeout: ReturnType<typeof setTimeout>;
  readonly #timeoutMs: number;
  readonly #transport: ExecuteRequestTransport;

  #active = true;
  #messages = Promise.resolve();
  #terminal = Promise.resolve();

  constructor(request: ExecuteRequest, timeoutMs: number, transport: ExecuteRequestTransport) {
    this.#request = request;
    this.#timeoutMs = timeoutMs;
    this.#transport = transport;
    this.deadline = Date.now() + timeoutMs;
    this.signal = this.#controller.signal;
    this.#detachDisconnect = transport.onDisconnect(() => {
      this.#disconnect();
    });
    this.#timeout = setTimeout(() => {
      this.#finish(
        {
          id: request.id,
          type: "error",
          message: new RequestTimeoutError(timeoutMs).message,
        },
        new RequestTimeoutError(timeoutMs)
      );
    }, timeoutMs);
    this.#timeout.unref?.();
  }

  stream(type: "stdout" | "stderr", data: string): void {
    if (!this.#active) {
      return;
    }

    this.#messages = this.#messages
      .then(async () => {
        if (this.#transport.isOpen()) {
          await this.#transport.send({ id: this.#request.id, type, data });
        }
      })
      .catch(() => undefined);
  }

  async complete(): Promise<void> {
    this.#finish({ id: this.#request.id, type: "complete", success: true });
    await this.#terminal;
  }

  async fail(error: unknown): Promise<void> {
    this.#finish({ id: this.#request.id, type: "error", message: formatError(error) });
    await this.#terminal;
  }

  throwIfAborted(): void {
    if (this.signal.aborted) {
      throw abortReason(this.signal);
    }
  }

  throwIfAbortedOrExpired(): void {
    this.throwIfAborted();
    if (Date.now() < this.deadline) {
      return;
    }

    const error = new RequestTimeoutError(this.#timeoutMs);
    this.#finish(
      {
        id: this.#request.id,
        type: "error",
        message: error.message,
      },
      error
    );
    throw error;
  }

  async dispose(): Promise<void> {
    clearTimeout(this.#timeout);
    this.#detachDisconnect();
    await this.#terminal;
  }

  #disconnect(): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    clearTimeout(this.#timeout);
    this.#controller.abort(new RequestDisconnectedError());
  }

  #finish(message: Response, abortError?: Error): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    clearTimeout(this.#timeout);
    if (abortError) {
      this.#controller.abort(abortError);
    }
    this.#terminal = this.#messages
      .then(async () => {
        if (this.#transport.isOpen()) {
          await this.#transport.send(message);
        }
      })
      .catch(() => undefined);
  }
}

export async function executeRequest(
  request: ExecuteRequest,
  timeoutMs: number,
  transport: ExecuteRequestTransport,
  dependencies: ExecuteRequestDependencies
): Promise<void> {
  const session = new RequestSession(request, timeoutMs, transport);

  try {
    await dependencies.withBrowserLock(
      request.browser,
      async () => {
        session.throwIfAbortedOrExpired();
        await dependencies.prepareBrowser(request, {
          deadline: session.deadline,
          signal: session.signal,
        });
        session.throwIfAbortedOrExpired();
        await dependencies.runScript(
          request,
          {
            onStdout: (data) => session.stream("stdout", data),
            onStderr: (data) => session.stream("stderr", data),
          },
          {
            deadline: session.deadline,
            signal: session.signal,
          }
        );
        session.throwIfAbortedOrExpired();
      },
      { signal: session.signal }
    );

    session.throwIfAbortedOrExpired();
    await session.complete();
  } catch (error) {
    try {
      session.throwIfAbortedOrExpired();
    } catch {
      // A timeout or disconnect already owns the terminal outcome.
    }
    await session.fail(error);
  } finally {
    await session.dispose();
  }
}
