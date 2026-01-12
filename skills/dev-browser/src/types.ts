// API request/response types - shared between client and server

export interface ServeOptions {
  port?: number;
  headless?: boolean;
  cdpPort?: number;
  /** Directory to store persistent browser profiles (cookies, localStorage, etc.) */
  profileDir?: string;
  /** Enable Playwright's built-in video recording for all pages */
  recordVideo?: RecordVideoOptions;
  /** Directory for CDP Screencast recordings (default: ./recordings) */
  recordingsDir?: string;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface GetPageRequest {
  name: string;
  /** Optional viewport size for new pages */
  viewport?: ViewportSize;
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

// === Video Recording Types ===

/** Options for Playwright's built-in recordVideo (context-level) */
export interface RecordVideoOptions {
  /** Directory to save video files */
  dir: string;
  /** Optional video dimensions */
  size?: { width: number; height: number };
}

/** Options for per-page CDP Screencast recording */
export interface RecordingOptions {
  /** Max width for screencast frames (default: 1280) */
  maxWidth?: number;
  /** Max height for screencast frames (default: 720) */
  maxHeight?: number;
  /** JPEG quality 0-100 (default: 80) */
  quality?: number;
  /** Capture every Nth frame (default: 1) */
  everyNthFrame?: number;
}

export interface StartRecordingRequest {
  options?: RecordingOptions;
}

export interface StartRecordingResponse {
  success: boolean;
  error?: string;
}

export interface StopRecordingResponse {
  success: boolean;
  /** Path to the recorded video file */
  videoPath?: string;
  /** Recording duration in milliseconds */
  durationMs?: number;
  /** Number of frames captured */
  frameCount?: number;
  error?: string;
}

export interface RecordingStatusResponse {
  /** Whether the page is currently being recorded */
  isRecording: boolean;
  /** When recording started (ISO string) */
  startedAt?: string;
  /** Number of frames captured so far */
  frameCount?: number;
}

export interface GetVideoPathResponse {
  /** Path to video file (Playwright recordVideo) */
  videoPath?: string;
  /** Whether video is still being written */
  pending: boolean;
  error?: string;
}
