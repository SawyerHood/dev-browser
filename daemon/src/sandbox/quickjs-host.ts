import {
  getQuickJS,
  type ContextEvalOptions,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

export type QuickJSConsoleLevel = "log" | "warn" | "error" | "info";

export type QuickJSHostValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | bigint
  | QuickJSHostValue[]
  | { [key: string]: QuickJSHostValue };

export interface QuickJSHostOptions {
  memoryLimitBytes?: number;
  maxStackSizeBytes?: number;
  cpuTimeoutMs?: number;
  globals?: Record<string, QuickJSHostValue>;
  hostFunctions?: Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;
  onHostCall?: (name: string, args: unknown[]) => unknown | Promise<unknown>;
  onDrain?: () => void | Promise<void>;
  onTransportSend?: (message: string) => void | Promise<void>;
  onConsole?: (level: QuickJSConsoleLevel, args: unknown[]) => void;
}

export interface QuickJSExecutionOptions {
  filename?: string;
  type?: ContextEvalOptions["type"];
}

interface TimerRecord {
  callback: QuickJSHandle;
  args: QuickJSHandle[];
  timeout: NodeJS.Timeout;
}

export class QuickJSHost {
  static async create(options: QuickJSHostOptions = {}): Promise<QuickJSHost> {
    const quickjs = await getQuickJS();
    return new QuickJSHost(quickjs, options);
  }

  readonly #quickjs: QuickJSWASMModule;
  readonly #runtime: QuickJSRuntime;
  readonly #context: QuickJSContext;
  readonly #options: QuickJSHostOptions;
  readonly #timers = new Map<number, TimerRecord>();
  readonly #pendingDeferreds = new Set<QuickJSDeferredPromise>();

  #disposed = false;
  #interruptDeadline: number | undefined;
  #nextTimerId = 1;

  private constructor(quickjs: QuickJSWASMModule, options: QuickJSHostOptions) {
    this.#quickjs = quickjs;
    this.#options = options;
    this.#runtime = quickjs.newRuntime();

    if (options.memoryLimitBytes !== undefined) {
      this.#runtime.setMemoryLimit(options.memoryLimitBytes);
    }
    if (options.maxStackSizeBytes !== undefined) {
      this.#runtime.setMaxStackSize(options.maxStackSizeBytes);
    }
    if (options.cpuTimeoutMs !== undefined) {
      this.#runtime.setInterruptHandler(() => {
        return this.#interruptDeadline !== undefined && Date.now() > this.#interruptDeadline;
      });
    }

    this.#context = this.#runtime.newContext();
    this.#installConsole();
    this.#installTimers();
    this.#installHostCall();
    this.#installTransportSend();

    for (const [name, value] of Object.entries(options.globals ?? {})) {
      this.setGlobal(name, value);
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  setGlobal(name: string, value: QuickJSHostValue): void {
    this.#assertAlive();

    const valueHandle = this.#toHandle(value);
    try {
      this.#context.setProp(this.#context.global, name, valueHandle);
    } finally {
      valueHandle.dispose();
    }
  }

  executeScriptSync(code: string, options: QuickJSExecutionOptions = {}): unknown {
    const resultHandle = this.#evalCode(code, options);
    try {
      const promiseState = this.#context.getPromiseState(resultHandle);
      if (!(promiseState.type === "fulfilled" && promiseState.notAPromise)) {
        throw new Error("QuickJS script returned a promise; use executeScript() instead");
      }
      return this.#dumpHandle(resultHandle);
    } finally {
      resultHandle.dispose();
    }
  }

  async executeScript(code: string, options: QuickJSExecutionOptions = {}): Promise<unknown> {
    const resultHandle = this.#evalCode(code, options);
    return this.#consumeHandle(resultHandle);
  }

  async callFunction(name: string, ...args: QuickJSHostValue[]): Promise<unknown> {
    this.#assertAlive();

    const functionHandle = this.#context.getProp(this.#context.global, name);
    const argHandles = args.map((value) => this.#toHandle(value));

    try {
      if (this.#context.typeof(functionHandle) !== "function") {
        throw new Error(`QuickJS global "${name}" is not a function`);
      }

      const result = this.#runWithCpuLimit(() =>
        this.#context.callFunction(functionHandle, this.#context.global, ...argHandles),
      );
      const resultHandle = this.#unwrapResult(result, `QuickJS function "${name}" failed`);
      return await this.#consumeHandle(resultHandle);
    } finally {
      for (const argHandle of argHandles) {
        argHandle.dispose();
      }
      functionHandle.dispose();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    for (const timerId of [...this.#timers.keys()]) {
      this.#clearTimer(timerId);
    }

    for (const deferred of [...this.#pendingDeferreds]) {
      deferred.dispose();
      this.#pendingDeferreds.delete(deferred);
    }

    this.#context.dispose();
    this.#runtime.dispose();
  }

  #installConsole(): void {
    const consoleObject = this.#context.newObject();

    try {
      for (const level of ["log", "warn", "error", "info"] as const) {
        const fn = this.#context.newFunction(level, (...args) => {
          const nativeArgs = args.map((arg) => this.#context.dump(arg));
          this.#options.onConsole?.(level, nativeArgs);
        });
        this.#context.setProp(consoleObject, level, fn);
        fn.dispose();
      }

      this.#context.setProp(this.#context.global, "console", consoleObject);
    } finally {
      consoleObject.dispose();
    }
  }

  #installHostCall(): void {
    const hostCall = this.#context.newFunction("__hostCall", (nameHandle, argsJsonHandle) => {
      const name = this.#context.getString(nameHandle);
      const argsJson = this.#context.getString(argsJsonHandle);
      const args = this.#parseArgs(name, argsJson);

      const invoke = () => {
        if (this.#options.onHostCall) {
          return this.#options.onHostCall(name, args);
        }
        const handler = this.#options.hostFunctions?.[name];
        if (!handler) {
          throw new Error(`No host function registered for "${name}"`);
        }
        return handler(...args);
      };

      return this.#bridgeHostResult(invoke);
    });

    this.#context.setProp(this.#context.global, "__hostCall", hostCall);
    hostCall.dispose();
  }

  #installTransportSend(): void {
    const transportSend = this.#context.newFunction("__transport_send", (messageHandle) => {
      const message = this.#context.getString(messageHandle);
      return this.#bridgeHostResult(() => this.#options.onTransportSend?.(message));
    });

    this.#context.setProp(this.#context.global, "__transport_send", transportSend);
    transportSend.dispose();
  }

  #installTimers(): void {
    const setTimeoutHandle = this.#context.newFunction(
      "setTimeout",
      (callbackHandle, delayHandle, ...argHandles) => {
        if (this.#context.typeof(callbackHandle) !== "function") {
          throw new TypeError("setTimeout callback must be a function");
        }

        const timerId = this.#nextTimerId++;
        const delay = Math.max(0, this.#context.getNumber(delayHandle));
        const callback = callbackHandle.dup();
        const args = argHandles.map((arg) => arg.dup());

        const timeout = globalThis.setTimeout(() => {
          if (this.#disposed) {
            this.#clearTimer(timerId);
            return;
          }

          const record = this.#timers.get(timerId);
          if (!record) {
            return;
          }

          try {
            const result = this.#runWithCpuLimit(() =>
              this.#context.callFunction(record.callback, this.#context.undefined, ...record.args),
            );

            if (result.error) {
              this.#emitConsoleError(this.#context.dump(result.error));
              result.error.dispose();
            } else {
              result.value.dispose();
            }

            this.#tryDrainPendingJobs();
          } finally {
            this.#clearTimer(timerId);
          }
        }, delay);

        this.#timers.set(timerId, { callback, args, timeout });
        return this.#context.newNumber(timerId);
      },
    );

    const clearTimeoutHandle = this.#context.newFunction("clearTimeout", (timerIdHandle) => {
      this.#clearTimer(this.#context.getNumber(timerIdHandle));
    });

    this.#context.setProp(this.#context.global, "setTimeout", setTimeoutHandle);
    this.#context.setProp(this.#context.global, "clearTimeout", clearTimeoutHandle);
    setTimeoutHandle.dispose();
    clearTimeoutHandle.dispose();
  }

  #clearTimer(timerId: number): void {
    const record = this.#timers.get(timerId);
    if (!record) {
      return;
    }

    globalThis.clearTimeout(record.timeout);
    record.callback.dispose();
    for (const arg of record.args) {
      arg.dispose();
    }
    this.#timers.delete(timerId);
  }

  #bridgeHostResult(invoker: () => unknown | Promise<unknown>): QuickJSHandle | void {
    try {
      const result = invoker();
      if (this.#isPromiseLike(result)) {
        return this.#createDeferredPromise(result);
      }

      if (result === undefined) {
        return;
      }

      return this.#toHandle(result as QuickJSHostValue);
    } catch (error) {
      throw this.#normalizeHostError(error);
    }
  }

  #createDeferredPromise(promise: Promise<unknown>): QuickJSHandle {
    const deferred = this.#context.newPromise();
    this.#pendingDeferreds.add(deferred);

    promise
      .then((value) => {
        if (this.#disposed || !deferred.alive) {
          return;
        }

        const valueHandle = value === undefined ? undefined : this.#toHandle(value as QuickJSHostValue);
        try {
          deferred.resolve(valueHandle);
        } finally {
          valueHandle?.dispose();
        }
      })
      .catch((error) => {
        if (this.#disposed || !deferred.alive) {
          return;
        }

        const errorHandle = this.#newGuestErrorHandle(error);
        try {
          deferred.reject(errorHandle);
        } finally {
          errorHandle.dispose();
        }
      })
      .finally(() => {
        this.#pendingDeferreds.delete(deferred);
        this.#tryDrainPendingJobs();
      });

    return deferred.handle;
  }

  #evalCode(code: string, options: QuickJSExecutionOptions): QuickJSHandle {
    this.#assertAlive();

    const result = this.#runWithCpuLimit(() =>
      this.#context.evalCode(code, options.filename ?? "sandbox.js", {
        type: options.type,
      }),
    );

    return this.#unwrapResult(result, "QuickJS evaluation failed");
  }

  async #consumeHandle(handle: QuickJSHandle): Promise<unknown> {
    try {
      const promiseState = this.#context.getPromiseState(handle);

      if (promiseState.type === "fulfilled" && promiseState.notAPromise) {
        return this.#dumpHandle(handle);
      }

      if (promiseState.type === "fulfilled") {
        try {
          return this.#dumpHandle(promiseState.value);
        } finally {
          promiseState.value.dispose();
        }
      }

      if (promiseState.type === "pending") {
        const resolved = await this.#awaitQuickJSPromise(handle);
        try {
          return this.#dumpHandle(resolved);
        } finally {
          resolved.dispose();
        }
      }

      if (promiseState.type === "rejected") {
        try {
          throw this.#toError("QuickJS promise rejected", promiseState.error);
        } finally {
          promiseState.error.dispose();
        }
      }

      const resolved = await this.#awaitQuickJSPromise(handle);
      try {
        return this.#dumpHandle(resolved);
      } finally {
        resolved.dispose();
      }
    } finally {
      handle.dispose();
    }
  }

  async #awaitQuickJSPromise(promiseHandle: QuickJSHandle): Promise<QuickJSHandle> {
    let settled = false;
    const nativePromise = this.#context.resolvePromise(promiseHandle).finally(() => {
      settled = true;
    });

    while (!settled) {
      this.#drainPendingJobs();
      if (settled) {
        break;
      }
      await this.#options.onDrain?.();
      this.#drainPendingJobs();
      if (settled) {
        break;
      }
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });
    }

    this.#drainPendingJobs();
    return this.#unwrapResult(await nativePromise, "QuickJS promise rejected");
  }

  #drainPendingJobs(): void {
    this.#assertAlive();

    while (true) {
      const jobResult = this.#runWithCpuLimit(() => this.#runtime.executePendingJobs());
      if (jobResult.error) {
        const error = this.#toError("QuickJS pending job failed", jobResult.error);
        jobResult.error.dispose();
        throw error;
      }
      if (jobResult.value === 0) {
        return;
      }
    }
  }

  #tryDrainPendingJobs(): void {
    if (this.#disposed) {
      return;
    }

    try {
      this.#drainPendingJobs();
    } catch (error) {
      this.#emitConsoleError(this.#normalizeHostError(error));
    }
  }

  #unwrapResult<T extends QuickJSHandle>(
    result: { value?: T; error?: QuickJSHandle },
    prefix: string,
  ): T {
    if (result.error) {
      const error = this.#toError(prefix, result.error);
      result.error.dispose();
      throw error;
    }

    return result.value as T;
  }

  #toHandle(value: QuickJSHostValue): QuickJSHandle {
    if (value === undefined) {
      return this.#context.undefined.dup();
    }
    if (value === null) {
      return this.#context.null.dup();
    }
    if (value === true) {
      return this.#context.true.dup();
    }
    if (value === false) {
      return this.#context.false.dup();
    }

    switch (typeof value) {
      case "number":
        return this.#context.newNumber(value);
      case "string":
        return this.#context.newString(value);
      case "bigint":
        return this.#context.newBigInt(value);
      case "object": {
        if (Array.isArray(value)) {
          const arrayHandle = this.#context.newArray();
          try {
            value.forEach((item, index) => {
              const itemHandle = this.#toHandle(item);
              try {
                this.#context.setProp(arrayHandle, index, itemHandle);
              } finally {
                itemHandle.dispose();
              }
            });
            return arrayHandle;
          } catch (error) {
            arrayHandle.dispose();
            throw error;
          }
        }

        const objectHandle = this.#context.newObject();
        try {
          for (const [key, item] of Object.entries(value)) {
            const itemHandle = this.#toHandle(item);
            try {
              this.#context.setProp(objectHandle, key, itemHandle);
            } finally {
              itemHandle.dispose();
            }
          }
          return objectHandle;
        } catch (error) {
          objectHandle.dispose();
          throw error;
        }
      }
      default:
        throw new TypeError(`Unsupported host value type: ${typeof value}`);
    }
  }

  #dumpHandle(handle: QuickJSHandle): unknown {
    return this.#context.dump(handle);
  }

  #parseArgs(name: string, argsJson: string): unknown[] {
    try {
      const parsed = JSON.parse(argsJson) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("Expected a JSON array");
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid JSON arguments for host call "${name}": ${this.#normalizeHostError(error).message}`);
    }
  }

  #newGuestErrorHandle(error: unknown): QuickJSHandle {
    const normalized = this.#normalizeHostError(error);
    const errorHandle = this.#context.newError({
      name: normalized.name || "Error",
      message: normalized.message,
    });

    if (normalized.stack) {
      const stackHandle = this.#context.newString(normalized.stack);
      try {
        this.#context.setProp(errorHandle, "stack", stackHandle);
      } finally {
        stackHandle.dispose();
      }
    }

    return errorHandle;
  }

  #toError(prefix: string, errorHandle: QuickJSHandle): Error {
    const dumped = this.#context.dump(errorHandle);
    const normalized = this.#normalizeHostError(dumped);
    normalized.message = `${prefix}: ${normalized.message}`;
    return normalized;
  }

  #emitConsoleError(error: unknown): void {
    const normalized = this.#normalizeHostError(error);
    this.#options.onConsole?.("error", [
      {
        name: normalized.name,
        message: normalized.message,
        stack: normalized.stack,
      },
    ]);
  }

  #normalizeHostError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    if (typeof error === "object" && error !== null) {
      const name = "name" in error && typeof error.name === "string" ? error.name : "Error";
      const message =
        "message" in error && typeof error.message === "string"
          ? error.message
          : JSON.stringify(error);
      const normalized = new Error(message);
      normalized.name = name;
      if ("stack" in error && typeof error.stack === "string") {
        normalized.stack = error.stack;
      }
      return normalized;
    }

    return new Error(String(error));
  }

  #runWithCpuLimit<T>(callback: () => T): T {
    if (this.#options.cpuTimeoutMs === undefined) {
      return callback();
    }

    const previousDeadline = this.#interruptDeadline;
    this.#interruptDeadline = Date.now() + this.#options.cpuTimeoutMs;

    try {
      return callback();
    } finally {
      this.#interruptDeadline = previousDeadline;
    }
  }

  #assertAlive(): void {
    if (this.#disposed) {
      throw new Error("QuickJSHost has been disposed");
    }
  }

  #isPromiseLike(value: unknown): value is Promise<unknown> {
    return typeof value === "object" && value !== null && "then" in value;
  }
}
