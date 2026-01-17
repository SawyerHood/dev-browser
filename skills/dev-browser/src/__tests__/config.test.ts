/**
 * Config discovery tests
 *
 * Tests for XDG Base Directory Specification support and
 * project-level config discovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  getXdgConfigHome,
  getXdgStateHome,
  findProjectConfig,
  getConfigFilePath,
  getStateDir,
} from "../config";

// Mock fs module
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { existsSync } from "fs";
const mockExistsSync = vi.mocked(existsSync);

describe("XDG Base Directory Support", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getXdgConfigHome", () => {
    it("should return XDG_CONFIG_HOME when set", () => {
      process.env.XDG_CONFIG_HOME = "/custom/config";
      process.env.HOME = "/home/user";

      expect(getXdgConfigHome()).toBe("/custom/config");
    });

    it("should fall back to ~/.config when XDG_CONFIG_HOME not set", () => {
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = "/home/user";

      expect(getXdgConfigHome()).toBe("/home/user/.config");
    });

    it("should handle missing HOME gracefully", () => {
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.HOME;

      expect(getXdgConfigHome()).toBe(".config");
    });
  });

  describe("getXdgStateHome", () => {
    it("should return XDG_STATE_HOME when set", () => {
      process.env.XDG_STATE_HOME = "/custom/state";
      process.env.HOME = "/home/user";

      expect(getXdgStateHome()).toBe("/custom/state");
    });

    it("should fall back to ~/.local/state when XDG_STATE_HOME not set", () => {
      delete process.env.XDG_STATE_HOME;
      process.env.HOME = "/home/user";

      expect(getXdgStateHome()).toBe("/home/user/.local/state");
    });

    it("should handle missing HOME gracefully", () => {
      delete process.env.XDG_STATE_HOME;
      delete process.env.HOME;

      expect(getXdgStateHome()).toBe(join(".local", "state"));
    });
  });
});

describe("findProjectConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should find config in the starting directory", () => {
    mockExistsSync.mockImplementation((path) => {
      return path === "/projects/myapp/.dev-browser/config.json";
    });

    const result = findProjectConfig("/projects/myapp");

    expect(result).toBe("/projects/myapp/.dev-browser/config.json");
  });

  it("should walk up and find config in parent directory", () => {
    mockExistsSync.mockImplementation((path) => {
      return path === "/projects/.dev-browser/config.json";
    });

    const result = findProjectConfig("/projects/myapp/src/components");

    expect(result).toBe("/projects/.dev-browser/config.json");
  });

  it("should return undefined when no config found", () => {
    mockExistsSync.mockReturnValue(false);

    const result = findProjectConfig("/projects/myapp");

    expect(result).toBeUndefined();
  });

  it("should stop at filesystem root", () => {
    mockExistsSync.mockReturnValue(false);

    const result = findProjectConfig("/a/b/c/d/e");

    expect(result).toBeUndefined();
    // Should have checked multiple directories walking up
    expect(mockExistsSync).toHaveBeenCalled();
  });
});

describe("getConfigFilePath", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.cwd = () => "/projects/myapp";
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.cwd = originalCwd;
  });

  it("should prioritize DEV_BROWSER_CONFIG env var", () => {
    process.env.DEV_BROWSER_CONFIG = "/custom/path/config.json";
    process.env.HOME = "/home/user";
    mockExistsSync.mockImplementation((path) => {
      return path === "/custom/path/config.json";
    });

    const result = getConfigFilePath();

    expect(result.path).toBe("/custom/path/config.json");
    expect(result.exists).toBe(true);
  });

  it("should return DEV_BROWSER_CONFIG path even if file does not exist", () => {
    process.env.DEV_BROWSER_CONFIG = "/nonexistent/config.json";
    process.env.HOME = "/home/user";
    mockExistsSync.mockReturnValue(false);

    const result = getConfigFilePath();

    expect(result.path).toBe("/nonexistent/config.json");
    expect(result.exists).toBe(false);
  });

  it("should find project config when no env var set", () => {
    delete process.env.DEV_BROWSER_CONFIG;
    process.env.HOME = "/home/user";
    mockExistsSync.mockImplementation((path) => {
      return path === "/projects/myapp/.dev-browser/config.json";
    });

    const result = getConfigFilePath();

    expect(result.path).toBe("/projects/myapp/.dev-browser/config.json");
    expect(result.exists).toBe(true);
  });

  it("should use XDG config home when no project config", () => {
    delete process.env.DEV_BROWSER_CONFIG;
    process.env.XDG_CONFIG_HOME = "/custom/config";
    process.env.HOME = "/home/user";
    mockExistsSync.mockImplementation((path) => {
      return path === "/custom/config/dev-browser/config.json";
    });

    const result = getConfigFilePath();

    expect(result.path).toBe("/custom/config/dev-browser/config.json");
    expect(result.exists).toBe(true);
  });

  it("should use default XDG path (~/.config) when XDG_CONFIG_HOME is set but file is in default location", () => {
    delete process.env.DEV_BROWSER_CONFIG;
    process.env.XDG_CONFIG_HOME = "/custom/config";
    process.env.HOME = "/home/user";
    mockExistsSync.mockImplementation((path) => {
      // File exists in default ~/.config location, not in custom XDG_CONFIG_HOME
      return path === "/home/user/.config/dev-browser/config.json";
    });

    const result = getConfigFilePath();

    expect(result.path).toBe("/home/user/.config/dev-browser/config.json");
    expect(result.exists).toBe(true);
  });

  it("should fall back to legacy ~/.dev-browser when nothing else exists", () => {
    delete process.env.DEV_BROWSER_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/user";
    mockExistsSync.mockReturnValue(false);

    const result = getConfigFilePath();

    expect(result.path).toBe("/home/user/.dev-browser/config.json");
    expect(result.exists).toBe(false);
  });
});

describe("getStateDir", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should use XDG_STATE_HOME when explicitly set", () => {
    process.env.XDG_STATE_HOME = "/custom/state";
    process.env.HOME = "/home/user";

    const result = getStateDir();

    expect(result).toBe("/custom/state/dev-browser");
  });

  it("should prefer existing XDG default location over legacy", () => {
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/user";
    mockExistsSync.mockImplementation((path) => {
      return path === "/home/user/.local/state/dev-browser";
    });

    const result = getStateDir();

    expect(result).toBe("/home/user/.local/state/dev-browser");
  });

  it("should fall back to legacy ~/.dev-browser if it exists", () => {
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/user";
    mockExistsSync.mockImplementation((path) => {
      return path === "/home/user/.dev-browser";
    });

    const result = getStateDir();

    expect(result).toBe("/home/user/.dev-browser");
  });

  it("should default to XDG location for new installations", () => {
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/user";
    mockExistsSync.mockReturnValue(false);

    const result = getStateDir();

    expect(result).toBe("/home/user/.local/state/dev-browser");
  });

  it("should prefer XDG over legacy when both directories exist", () => {
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/home/user";
    // Both directories exist
    mockExistsSync.mockImplementation((path) => {
      return (
        path === "/home/user/.local/state/dev-browser" ||
        path === "/home/user/.dev-browser"
      );
    });

    const result = getStateDir();

    // Should prefer XDG location
    expect(result).toBe("/home/user/.local/state/dev-browser");
  });
});

describe("loadConfig integration", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.cwd = () => "/projects/myapp";
    mockExistsSync.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.cwd = originalCwd;
  });

  it("should load config from project directory when present", async () => {
    // This is an integration test - we need to reimport to get fresh module state
    vi.resetModules();

    // Set up mocks before importing
    vi.doMock("fs", () => ({
      existsSync: (path: string) => {
        // Config file exists
        if (path === "/projects/myapp/.dev-browser/config.json") return true;
        // Browser path must also exist (loadConfig validates it)
        if (path === "/usr/bin/my-chrome") return true;
        return false;
      },
      readFileSync: (path: string) => {
        if (path === "/projects/myapp/.dev-browser/config.json") {
          return JSON.stringify({
            browser: {
              mode: "external",
              path: "/usr/bin/my-chrome"
            }
          });
        }
        throw new Error(`File not found: ${path}`);
      },
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));

    delete process.env.DEV_BROWSER_CONFIG;
    process.env.HOME = "/home/user";

    const { loadConfig } = await import("../config");
    const config = loadConfig();

    expect(config.browser.path).toBe("/usr/bin/my-chrome");
    expect(config.browser.mode).toBe("external");
  });

  it("should warn and fallback when configured browser path does not exist", async () => {
    vi.resetModules();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.doMock("fs", () => ({
      existsSync: (path: string) => {
        // Config file exists, but browser path does NOT
        if (path === "/projects/myapp/.dev-browser/config.json") return true;
        return false;
      },
      readFileSync: (path: string) => {
        if (path === "/projects/myapp/.dev-browser/config.json") {
          return JSON.stringify({
            browser: {
              mode: "external",
              path: "/nonexistent/chrome"
            }
          });
        }
        throw new Error(`File not found: ${path}`);
      },
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));

    delete process.env.DEV_BROWSER_CONFIG;
    process.env.HOME = "/home/user";

    const { loadConfig } = await import("../config");
    const config = loadConfig();

    // Should have warned about missing browser
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Configured browser path does not exist")
    );

    // Browser path should be undefined (fallback to auto-detection returns undefined when nothing found)
    expect(config.browser.path).toBeUndefined();

    warnSpy.mockRestore();
  });
});
