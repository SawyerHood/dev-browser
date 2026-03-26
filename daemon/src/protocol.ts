import { z } from "zod";

const RequestBaseSchema = z.object({
  id: z.string().min(1),
});

export const ExecuteRequestSchema = RequestBaseSchema.extend({
  type: z.literal("execute"),
  browser: z.string().min(1).default("default"),
  script: z.string(),
  headless: z.boolean().optional(),
  connect: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const BrowsersRequestSchema = RequestBaseSchema.extend({
  type: z.literal("browsers"),
});

export const PagesRequestSchema = RequestBaseSchema.extend({
  type: z.literal("pages"),
  browser: z.string().min(1).optional(),
});

export const BrowserStopRequestSchema = RequestBaseSchema.extend({
  type: z.literal("browser-stop"),
  browser: z.string().min(1),
});

export const StatusRequestSchema = RequestBaseSchema.extend({
  type: z.literal("status"),
});

export const InstallRequestSchema = RequestBaseSchema.extend({
  type: z.literal("install"),
});

export const StopRequestSchema = RequestBaseSchema.extend({
  type: z.literal("stop"),
});

export const RequestSchema = z.discriminatedUnion("type", [
  ExecuteRequestSchema,
  BrowsersRequestSchema,
  PagesRequestSchema,
  BrowserStopRequestSchema,
  StatusRequestSchema,
  InstallRequestSchema,
  StopRequestSchema,
]);

const ResponseBaseSchema = z.object({
  id: z.string().min(1),
});

export const StdoutMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("stdout"),
  data: z.string(),
});

export const StderrMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("stderr"),
  data: z.string(),
});

export const CompleteMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("complete"),
  success: z.literal(true),
});

export const ErrorMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("error"),
  message: z.string(),
});

export const ResultMessageSchema = ResponseBaseSchema.extend({
  type: z.literal("result"),
  data: z.unknown(),
});

export const ResponseSchema = z.discriminatedUnion("type", [
  StdoutMessageSchema,
  StderrMessageSchema,
  CompleteMessageSchema,
  ErrorMessageSchema,
  ResultMessageSchema,
]);

export type Request = z.infer<typeof RequestSchema>;
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;

type ParseSuccess = { success: true; request: Request };
type ParseFailure = { success: false; error: string; id?: string };

function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function extractId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeId = (value as { id?: unknown }).id;
  return typeof maybeId === "string" && maybeId.length > 0 ? maybeId : undefined;
}

export function parseRequest(line: string): ParseSuccess | ParseFailure {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Invalid JSON request",
    };
  }

  const result = RequestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      success: false,
      error: describeZodError(result.error),
      id: extractId(parsed),
    };
  }

  return {
    success: true,
    request: result.data,
  };
}

export function serialize(message: Response): string {
  return `${JSON.stringify(ResponseSchema.parse(message))}\n`;
}
