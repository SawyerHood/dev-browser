import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version: string }).version;
export const NAME = "dev-browser";
