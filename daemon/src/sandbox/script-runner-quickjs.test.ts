import { describe, expect, it, vi } from "vitest";

import { finalizeSandbox } from "./script-runner-quickjs.js";

describe("finalizeSandbox", () => {
  it("always disposes the sandbox when pending-operation cancellation rejects", async () => {
    const dispose = vi.fn(async () => undefined);
    const abortError = new Error("stopPendingOperations failed");

    await expect(finalizeSandbox({ dispose }, Promise.reject(abortError))).rejects.toBe(abortError);

    expect(dispose).toHaveBeenCalledOnce();
  });
});
