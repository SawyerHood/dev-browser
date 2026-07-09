type AsyncAction<T> = () => Promise<T>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw abortReason(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

export function createKeyedLock<K>() {
  const locks = new Map<K, Promise<void>>();

  return async function withLock<T>(
    key: K,
    action: AsyncAction<T>,
    options: { signal?: AbortSignal } = {}
  ): Promise<T> {
    const previous = (locks.get(key) ?? Promise.resolve()).catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    locks.set(key, tail);

    try {
      if (options.signal) {
        await waitForTurn(previous, options.signal);
      } else {
        await previous;
      }
      if (options.signal?.aborted) {
        throw abortReason(options.signal);
      }
      return await action();
    } finally {
      release();
      void tail.then(() => {
        if (locks.get(key) === tail) {
          locks.delete(key);
        }
      });
    }
  };
}

export function createMutex() {
  const withLock = createKeyedLock<symbol>();
  const lockKey = Symbol("mutex");

  return function withMutex<T>(action: AsyncAction<T>): Promise<T> {
    return withLock(lockKey, action);
  };
}
