import { badRequestError } from "./errors.js";

export function extractStringField(body: unknown, field: string): string {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)[field] !== "string"
  ) {
    throw badRequestError(`Request body must include a "${field}" string field`);
  }
  return (body as Record<string, unknown>)[field] as string;
}
