import { EventEmitter } from "node:events";

type CdpParams = Record<string, unknown>;
type CdpResult = Record<string, unknown>;

interface CdpRequest {
  id: number;
  method: string;
  params?: CdpParams;
  sessionId?: string;
}

interface CdpResponse {
  id?: number;
  result?: CdpResult;
  error?: {
    code?: number;
    message?: string;
    data?: string;
  };
  method?: string;
  params?: CdpParams;
  sessionId?: string;
}

interface CdpEvent {
  method: string;
  params: CdpParams;
  sessionId?: string;
}

interface PendingCdpCommand {
  resolve: (value: CdpResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url?: string;
  title?: string;
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

interface RuntimeEvaluationResult extends CdpResult {
  result?: RemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: RemoteObject;
  };
}

interface Point {
  x: number;
  y: number;
}

interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const LIVE_CDP_BROWSER_INIT_TIMEOUT_MS = 5_000;
const LIVE_CDP_TARGET_INIT_TIMEOUT_MS = 5_000;

export interface LiveCdpTransport {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: (reason?: string) => void): () => void;
}

export type LiveCdpTransportFactory = (endpoint: string) => Promise<LiveCdpTransport>;

export interface LiveCdpBrowserOptions {
  transportFactory?: LiveCdpTransportFactory;
}

export interface LiveCdpLocatorDescriptor {
  selector: string;
  index?: number | null;
  hasText?: string | null;
}

export type SerializedEvaluation =
  | {
      kind: "expression";
      source: string;
    }
  | {
      kind: "function";
      source: string;
      hasArg?: boolean;
      arg?: unknown;
      args?: unknown[];
    };

interface WebSocketLike {
  readonly readyState: number;
  send(message: string): void;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: { once?: boolean }
  ): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

class WebSocketLiveCdpTransport implements LiveCdpTransport {
  static async connect(endpoint: string): Promise<WebSocketLiveCdpTransport> {
    const WebSocketConstructor = (
      globalThis as typeof globalThis & {
        WebSocket?: new (url: string) => WebSocketLike;
      }
    ).WebSocket;

    if (!WebSocketConstructor) {
      throw new Error("This Node.js runtime does not expose a global WebSocket implementation");
    }

    const socket = new WebSocketConstructor(endpoint);

    return await new Promise<WebSocketLiveCdpTransport>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        rejectWith(new Error(`Timed out connecting to CDP endpoint ${endpoint}`));
      }, 5_000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
      };
      const rejectWith = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          // Best effort while rejecting the failed connection attempt.
        }
        reject(error);
      };
      const handleOpen = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(new WebSocketLiveCdpTransport(socket));
      };
      const handleError = (event: unknown) => {
        rejectWith(new Error(`Failed to connect to CDP endpoint ${endpoint}: ${String(event)}`));
      };
      const handleClose = () => {
        rejectWith(new Error(`CDP endpoint closed before connection opened: ${endpoint}`));
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose, { once: true });
    });
  }

  private readonly messageListeners = new Set<(message: string) => void>();
  private readonly closeListeners = new Set<(reason?: string) => void>();

  private constructor(private readonly socket: WebSocketLike) {
    this.socket.addEventListener("message", (event) => {
      const data = (event as { data?: unknown }).data;
      if (typeof data === "string") {
        this.emitMessage(data);
        return;
      }

      if (data instanceof ArrayBuffer) {
        this.emitMessage(Buffer.from(data).toString("utf8"));
        return;
      }

      if (ArrayBuffer.isView(data)) {
        this.emitMessage(
          Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
        );
      }
    });
    this.socket.addEventListener("close", (event) => {
      const reason = (event as { reason?: unknown }).reason;
      this.emitClose(typeof reason === "string" && reason.length > 0 ? reason : undefined);
    });
  }

  send(message: string): void {
    this.socket.send(message);
  }

  close(): void {
    this.socket.close();
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  private emitMessage(message: string): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private emitClose(reason?: string): void {
    for (const listener of this.closeListeners) {
      listener(reason);
    }
  }
}

class CdpConnection {
  static async connect(
    endpoint: string,
    transportFactory: LiveCdpTransportFactory = (url) => WebSocketLiveCdpTransport.connect(url)
  ): Promise<CdpConnection> {
    return new CdpConnection(await transportFactory(endpoint));
  }

