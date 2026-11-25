// Per-user data under /app-api/me/*: settings, search history, dictionary selection, favorites.
import { z } from "zod";

export const SearchModeSetting = z.enum(["exact", "prefix", "fts", "wildcard"]);
export type SearchModeSetting = z.infer<typeof SearchModeSetting>;

export const ThemeSetting = z.enum(["system", "light", "dark"]);
export type ThemeSetting = z.infer<typeof ThemeSetting>;

export const FontSizeSetting = z.enum(["small", "medium", "large", "xlarge"]);
export type FontSizeSetting = z.infer<typeof FontSizeSetting>;

/** A PXDict dictionary id (also its folder name under DICT_DIR). */
export const DictId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** Body of GET /app-api/me/settings (also part of GET /app-api/me). */
export const UserSettings = z.object({
  /** Lookups are recorded in the search history. */
  historyEnabled: z.boolean(),
  /** Days history is kept; 0 keeps it forever. */
  historyRetentionDays: z.number().int().min(0).max(36500),
  /** Search mode used when a lookup does not name one. */
  defaultMode: SearchModeSetting,
  /** UI language (e.g. "vi"); null follows the device. */
  uiLang: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/)
    .nullable(),
  theme: ThemeSetting,
  fontSize: FontSizeSetting,
});
export type UserSettings = z.infer<typeof UserSettings>;

/** Body of PUT /app-api/me/settings: the fields to change. Answers the full settings. */
export const UpdateSettingsRequest = UserSettings.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

/** One recorded lookup. */
export const HistoryEntry = z.object({
  id: z.number().int(),
  query: z.string(),
  mode: z.string(),
  /** The lookup was restricted to these dictionaries; null for the user's enabled set. */
  dictIds: z.array(z.string()).nullable(),
  createdAt: z.iso.datetime(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Query of GET /app-api/me/history. */
export const HistoryQuery = z.object({
  /** Only entries whose query contains this text (case-insensitive). */
  q: z.string().max(500).optional(),
  /** `nextCursor` of the previous page. */
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** "1": one entry per distinct query, newest first (search-box suggestions). */
  unique: z.enum(["0", "1"]).optional(),
});
export type HistoryQuery = z.input<typeof HistoryQuery>;

/** Body of GET /app-api/me/history, newest first. */
export const HistoryPage = z.object({
  entries: z.array(HistoryEntry),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.number().int().nullable(),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

/** One dictionary the user may use, as listed by GET /app-api/me/dicts. */
export const MyDict = z.object({
  id: DictId,
  title: z.string(),
  format: z.string().nullable(),
  /** "global" (everyone) or "private" (only this user). */
  visibility: z.enum(["global", "private"]),
  enabled: z.boolean(),
  /** 0-based position in the user's order. */
  position: z.number().int(),
  /** Added since the user last acknowledged new dictionaries. */
  isNew: z.boolean(),
  /** The dictionary server lists it right now; unavailable ones are kept but not searched. */
  available: z.boolean(),
  /** wuDict's current id (what /api/search calls `dict`); null while unavailable. */
  wudictId: z.string().nullable(),
});
export type MyDict = z.infer<typeof MyDict>;

/** Body of GET and PUT /app-api/me/dicts, in the user's order. */
export const MyDictList = z.object({ dicts: z.array(MyDict) });
export type MyDictList = z.infer<typeof MyDictList>;

/**
 * Body of PUT /app-api/me/dicts: the new order and enabled flags. Listed ids come first in this order;
 * dictionaries left out keep their flag and follow in their old order. Unknown ids are refused.
 */
export const UpdateMyDictsRequest = z.object({
  dicts: z
    .array(z.object({ id: DictId, enabled: z.boolean() }))
    .max(1000)
    .refine((list) => new Set(list.map((d) => d.id)).size === list.length, "duplicate dictionary id"),
});
export type UpdateMyDictsRequest = z.infer<typeof UpdateMyDictsRequest>;

/** A dictionary added for the user since they last acknowledged (POST /app-api/me/dicts/seen). */
export const NewDict = z.object({ id: DictId, title: z.string() });
export type NewDict = z.infer<typeof NewDict>;

export const Headword = z
  .string()
  .max(500)
  .refine((s) => s.trim() !== "", "headword must not be blank");

/** One saved word. */
export const Favorite = z.object({
  headword: z.string(),
  dictId: z.string(),
  /** Null when the dictionary is no longer available to this user. */
  dictTitle: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Favorite = z.infer<typeof Favorite>;

/** Body of GET /app-api/me/favorites, newest first. */
export const FavoriteList = z.object({ favorites: z.array(Favorite) });
export type FavoriteList = z.infer<typeof FavoriteList>;

/** Body of POST /app-api/me/favorites: saves a word, or replaces the note of a saved one. */
export const SaveFavoriteRequest = z.object({
  headword: Headword,
  dictId: DictId,
  note: z.string().trim().max(2000).nullable().optional(),
});
export type SaveFavoriteRequest = z.infer<typeof SaveFavoriteRequest>;

/** Query of DELETE /app-api/me/favorites. */
export const DeleteFavoriteQuery = z.object({ headword: Headword, dict: DictId });
export type DeleteFavoriteQuery = z.infer<typeof DeleteFavoriteQuery>;

/** Query of the export endpoints (GET /app-api/me/history/export, /app-api/me/favorites/export). */
export const ExportQuery = z.object({ format: z.enum(["json", "csv"]).default("json") });
export type ExportQuery = z.input<typeof ExportQuery>;
