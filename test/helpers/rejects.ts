/**
 * `await expect(p).rejects.toThrow(want)`, but awaiting the rejection first: on Windows
 * Bun's `expect(promise).rejects` (1.3.14) stops socket reads while it waits, so a promise
 * settled by a CDP reply only rejects when Puppeteer's 30 s protocolTimeout fires.
 */
import { expect } from "bun:test";

export async function expectRejects(
  p: Promise<unknown>,
  want: string | RegExp | (abstract new (...args: never[]) => Error),
): Promise<void> {
  const err = await p.then(
    () => {
      throw new Error("expected the promise to reject, but it resolved");
    },
    (e: unknown) => e,
  );
  expect(() => {
    throw err;
  }).toThrow(want as RegExp);
}
