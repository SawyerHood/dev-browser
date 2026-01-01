// API request/response types - shared between client and server

export interface ServeOptions {
  port?: number;
  headless?: boolean;
  cdpPort?: number;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
}

export interface GetPageRequest {
  name: string;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
  mode: "launch" | "extension"; // Server mode - eliminates need for separate GET /
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
}

// Server-side page operation types (Phase 2: HTTP-only client support)

export interface EvaluateRequest {
  expression: string;
}

export interface EvaluateResponse {
  result: unknown;
  error?: string;
}

export interface SnapshotResponse {
  snapshot: string;
  error?: string;
}

export interface NavigateRequest {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface NavigateResponse {
  url: string;
  title: string;
  error?: string;
}

export interface SelectRefRequest {
  ref: string;
}

export interface SelectRefResponse {
  found: boolean;
  tagName?: string;
  textContent?: string;
  error?: string;
}

// Phase 3: Additional HTTP endpoints for full client-lite support

export interface ScreenshotRequest {
  fullPage?: boolean;
  selector?: string;
}

export interface ScreenshotResponse {
  screenshot: string; // base64 encoded PNG
  mimeType: "image/png";
  error?: string;
}

export interface SetViewportRequest {
  width: number;
  height: number;
}

export interface SetViewportResponse {
  success: boolean;
  width: number;
  height: number;
  error?: string;
}

export interface WaitForSelectorRequest {
  selector: string;
  timeout?: number;
  state?: "attached" | "detached" | "visible" | "hidden";
}

export interface WaitForSelectorResponse {
  success: boolean;
  error?: string;
}

export interface PageInfoResponse {
  url: string;
  title: string;
  error?: string;
}
