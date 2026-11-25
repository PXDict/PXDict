import { z } from "zod";

/**
 * The single error shape of PXDict's own API: {"error": {"code": "snake_case", "message": "..."}}.
 * Better Auth's routes under /app-api/auth/* keep their own format.
 */
export const ErrorBody = z.object({
  error: z.object({
    /** Stable snake_case code that clients may branch on, e.g. "not_found". */
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Human-readable message in English; the PWA shows translated text based on `code`. */
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Builds an error body. */
export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
