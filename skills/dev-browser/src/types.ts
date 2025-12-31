// API request/response types - shared between client and server

export interface ServeOptions {
  port?: number;
  /** Host to bind the server to. Defaults to "localhost". Use "0.0.0.0" for remote access. */
  host?: string;
  headless?: boolean;
  cdpPort?: number;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /** If true, Chrome is not launched until first client request. Defaults to false. */
  lazy?: boolean;
}

export interface GetPageRequest {
  name: string;
}

export interface GetPageResponse {
  wsEndpoint: string;
  name: string;
  targetId: string; // CDP target ID for reliable page matching
}

export interface ListPagesResponse {
  pages: string[];
}

export interface ServerInfoResponse {
  wsEndpoint: string;
}
