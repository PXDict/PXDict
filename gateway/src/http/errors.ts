import { errorBody } from "@pxdict/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Sends the single API error shape: {"error": {"code": "...", "message": "..."}}. */
export function jsonError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  c.header("Cache-Control", "no-store");
  return c.json(errorBody(code, message), status);
}