  private readonly pending = new Map<number, PendingCdpCommand>();
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly transport: LiveCdpTransport) {
    this.transport.onMessage((message) => {
      this.handleMessage(message);
    });
    this.transport.onClose((reason) => {
      this.markClosed(reason);
    });
  }

  isConnected(): boolean {
    return !this.closed;
  }

  send(
    method: string,
    params: CdpParams = {},
    sessionId?: string,
    timeoutMs = 30_000
  ): Promise<CdpResult> {
    if (this.closed) {
      return Promise.reject(new Error("CDP connection is closed"));
    }

    const id = this.nextId++;
    const request: CdpRequest = { id, method };
    if (Object.keys(params).length > 0) {
      request.params = params;
    }
    if (sessionId) {
      request.sessionId = sessionId;
    }

    const promise = new Promise<CdpResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });

    try {
      this.transport.send(JSON.stringify(request));
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending) {
        clearTimeout(pending.timeout);
      }
      throw error;
    }

    return promise;
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  close(reason?: string): void {
    if (this.closed) {
      return;
    }

    this.markClosed(reason);
    this.transport.close();
  }

  private handleMessage(message: string): void {
    let payload: CdpResponse;

    try {
      payload = JSON.parse(message) as CdpResponse;
    } catch {
      return;
    }

    if (typeof payload.id === "number") {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.id);
      clearTimeout(pending.timeout);
      if (payload.error) {
        pending.reject(
          new Error(
            payload.error.data
              ? `${payload.error.message ?? "CDP command failed"}: ${payload.error.data}`
              : (payload.error.message ?? "CDP command failed")
          )
        );
        return;
      }

      pending.resolve(payload.result ?? {});
      return;
    }

    if (typeof payload.method === "string") {
      const event: CdpEvent = {
        method: payload.method,
        params: payload.params ?? {},
        sessionId: payload.sessionId,
      };
      for (const listener of this.eventListeners) {
        listener(event);
      }
    }
  }

  private markClosed(reason?: string): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const error = new Error(reason ? `CDP connection closed: ${reason}` : "CDP connection closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class LiveCdpBrowser extends EventEmitter {
  readonly #connection: CdpConnection;
  readonly #context: LiveCdpBrowserContext;

  static async connect(
    endpoint: string,
    options: LiveCdpBrowserOptions = {}
  ): Promise<LiveCdpBrowser> {
    const connection = await CdpConnection.connect(endpoint, options.transportFactory);

    await sendLiveCdpInitCommand(
      connection,
      "Browser.getVersion",
      {},
      undefined,
      "Browser.getVersion"
    );

    const browser = new LiveCdpBrowser(connection);
    await browser.refreshPages();
    return browser;
  }

  private constructor(connection: CdpConnection) {
    super();
    this.#connection = connection;
    this.#context = new LiveCdpBrowserContext(connection);
  }

  contexts(): LiveCdpBrowserContext[] {
    return [this.#context];
  }

  async newContext(): Promise<LiveCdpBrowserContext> {
    return this.#context;
  }

  isConnected(): boolean {
    return this.#connection.isConnected();
  }

  async close(): Promise<void> {
    this.#connection.close("dev-browser detached");
    await Promise.resolve();
    this.emit("disconnected");
  }

  async refreshPages(): Promise<void> {
    await this.#context.refreshPages();
  }
}

export class LiveCdpBrowserContext {
  readonly #pagesByTargetId = new Map<string, LiveCdpPage>();
  readonly #pagesBySessionId = new Map<string, LiveCdpPage>();

  constructor(private readonly connection: CdpConnection) {
    this.connection.onEvent((event) => {
      this.handleEvent(event);
    });
  }

  pages(): LiveCdpPage[] {
    return Array.from(this.#pagesByTargetId.values()).filter((page) => !page.isClosed());
  }

  async newPage(): Promise<LiveCdpPage> {
    const result = await sendLiveCdpInitCommand(
      this.connection,
      "Target.createTarget",
      { url: "about:blank" },
      undefined,
      "Target.createTarget"
    );
    const targetId = typeof result.targetId === "string" ? result.targetId : undefined;
    if (!targetId) {
      throw new Error("Target.createTarget did not return a targetId");
    }

    return await this.attachToTarget({
      targetId,
      type: "page",
      url: "about:blank",
      title: "",
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.pages().map(async (page) => page.close()));
  }

  async refreshPages(): Promise<void> {
    const result = await sendLiveCdpInitCommand(
      this.connection,
      "Target.getTargets",
      {},
      undefined,
      "Target.getTargets"
    );
    const targetInfos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    const liveTargetIds = new Set<string>();

    for (const rawInfo of targetInfos) {
      const targetInfo = normalizeTargetInfo(rawInfo);
      if (!targetInfo || !isPageLikeTarget(targetInfo)) {
        continue;
      }

      liveTargetIds.add(targetInfo.targetId);
      const existingPage = this.#pagesByTargetId.get(targetInfo.targetId);
      if (existingPage) {
        existingPage.updateTargetInfo(targetInfo);
        continue;
      }

      await this.attachToTarget(targetInfo).catch(() => undefined);
    }

    for (const [targetId, page] of this.#pagesByTargetId.entries()) {
      if (!liveTargetIds.has(targetId)) {
        this.markPageClosed(page);
      }
    }
  }

  private async attachToTarget(targetInfo: TargetInfo): Promise<LiveCdpPage> {
    const existingPage = this.#pagesByTargetId.get(targetInfo.targetId);
    if (existingPage && !existingPage.isClosed()) {
      return existingPage;
    }

    const attachResult = await sendLiveCdpInitCommand(
      this.connection,
      "Target.attachToTarget",
      {
        targetId: targetInfo.targetId,
        flatten: true,
      },
      undefined,
      `Target.attachToTarget(${targetInfo.targetId})`,
      LIVE_CDP_TARGET_INIT_TIMEOUT_MS
    );
    const sessionId =
      typeof attachResult.sessionId === "string" ? attachResult.sessionId : undefined;
    if (!sessionId) {
      throw new Error(
        `Target.attachToTarget did not return a sessionId for ${targetInfo.targetId}`
      );
    }

    await sendLiveCdpInitCommand(
      this.connection,
      "Page.enable",
      {},
      sessionId,
      `Page.enable(${targetInfo.targetId})`,
      LIVE_CDP_TARGET_INIT_TIMEOUT_MS
    );
    await sendLiveCdpInitCommand(
      this.connection,
      "Runtime.enable",
      {},
      sessionId,
      `Runtime.enable(${targetInfo.targetId})`,
      LIVE_CDP_TARGET_INIT_TIMEOUT_MS
    );
    await sendLiveCdpInitCommand(
      this.connection,
      "Runtime.runIfWaitingForDebugger",
      {},
      sessionId,
      `Runtime.runIfWaitingForDebugger(${targetInfo.targetId})`,
      LIVE_CDP_TARGET_INIT_TIMEOUT_MS
    ).catch(() => {});
    await sendLiveCdpInitCommand(
      this.connection,
      "Network.enable",
      {},
      sessionId,
      `Network.enable(${targetInfo.targetId})`,
      LIVE_CDP_TARGET_INIT_TIMEOUT_MS
    );

    const page = new LiveCdpPage(this.connection, targetInfo, sessionId, () => {
      this.markPageClosed(page);
    });
    this.#pagesByTargetId.set(targetInfo.targetId, page);
    this.#pagesBySessionId.set(sessionId, page);
    return page;
  }

  private handleEvent(event: CdpEvent): void {
    if (event.method === "Target.targetDestroyed") {
      const targetId =
        typeof event.params.targetId === "string" ? event.params.targetId : undefined;
      const page = targetId ? this.#pagesByTargetId.get(targetId) : undefined;
      if (page) {
        this.markPageClosed(page);
      }
      return;
    }

    if (event.method === "Target.detachedFromTarget") {
      const sessionId =
        typeof event.params.sessionId === "string" ? event.params.sessionId : event.sessionId;
      const page = sessionId ? this.#pagesBySessionId.get(sessionId) : undefined;
      if (page) {
        this.markPageClosed(page);
      }
      return;
    }

    if (!event.sessionId) {
      return;
    }

    this.#pagesBySessionId.get(event.sessionId)?.handleSessionEvent(event);
  }

  private markPageClosed(page: LiveCdpPage): void {
    this.#pagesByTargetId.delete(page.targetId);
    this.#pagesBySessionId.delete(page.sessionId);
    page.markClosed();
  }
}

export class LiveCdpKeyboard {
  #modifiers = 0;

  constructor(private readonly page: LiveCdpPage) {}

  async type(text: string): Promise<void> {
    await this.page.sendSession("Input.insertText", { text });
  }

  async down(key: string): Promise<void> {
    const { definition, modifiers } = parseKeyChord(key);
    const keyModifier = modifierMaskForKey(definition.key);
    const activeModifiers = this.#modifiers | modifiers | keyModifier;

    await this.dispatchKeyEvent("keyDown", definition, activeModifiers);
    this.#modifiers = activeModifiers;
  }

  async up(key: string): Promise<void> {
    const { definition, modifiers } = parseKeyChord(key);
    const keyModifier = modifierMaskForKey(definition.key);
    const activeModifiers = (this.#modifiers | modifiers) & ~keyModifier;

    await this.dispatchKeyEvent("keyUp", definition, activeModifiers);
    this.#modifiers = activeModifiers;
  }

  async press(key: string): Promise<void> {
    const { definition, modifiers } = parseKeyChord(key);
    const activeModifiers = this.#modifiers | modifiers;

    await this.dispatchKeyEvent("keyDown", definition, activeModifiers);
    await this.dispatchKeyEvent("keyUp", definition, activeModifiers);
  }

  private async dispatchKeyEvent(
    type: "keyDown" | "keyUp",
    definition: KeyDefinition,
    modifiers: number
  ): Promise<void> {
    await this.page.sendSession("Input.dispatchKeyEvent", {
      type,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      text: type === "keyDown" && modifiers === 0 ? definition.text : undefined,
      unmodifiedText: definition.text,
      modifiers,
    });
  }
}

export class LiveCdpMouse {
  constructor(private readonly page: LiveCdpPage) {}

  async click(x: number, y: number): Promise<void> {
    await this.page.clickPoint({ x, y });
  }
}

export class LiveCdpPage extends EventEmitter {
  readonly keyboard = new LiveCdpKeyboard(this);
  readonly mouse = new LiveCdpMouse(this);

  #closed = false;
  #url: string;
  #title: string;

  constructor(
    private readonly connection: CdpConnection,
    targetInfo: TargetInfo,
    readonly sessionId: string,
    private readonly onClose: () => void
  ) {
    super();
    this.targetId = targetInfo.targetId;
    this.#url = targetInfo.url ?? "about:blank";
    this.#title = targetInfo.title ?? "";
  }

  readonly targetId: string;

  isClosed(): boolean {
    return this.#closed;
  }

  url(): string {
    return this.#url;
  }

  async title(): Promise<string> {
    const title = await this.evaluateSerialized({
      kind: "expression",
      source: "document.title",
    });
    return typeof title === "string" ? title : "";
  }

  async goto(
    url: string,
    options: {
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
      timeout?: number;
    } = {}
  ): Promise<null> {
    const waitUntil = options.waitUntil ?? "load";
    const timeout = options.timeout ?? 30_000;
    const waitForNavigation =
      waitUntil === "commit"
        ? Promise.resolve()
        : this.waitForSessionEvent(
            waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired",
            timeout
          );

    const result = await this.sendSession("Page.navigate", { url });
    const errorText = typeof result.errorText === "string" ? result.errorText : undefined;
    if (errorText) {
      throw new Error(`Navigation to ${url} failed: ${errorText}`);
    }

    this.#url = url;
    await waitForNavigation;

    if (waitUntil === "networkidle") {
      await this.waitForTimeout(500);
    }

    return null;
  }

  async reload(
    options: {
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
      timeout?: number;
    } = {}
  ): Promise<null> {
    const waitUntil = options.waitUntil ?? "load";
    const timeout = options.timeout ?? 30_000;
    const waitForNavigation =
      waitUntil === "commit"
        ? Promise.resolve()
        : this.waitForSessionEvent(
            waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired",
            timeout
          );

    await this.sendSession("Page.reload", {});
    await waitForNavigation;

    if (waitUntil === "networkidle") {
      await this.waitForTimeout(500);
    }

    return null;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    await this.connection
      .send("Target.closeTarget", { targetId: this.targetId })
      .catch(() => undefined);
    this.onClose();
  }

  async evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R),
    ...args: unknown[]
  ): Promise<R> {
    if (typeof pageFunction === "string") {
      return (await this.evaluateSerialized({
        kind: "expression",
        source: pageFunction,
      })) as R;
    }

    return (await this.evaluateSerialized({
      kind: "function",
      source: pageFunction.toString(),
      hasArg: args.length > 0,
      arg: args[0],
      args,
    })) as R;
  }

  async evaluateSerialized(payload: SerializedEvaluation): Promise<unknown> {
    if (payload.kind === "expression") {
      const result = (await this.sendSession("Runtime.evaluate", {
        expression: payload.source,
        awaitPromise: true,
        returnByValue: true,
      })) as RuntimeEvaluationResult;
      return readRuntimeResult(result);
    }

    const args = payload.args ?? (payload.hasArg ? [payload.arg] : []);
    const result = (await this.sendSession("Runtime.callFunctionOn", {
      functionDeclaration: `function(...args) {
        const fn = (${payload.source});
        return fn(...args);
      }`,
      arguments: args.map((value) => ({
        value,
      })),
      awaitPromise: true,
      returnByValue: true,
    })) as RuntimeEvaluationResult;
    return readRuntimeResult(result);
  }

  async waitForTimeout(timeout: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, timeout));
    });
  }

  async click(selector: string, options: { timeout?: number } = {}): Promise<void> {
    await this.locator(selector).click(options);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.locator(selector).fill(value);
  }

  async type(selector: string, text: string): Promise<void> {
    await this.locator(selector).fill("");
    await this.locator(selector).click();
    await this.keyboard.type(text);
  }

  async press(selector: string, key: string): Promise<void> {
    await this.locator(selector).click();
    await this.keyboard.press(key);
  }

  async check(selector: string): Promise<void> {
    await this.locator(selector).setChecked(true);
  }

  async uncheck(selector: string): Promise<void> {
    await this.locator(selector).setChecked(false);
  }

  async selectOption(selector: string, value: string | string[]): Promise<string[]> {
    return await this.locator(selector).selectOption(value);
  }

  async textContent(selector: string): Promise<string | null> {
    return await this.locator(selector).textContent();
  }

  async innerText(selector: string): Promise<string> {
    return await this.locator(selector).innerText();
  }

  async innerHTML(selector: string): Promise<string> {
    return await this.locator(selector).innerHTML();
  }

  async getAttribute(selector: string, name: string): Promise<string | null> {
    return await this.locator(selector).getAttribute(name);
  }

  async inputValue(selector: string): Promise<string> {
    return await this.locator(selector).inputValue();
  }

  async isChecked(selector: string): Promise<boolean> {
    return await this.locator(selector).isChecked();
  }

  async isVisible(selector: string): Promise<boolean> {
    return await this.locator(selector).isVisible();
  }

  async isHidden(selector: string): Promise<boolean> {
    return !(await this.isVisible(selector));
  }

  async isEnabled(selector: string): Promise<boolean> {
    return await this.locator(selector).isEnabled();
  }

  async waitForSelector(
    selector: string,
    options: { state?: "attached" | "detached" | "hidden" | "visible"; timeout?: number } = {}
  ): Promise<null> {
    const state = options.state ?? "visible";
    const deadline = Date.now() + (options.timeout ?? 30_000);

    while (Date.now() <= deadline) {
      const locator = this.locator(selector);
      const count = await locator.count();
      const visible = count > 0 ? await locator.isVisible().catch(() => false) : false;

      if (
        (state === "attached" && count > 0) ||
        (state === "detached" && count === 0) ||
        (state === "visible" && visible) ||
        (state === "hidden" && !visible)
      ) {
        return null;
      }

      await this.waitForTimeout(100);
    }

    throw new Error(`Timed out waiting for selector "${selector}" to become ${state}`);
  }

  async waitForFunction(
    pageFunction: string | ((arg?: unknown) => unknown),
    arg?: unknown,
    options: { timeout?: number } = {}
  ): Promise<unknown> {
    const deadline = Date.now() + (options.timeout ?? 30_000);
    while (Date.now() <= deadline) {
      const value =
        typeof pageFunction === "string"
          ? await this.evaluate(pageFunction)
          : await this.evaluate(pageFunction, arg);
      if (value) {
        return value;
      }
      await this.waitForTimeout(100);
    }

    throw new Error("Timed out waiting for function");
  }

  locator(selectorOrDescriptor: string | LiveCdpLocatorDescriptor): LiveCdpLocator {
    const descriptor =
      typeof selectorOrDescriptor === "string"
        ? { selector: selectorOrDescriptor, index: null, hasText: null }
        : selectorOrDescriptor;
    return new LiveCdpLocator(this, descriptor);
  }

  async content(): Promise<string> {
    const content = await this.evaluateSerialized({
      kind: "expression",
      source: "document.documentElement.outerHTML",
    });
    return typeof content === "string" ? content : "";
  }

  async setContent(html: string): Promise<void> {
    await this.evaluateSerialized({
      kind: "function",
      source: `(html) => {
        document.open();
        document.write(html);
        document.close();
      }`,
      hasArg: true,
      arg: html,
    });
  }

  async setInputFiles(selector: string, files: string | string[]): Promise<void> {
    const fileList = Array.isArray(files) ? files : [files];
    await this.sendSession("DOM.enable", {}).catch(() => {});
    const documentResult = await this.sendSession("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const root = documentResult.root as { nodeId?: unknown } | undefined;
    const nodeId = typeof root?.nodeId === "number" ? root.nodeId : undefined;
    if (nodeId === undefined) {
      throw new Error("DOM.getDocument did not return a root node");
    }

    const queryResult = await this.sendSession("DOM.querySelector", {
      nodeId,
      selector,
    });
    const inputNodeId = typeof queryResult.nodeId === "number" ? queryResult.nodeId : undefined;
    if (!inputNodeId) {
      throw new Error(`No file input found for selector "${selector}"`);
    }

    await this.sendSession("DOM.setFileInputFiles", {
      nodeId: inputNodeId,
      files: fileList,
    });
  }

  sendSession(method: string, params: CdpParams = {}): Promise<CdpResult> {
    if (this.#closed) {
      return Promise.reject(new Error(`Page target ${this.targetId} is closed`));
    }

    return this.connection.send(method, params, this.sessionId);
  }

  async clickPoint(point: Point): Promise<void> {
    await this.sendSession("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.sendSession("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }

  async locatorCount(descriptor: LiveCdpLocatorDescriptor): Promise<number> {
    const count = await this.evaluate((input) => {
      const { selector, hasText } = input as { selector: string; hasText?: string | null };
      const elements = Array.from(document.querySelectorAll(selector));
      return hasText === null || hasText === undefined
        ? elements.length
        : elements.filter((element) => (element.textContent ?? "").includes(hasText)).length;
    }, normalizeLocatorDescriptor(descriptor));
    return typeof count === "number" ? count : 0;
  }

  async locatorAction<T>(
    descriptor: LiveCdpLocatorDescriptor,
    action: (element: Element, args: unknown[]) => T,
    args: unknown[] = []
  ): Promise<T> {
    return (await this.evaluate(
      (input) => {
        const {
          descriptor,
          actionSource,
          args: actionArgs,
        } = input as {
          descriptor: LiveCdpLocatorDescriptor;
          actionSource: string;
          args: unknown[];
        };
        const normalized = descriptor;
        const elements = Array.from(document.querySelectorAll(normalized.selector));
        const filtered =
          normalized.hasText === null || normalized.hasText === undefined
            ? elements
            : elements.filter((element) =>
                (element.textContent ?? "").includes(normalized.hasText ?? "")
              );
        const rawIndex =
          normalized.index === null || normalized.index === undefined ? 0 : normalized.index;
        const index = rawIndex < 0 ? filtered.length + rawIndex : rawIndex;
        const element = filtered[index];

        if (!element) {
          throw new Error(`No element found for selector "${normalized.selector}"`);
        }

        const run = (0, eval)(`(${actionSource})`) as (element: Element, args: unknown[]) => T;
        return run(element, actionArgs);
      },
      {
        descriptor: normalizeLocatorDescriptor(descriptor),
        actionSource: action.toString(),
        args,
      }
    )) as T;
  }

  handleSessionEvent(event: CdpEvent): void {
    if (event.method === "Page.frameNavigated") {
      const frame =
        typeof event.params.frame === "object" && event.params.frame !== null
          ? (event.params.frame as { parentId?: unknown; url?: unknown })
          : undefined;
      if (frame && frame.parentId === undefined && typeof frame.url === "string") {
        this.#url = frame.url;
      }
    }

    this.emit(`cdp:${event.method}`, event.params);
  }

  updateTargetInfo(targetInfo: TargetInfo): void {
    this.#url = targetInfo.url ?? this.#url;
    this.#title = targetInfo.title ?? this.#title;
  }

  markClosed(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.emit("close");
  }

  private waitForSessionEvent(method: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const handleEvent = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.off(`cdp:${method}`, handleEvent);
      };

      this.on(`cdp:${method}`, handleEvent);
    });
  }
}

