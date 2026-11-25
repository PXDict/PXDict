import { z } from "zod";

/** Body of GET /healthz. */
export const Health = z.object({
  status: z.literal("ok"),
  /** Gateway build version. */
  version: z.string(),
});
export type Health = z.infer<typeof Health>;
