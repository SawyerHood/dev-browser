import { describe, expect, it } from "vitest";

import { checkProtocolMessage } from "../sandbox-policy.js";

describe("sandbox protocol policy", () => {
  it("rejects setInputFilePaths with localPaths", () => {
    const violation = checkProtocolMessage({
      id: 7,
      guid: "element-handle@1",
      method: "setInputFilePaths",
      params: { localPaths: ["/etc/passwd"] },
    });
    expect(violation).toEqual({ method: "setInputFilePaths", param: "localPaths" });
  });

  it("rejects screenshot with a host path", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "page@1",
        method: "screenshot",
        params: { path: "/tmp/leak.png" },
      })
    ).toEqual({ method: "screenshot", param: "path" });
  });

  it("rejects pdf, addScriptTag, addStyleTag, saveAs, storageState path/file params", () => {
    const cases = [
      ["pdf", "path"],
      ["addScriptTag", "path"],
      ["addStyleTag", "path"],
      ["saveAs", "path"],
      ["storageState", "path"],
      ["harOpen", "file"],
      ["tracingStop", "path"],
    ] as const;
    for (const [method, param] of cases) {
      expect(
        checkProtocolMessage({
          id: 1,
          guid: "x@1",
          method,
          params: { [param]: "/tmp/x" },
        })
      ).toEqual({ method, param });
    }
  });

  it("allows screenshot without a path param", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "page@1",
        method: "screenshot",
        params: { fullPage: true },
      })
    ).toBeNull();
  });

  it("allows unrelated methods to pass through", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "page@1",
        method: "goto",
        params: { url: "https://example.com" },
      })
    ).toBeNull();
  });

  it("ignores null/undefined param values", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "page@1",
        method: "screenshot",
        params: { path: null },
      })
    ).toBeNull();
  });

  it("returns null for messages without a method (e.g. responses)", () => {
    expect(checkProtocolMessage({ id: 1, result: {} })).toBeNull();
  });
});
