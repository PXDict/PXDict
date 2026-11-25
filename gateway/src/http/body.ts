// Request parsing with the shared zod schemas.
import type { Context } from "hono";
import type { z } from "zod";

/** Parses a JSON body with a shared schema; undefined when it is missing or invalid. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S> | undefined> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return undefined;
  }
  const result = schema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Parses the query string with a shared schema (first value of each key); undefined when invalid. */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> | undefined {
  const raw: Record<string, string> = {};
  for (const [k, v] of new URL(c.req.url).searchParams) if (!(k in raw)) raw[k] = v;
  const result = schema.safeParse(raw);
  return result.success ? result.data : undefined;
}
