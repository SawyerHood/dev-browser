const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Replacement {
  needle: string;
  name: string;
}

export function redactionMarker(name: string): string {
  return `[REDACTED:${name}]`;
}

function encodedVariants(value: string): string[] {
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return [...new Set([value, jsonEscaped, encodeURIComponent(value)])];
}

export class SecretRedactor {
  readonly #valuesByName = new Map<string, string>();
  #replacements: Replacement[] = [];

  register(name: unknown, value: unknown): void {
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
      throw new TypeError("secrets.register() name must match /^[A-Za-z_][A-Za-z0-9_]*$/");
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`secrets.register("${name}") value must be a non-empty string`);
    }

    this.#valuesByName.set(name, value);
    this.#rebuildReplacements();
  }

  get isEmpty(): boolean {
    return this.#valuesByName.size === 0;
  }

  redact(text: string): string {
    let result = text;
    for (const { needle, name } of this.#replacements) {
      result = result.split(needle).join(redactionMarker(name));
    }
    return result;
  }

  nameForExactValue(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    for (const [name, registered] of this.#valuesByName) {
      if (registered === value) {
        return name;
      }
    }
    return undefined;
  }

  #rebuildReplacements(): void {
    this.#replacements = [...this.#valuesByName]
      .flatMap(([name, value]) => encodedVariants(value).map((needle) => ({ needle, name })))
      .sort((left, right) => right.needle.length - left.needle.length);
  }
}
