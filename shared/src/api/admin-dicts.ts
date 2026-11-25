// Admin dictionary catalogue (/app-api/admin/dicts): every dictionary the gateway knows, with its
// visibility, plus indexing status of dictionaries approved from proposals.
import { z } from "zod";
import { DictId } from "./me";

export const DictVisibility = z.enum(["global", "private", "hidden"]);
export type DictVisibility = z.infer<typeof DictVisibility>;

/** Indexing of one dictionary, run by the gateway after an approval (or a retry). */
export const IndexStatus = z.object({
  state: z.enum(["idle", "running", "done", "error"]),
  done: z.number().int(),
  total: z.number().int(),
  /** Why indexing failed (state "error"). */
  error: z.string().nullable(),
});
export type IndexStatus = z.infer<typeof IndexStatus>;

export const AdminDict = z.object({
  id: DictId,
  title: z.string(),
  format: z.string().nullable(),
  source: z.enum(["builtin", "proposal"]),
  visibility: DictVisibility,
  /** Owner of a private dictionary. */
  owner: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  trustedRender: z.boolean(),
  /** wuDict lists it right now. */
  available: z.boolean(),
  /** wuDict's current id; admins can try any available dictionary with /?dict=<wudictId>. */
  wudictId: z.string().nullable(),
  /** An index exists (wuDict reported a library folder). */
  indexed: z.boolean(),
  proposalId: z.string().nullable(),
  index: IndexStatus,
  createdAt: z.iso.datetime(),
});
export type AdminDict = z.infer<typeof AdminDict>;

/** Body of GET /app-api/admin/dicts and POST /app-api/admin/dicts/rescan. */
export const AdminDictList = z.object({ dicts: z.array(AdminDict) });
export type AdminDictList = z.infer<typeof AdminDictList>;

/** Body of PATCH /app-api/admin/dicts/{id}: the fields to change. */
export const UpdateAdminDictRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    visibility: DictVisibility,
    /** Required with visibility "private" unless the dictionary already has an owner. */
    ownerUserId: z.string().min(1).max(200),
    trustedRender: z.boolean(),
  })
  .partial();
export type UpdateAdminDictRequest = z.infer<typeof UpdateAdminDictRequest>;
