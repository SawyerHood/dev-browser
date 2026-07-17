import { describe, expect, it } from "vitest";

import { HostBridge } from "../host-bridge.js";
import { checkProtocolMessage } from "../sandbox-policy.js";

describe("sandbox protocol policy — unit", () => {
  it("rejects setInputFiles with localPaths", () => {
    expect(
      checkProtocolMessage({
        id: 7,
        guid: "element-handle@1",
        method: "setInputFiles",
        params: { localPaths: ["/etc/passwd"] },
      })
    ).toEqual({ method: "setInputFiles", param: "localPaths" });
  });

  it("rejects setInputFiles with localDirectory", () => {
    expect(
      checkProtocolMessage({
        id: 7,
        guid: "frame@1",
        method: "setInputFiles",
        params: { selector: "#f", localDirectory: "/etc" },
      })
    ).toEqual({ method: "setInputFiles", param: "localDirectory" });
  });

  it("rejects Artifact.saveAs with a host path", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "artifact@1",
        method: "saveAs",
        params: { path: "/tmp/exfil.bin" },
      })
    ).toEqual({ method: "saveAs", param: "path" });
  });

  it("rejects LocalUtils.harOpen with a host file", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "localUtils@1",
        method: "harOpen",
        params: { file: "/etc/passwd" },
      })
    ).toEqual({ method: "harOpen", param: "file" });
  });

  it("allows setInputFiles with payloads (no host path)", () => {
    expect(
      checkProtocolMessage({
        id: 1,
        guid: "frame@1",
        method: "setInputFiles",
        params: {
          selector: "#f",
          payloads: [{ name: "a.txt", mimeType: "text/plain", buffer: "" }],
        },
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
        guid: "artifact@1",
        method: "saveAs",
        params: { path: null },
      })
    ).toBeNull();
  });

  it("returns null for response messages without a method", () => {
    expect(checkProtocolMessage({ id: 1, result: {} })).toBeNull();
  });
});

describe("HostBridge.receiveFromSandbox — integration", () => {
  function createBridge() {
    const sent: string[] = [];
    const bridge = new HostBridge({
      sendToSandbox: (json) => sent.push(json),
      denyLaunch: true,
    });
    return { bridge, sent };
  }

  it("returns a policy error for harOpen and never dispatches it", async () => {
    const { bridge, sent } = createBridge();
    try {
      await bridge.receiveFromSandbox(
        JSON.stringify({
          id: 42,
          guid: "localUtils@1",
          method: "harOpen",
          params: { file: "/etc/passwd" },
        })
      );

      expect(sent).toHaveLength(1);
      const response = JSON.parse(sent[0]!) as {
        id: number;
        error?: { error?: { message?: string; name?: string } };
      };
      expect(response.id).toBe(42);
      expect(response.error?.error?.name).toBe("Error");
      expect(response.error?.error?.message).toContain("Sandbox policy");
      expect(response.error?.error?.message).toContain("harOpen");
      expect(response.error?.error?.message).toContain("file");
    } finally {
      await bridge.dispose();
    }
  });

  it("returns a policy error for setInputFiles localPaths", async () => {
    const { bridge, sent } = createBridge();
    try {
      await bridge.receiveFromSandbox(
        JSON.stringify({
          id: 99,
          guid: "element-handle@1",
          method: "setInputFiles",
          params: { localPaths: ["/etc/passwd"] },
        })
      );

      const response = JSON.parse(sent[0]!) as {
        error?: { error?: { message?: string } };
      };
      expect(response.error?.error?.message).toContain("setInputFiles");
      expect(response.error?.error?.message).toContain("localPaths");
    } finally {
      await bridge.dispose();
    }
  });

  it("forwards harmless messages to the dispatcher (different error shape)", async () => {
    // Without the policy, the same harOpen message would reach the dispatcher
    // and come back as a target/validation error from Playwright — NOT as a
    // 'Sandbox policy' message. We assert that benign method names produce a
    // non-policy response shape, proving the policy code path only fires for
    // matches and that other messages still flow.
    const { bridge, sent } = createBridge();
    try {
      await bridge.receiveFromSandbox(
        JSON.stringify({
          id: 1,
          guid: "page@nonexistent",
          method: "goto",
          params: { url: "https://example.com" },
        })
      );

      expect(sent.length).toBeGreaterThan(0);
      const response = JSON.parse(sent[0]!) as {
        error?: { error?: { message?: string } };
      };
      // Dispatcher will reject unknown guid with a TargetClosedError or
      // similar — what matters here is that we did NOT short-circuit it with
      // a policy error.
      expect(response.error?.error?.message ?? "").not.toContain("Sandbox policy");
    } finally {
      await bridge.dispose();
    }
  });
});
