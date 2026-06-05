export function formatError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "ScriptTimeoutError") {
      return error.message;
    }
    const header = `${error.name}: ${error.message}`;
    if (!error.stack) {
      return header;
    }
    return error.stack.startsWith(header) ? error.stack : `${header}\n${error.stack}`;
  }

  return String(error);
}