export class LiveCdpLocator {
  constructor(
    private readonly page: LiveCdpPage,
    private readonly descriptor: LiveCdpLocatorDescriptor
  ) {}

  async click(options: { timeout?: number } = {}): Promise<void> {
    await this.waitFor({ state: "visible", timeout: options.timeout });
    const point = await this.page.locatorAction<Point>(this.descriptor, (element) => {
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
    await this.page.clickPoint(point);
  }

  async waitFor(
    options: { state?: "attached" | "detached" | "hidden" | "visible"; timeout?: number } = {}
  ): Promise<void> {
    const state = options.state ?? "visible";
    const deadline = Date.now() + (options.timeout ?? 30_000);

    while (Date.now() <= deadline) {
      const count = await this.count();
      const visible = count > 0 ? await this.isVisible().catch(() => false) : false;

      if (
        (state === "attached" && count > 0) ||
        (state === "detached" && count === 0) ||
        (state === "visible" && visible) ||
        (state === "hidden" && !visible)
      ) {
        return;
      }

      await this.page.waitForTimeout(100);
    }

    throw new Error(`Timed out waiting for locator "${this.descriptor.selector}" to become ${state}`);
  }

  async pressSequentially(
    text: string,
    options: { delay?: number; timeout?: number } = {}
  ): Promise<void> {
    await this.waitFor({ state: "visible", timeout: options.timeout });
    await this.click();

    if (!options.delay) {
      await this.page.keyboard.type(text);
      return;
    }

    for (const char of text) {
      await this.page.keyboard.type(char);
      await this.page.waitForTimeout(options.delay);
    }
  }

  async fill(value: string): Promise<void> {
    await this.page.locatorAction<void>(
      this.descriptor,
      (element, [nextValue]) => {
        const htmlElement = element as HTMLElement & {
          value?: string;
          checked?: boolean;
          isContentEditable?: boolean;
        };
        htmlElement.focus();
        if ("value" in htmlElement) {
          htmlElement.value = String(nextValue);
        } else if (htmlElement.isContentEditable) {
          htmlElement.textContent = String(nextValue);
        } else {
          throw new Error("Element cannot be filled");
        }
        htmlElement.dispatchEvent(new Event("input", { bubbles: true }));
        htmlElement.dispatchEvent(new Event("change", { bubbles: true }));
      },
      [value]
    );
  }

  async textContent(): Promise<string | null> {
    return await this.page.locatorAction<string | null>(
      this.descriptor,
      (element) => element.textContent
    );
  }

  async innerText(): Promise<string> {
    return await this.page.locatorAction<string>(
      this.descriptor,
      (element) => (element as HTMLElement).innerText ?? element.textContent ?? ""
    );
  }

  async innerHTML(): Promise<string> {
    return await this.page.locatorAction<string>(this.descriptor, (element) => element.innerHTML);
  }

  async getAttribute(name: string): Promise<string | null> {
    return await this.page.locatorAction<string | null>(
      this.descriptor,
      (element, [attributeName]) => element.getAttribute(String(attributeName)),
      [name]
    );
  }

  async inputValue(): Promise<string> {
    return await this.page.locatorAction<string>(
      this.descriptor,
      (element) =>
        (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? ""
    );
  }

  async isChecked(): Promise<boolean> {
    return await this.page.locatorAction<boolean>(this.descriptor, (element) =>
      Boolean((element as HTMLInputElement).checked)
    );
  }

  async isVisible(): Promise<boolean> {
    return await this.page.locatorAction<boolean>(this.descriptor, (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
  }

  async isEnabled(): Promise<boolean> {
    return await this.page.locatorAction<boolean>(
      this.descriptor,
      (element) => !(element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled
    );
  }

  async setChecked(checked: boolean): Promise<void> {
    await this.page.locatorAction<void>(
      this.descriptor,
      (element, [nextChecked]) => {
        const input = element as HTMLInputElement;
        if (input.checked !== Boolean(nextChecked)) {
          input.checked = Boolean(nextChecked);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      [checked]
    );
  }

  async selectOption(value: string | string[]): Promise<string[]> {
    return await this.page.locatorAction<string[]>(
      this.descriptor,
      (element, [nextValue]) => {
        const select = element as HTMLSelectElement;
        const values = Array.isArray(nextValue) ? nextValue.map(String) : [String(nextValue)];
        for (const option of Array.from(select.options)) {
          option.selected = values.includes(option.value);
        }
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return Array.from(select.selectedOptions).map((option) => option.value);
      },
      [value]
    );
  }

  async count(): Promise<number> {
    return await this.page.locatorCount(this.descriptor);
  }

  locator(selector: string): LiveCdpLocator {
    return new LiveCdpLocator(this.page, {
      selector: `${this.descriptor.selector} ${selector}`,
      index: null,
      hasText: this.descriptor.hasText ?? null,
    });
  }

  first(): LiveCdpLocator {
    return this.nth(0);
  }

  last(): LiveCdpLocator {
    return this.nth(-1);
  }

  nth(index: number): LiveCdpLocator {
    return new LiveCdpLocator(this.page, {
      ...normalizeLocatorDescriptor(this.descriptor),
      index,
    });
  }

  filter(options: { hasText?: string | RegExp } = {}): LiveCdpLocator {
    return new LiveCdpLocator(this.page, {
      ...normalizeLocatorDescriptor(this.descriptor),
      hasText: options.hasText === undefined ? null : String(options.hasText),
    });
  }

  async all(): Promise<LiveCdpLocator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_, index) => this.nth(index));
  }
}

export async function createLiveCdpBrowser(
  endpoint: string,
  options: LiveCdpBrowserOptions = {}
): Promise<LiveCdpBrowser> {
  return await LiveCdpBrowser.connect(endpoint, options);
}

export function isLiveCdpBrowser(value: unknown): value is LiveCdpBrowser {
  return value instanceof LiveCdpBrowser;
}

export function isLiveCdpPage(value: unknown): value is LiveCdpPage {
  return value instanceof LiveCdpPage;
}

export function getLiveCdpPageTargetId(value: unknown): string | null {
  return value instanceof LiveCdpPage ? value.targetId : null;
}

async function sendLiveCdpInitCommand(
  connection: CdpConnection,
  method: string,
  params: CdpParams = {},
  sessionId: string | undefined,
  step: string,
  timeoutMs = LIVE_CDP_BROWSER_INIT_TIMEOUT_MS
): Promise<CdpResult> {
  try {
    return await connection.send(method, params, sessionId, timeoutMs);
  } catch (error) {
    if (isCdpCommandTimeout(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Timed out after ${timeoutMs}ms initializing live CDP browser during ${step}. ` +
          `Chrome may be waiting for remote-debugging consent or a target may be unresponsive. ` +
          `Last error: ${message}`
      );
    }

    throw error;
  }
}

function isCdpCommandTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("CDP command timed out after ");
}

function normalizeTargetInfo(value: unknown): TargetInfo | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const targetId = record.targetId;
  const type = record.type;
  if (typeof targetId !== "string" || typeof type !== "string") {
    return null;
  }

  return {
    targetId,
    type,
    url: typeof record.url === "string" ? record.url : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
  };
}

function normalizeLocatorDescriptor(
  descriptor: LiveCdpLocatorDescriptor
): LiveCdpLocatorDescriptor {
  return {
    selector: descriptor.selector,
    index: descriptor.index ?? null,
    hasText: descriptor.hasText ?? null,
  };
}

function readRuntimeResult(result: RuntimeEvaluationResult): unknown {
  if (result.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    const message =
      exception?.description ??
      exception?.value ??
      result.exceptionDetails.text ??
      "Evaluation failed";
    throw new Error(String(message));
  }

  return readRemoteObject(result.result);
}

function readRemoteObject(remoteObject: RemoteObject | undefined): unknown {
  if (!remoteObject) {
    return undefined;
  }

  if ("value" in remoteObject) {
    return remoteObject.value;
  }

  switch (remoteObject.unserializableValue) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
    default:
      break;
  }

  if (remoteObject.subtype === "null") {
    return null;
  }

  return undefined;
}

const keyDefinitions = new Map<string, KeyDefinition>([
  ["Enter", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }],
  ["Escape", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["Tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" }],
  ["Backspace", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }],
  ["Delete", { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }],
  ["Shift", { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }],
  ["Control", { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 }],
  ["Ctrl", { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 }],
  ["Alt", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 }],
  ["Option", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 }],
  ["Meta", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 }],
  ["Cmd", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 }],
  ["Command", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 }],
  ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
  ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
  ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
] as const);

function isPageLikeTarget(targetInfo: TargetInfo): boolean {
  if (targetInfo.type === "page") {
    return true;
  }

  if (targetInfo.type !== "other") {
    return false;
  }

  return /^(https?|about|chrome):/i.test(targetInfo.url ?? "");
}

function parseKeyChord(key: string): { definition: KeyDefinition; modifiers: number } {
  const parts = key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const keyName = parts.pop() ?? key;
  const modifiers = parts.reduce((mask, modifier) => {
    switch (modifier.toLowerCase()) {
      case "alt":
      case "option":
        return mask | 1;
      case "control":
      case "ctrl":
        return mask | 2;
      case "meta":
      case "cmd":
      case "command":
        return mask | 4;
      case "shift":
        return mask | 8;
      default:
        return mask;
    }
  }, 0);

  return {
    definition: keyDefinitionFor(keyName),
    modifiers,
  };
}

function modifierMaskForKey(key: string): number {
  switch (key.toLowerCase()) {
    case "alt":
    case "option":
      return 1;
    case "control":
    case "ctrl":
      return 2;
    case "meta":
    case "cmd":
    case "command":
      return 4;
    case "shift":
      return 8;
    default:
      return 0;
  }
}

function keyDefinitionFor(key: string): KeyDefinition {
  const existing = keyDefinitions.get(key);
  if (existing) {
    return existing;
  }

  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return {
      key: key.toLowerCase(),
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }

  return {
    key,
    code: key,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    text: key.length === 1 ? key : undefined,
  };
}
