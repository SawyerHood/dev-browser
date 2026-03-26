import { describe, expect, it } from "vitest";

import { parseRequest } from "./protocol.js";

describe("protocol request parsing", () => {
  it("accepts a pages request with an optional browser filter", () => {
    const filteredResult = parseRequest(
      JSON.stringify({
        id: "req-pages-filtered",
        type: "pages",
        browser: "default",
      })
    );
    const allBrowsersResult = parseRequest(
      JSON.stringify({
        id: "req-pages-all",
        type: "pages",
      })
    );

    expect(filteredResult).toEqual({
      success: true,
      request: {
        id: "req-pages-filtered",
        type: "pages",
        browser: "default",
      },
    });
    expect(allBrowsersResult).toEqual({
      success: true,
      request: {
        id: "req-pages-all",
        type: "pages",
      },
    });
  });

  it("still accepts browser-stop requests with explicit browser names", () => {
    const result = parseRequest(
      JSON.stringify({
        id: "req-browser-stop",
        type: "browser-stop",
        browser: "default",
      })
    );

    expect(result).toEqual({
      success: true,
      request: {
        id: "req-browser-stop",
        type: "browser-stop",
        browser: "default",
      },
    });
  });
});
