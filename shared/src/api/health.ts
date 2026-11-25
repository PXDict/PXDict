import { z } from "zod";

const Check = z.enum(["ok", "down"]);

/** Body of GET /healthz. HTTP 200 when every check is "ok", 503 otherwise. */
export const Health = z.object({
  status: z.enum(["ok", "unavailable"]),
  /** Gateway build version. */
  version: z.string(),
  checks: z.object({
    /** The loopback wuDict server answers with the gateway's token. */
    wudict: Check,
    /** The gateway's SQLite database answers. */
    database: Check,
  }),
});
export type Health = z.infer<typeof Health>;
