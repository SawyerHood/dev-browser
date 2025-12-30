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
