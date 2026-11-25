// The ONLY adapter for PXDict's own API (/app-api and /healthz) that UI code imports. Types come from
// @pxdict/shared, the zod schemas the gateway validates with; only types are imported, so zod is not
// bundled. Better Auth's endpoints (/app-api/auth/*) are wrapped in ./auth and re-exported here.
import type {
  AdminDict,
  AdminDictList,
  AdminProposal,
  AdminProposalList,
  ApproveProposalRequest,
  AuditPage,
  AuthMethods,
  CreateInviteRequest,
  CreateInviteResponse,
  Invite,
  InviteList,
  ChunkResponse,
  ClaimInviteRequest,
  CreateProposalRequest,
  IndexStatus,
  Favorite,
  FavoriteList,
  Health,
  HistoryEntry,
  HistoryPage,
  Me,
  MyDict,
  MyDictList,
  NewDict,
  Proposal,
  ProposalList,
  ProposalStatus,
  ProposalUpdate,
  RejectProposalRequest,
  SaveFavoriteRequest,
  StorageExecuteResult,
  StorageItemRef,
  StorageOverview,
  StoragePlan,
  UpdateAdminDictRequest,
  UpdateMyDictsRequest,
  UpdateSettingsRequest,
  UploadLimits,
  UserSettings,
} from "@pxdict/shared";
import { send, toApiError } from "./http";

export { ApiError, isNetworkError, onUnauthorized } from "./http";
export * from "./auth";
export type {
  AdminDict,
  AdminProposal,
  ApproveProposalRequest,
  AuditPage,
  AuthMethods,
  CreateInviteRequest,
  CreateInviteResponse,
  Invite,
  StorageExecuteResult,
  StorageItemRef,
  StorageOverview,
  StoragePlan,
  Favorite,
  Health,
  HistoryEntry,
  HistoryPage,
  IndexStatus,
  Me,
  MyDict,
  NewDict,
  Proposal,
  ProposalStatus,
  ProposalUpdate,
  UpdateAdminDictRequest,
  UploadLimits,
  UserSettings,
};

const opts = (signal?: AbortSignal): RequestInit => (signal ? { signal } : {});

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await send(path, opts(signal));
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** GET /healthz */
export function getHealth(signal?: AbortSignal): Promise<Health> {
  return getJson<Health>("/healthz", signal);
}

/** GET /app-api/auth/methods: which sign-in methods the login screen offers. Public. */
export function getAuthMethods(signal?: AbortSignal): Promise<AuthMethods> {
  return getJson<AuthMethods>("/app-api/auth/methods", signal);
}

/** GET /app-api/me: the signed-in user; throws ApiError 401 without a session. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return getJson<Me>("/app-api/me", signal);
}

/** POST /app-api/auth/invite: remembers an invite code (HttpOnly cookie) for the next sign-up. */
export async function claimInvite(code: string): Promise<void> {
  const res = await send("/app-api/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code } satisfies ClaimInviteRequest),
  });
  if (!res.ok) throw await toApiError(res);
}

async function sendJson<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await send(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function sendEmpty(method: string, path: string, body?: unknown): Promise<void> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await send(path, init);
  if (!res.ok) throw await toApiError(res);
}

/** PUT /app-api/me/settings: changes some settings; answers all of them. */
export function updateSettings(changes: UpdateSettingsRequest): Promise<UserSettings> {
  return sendJson<UserSettings>("PUT", "/app-api/me/settings", changes);
}

export interface HistoryOptions {
  q?: string;
  cursor?: number;
  limit?: number;
  /** One entry per distinct query. */
  unique?: boolean;
}

/** GET /app-api/me/history: newest first, a page at a time. */
export function getHistory(o: HistoryOptions = {}, signal?: AbortSignal): Promise<HistoryPage> {
  const p = new URLSearchParams();
  if (o.q) p.set("q", o.q);
  if (o.cursor) p.set("cursor", String(o.cursor));
  if (o.limit) p.set("limit", String(o.limit));
  if (o.unique) p.set("unique", "1");
  const qs = p.toString();
  return getJson<HistoryPage>(`/app-api/me/history${qs ? `?${qs}` : ""}`, signal);
}

/** DELETE /app-api/me/history/{id} */
export function deleteHistoryEntry(id: number): Promise<void> {
  return sendEmpty("DELETE", `/app-api/me/history/${String(id)}`);
}

/** DELETE /app-api/me/history: forgets every lookup. */
export function clearHistory(): Promise<void> {
  return sendEmpty("DELETE", "/app-api/me/history");
}

/** Download links for exports (opened by the browser, not fetched). */
export const exportUrl = (what: "history" | "favorites", format: "csv" | "json") =>
  `/app-api/me/${what}/export?format=${format}`;

/** GET /app-api/me/dicts: every dictionary the user may use, in their order. */
export async function getMyDicts(signal?: AbortSignal): Promise<MyDict[]> {
  return (await getJson<MyDictList>("/app-api/me/dicts", signal)).dicts;
}

/** PUT /app-api/me/dicts: saves the order and the enabled flags. */
export async function saveMyDicts(dicts: UpdateMyDictsRequest["dicts"]): Promise<MyDict[]> {
  return (await sendJson<MyDictList>("PUT", "/app-api/me/dicts", { dicts } satisfies UpdateMyDictsRequest)).dicts;
}

/** POST /app-api/me/dicts/seen: stops announcing new dictionaries. */
export function markDictsSeen(): Promise<void> {
  return sendEmpty("POST", "/app-api/me/dicts/seen");
}

/** GET /app-api/me/favorites, newest first. */
export async function getFavorites(signal?: AbortSignal): Promise<Favorite[]> {
  return (await getJson<FavoriteList>("/app-api/me/favorites", signal)).favorites;
}

/** POST /app-api/me/favorites: saves a word (and, when given, its note). */
export function saveFavorite(f: SaveFavoriteRequest): Promise<void> {
  return sendEmpty("POST", "/app-api/me/favorites", f);
}

/** DELETE /app-api/me/favorites */
export function deleteFavorite(headword: string, dictId: string): Promise<void> {
  return sendEmpty("DELETE", `/app-api/me/favorites?${new URLSearchParams({ headword, dict: dictId }).toString()}`);
}

// Dictionary proposals (ADR 0008)

/** GET /app-api/proposals/limits: sizes, chunk size and accepted file types. */
export function getUploadLimits(signal?: AbortSignal): Promise<UploadLimits> {
  return getJson<UploadLimits>("/app-api/proposals/limits", signal);
}

/** POST /app-api/proposals: metadata + file list; files are sent next with uploadChunk. */
export function createProposal(req: CreateProposalRequest): Promise<Proposal> {
  return sendJson<Proposal>("POST", "/app-api/proposals", req);
}

/** PUT /app-api/proposals/{id}/files/{index}: one chunk at `offset` (the bytes stored so far). */
export async function uploadChunk(id: string, index: number, offset: number, chunk: Blob, signal?: AbortSignal): Promise<ChunkResponse> {
  const res = await send(`/app-api/proposals/${id}/files/${String(index)}`, {
    method: "PUT",
    headers: { "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
    body: chunk,
    ...opts(signal),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as ChunkResponse;
}

/** GET /app-api/proposals/{id}: one of the user's proposals (how much of each file arrived). */
export function getProposal(id: string, signal?: AbortSignal): Promise<Proposal> {
  return getJson<Proposal>(`/app-api/proposals/${id}`, signal);
}

/** POST /app-api/proposals/{id}/submit: the server checks the files; the proposal waits for review. */
export function submitProposal(id: string): Promise<Proposal> {
  return sendJson<Proposal>("POST", `/app-api/proposals/${id}/submit`, {});
}

/** DELETE /app-api/proposals/{id}: withdraws it; its files are deleted at once. */
export function withdrawProposal(id: string): Promise<void> {
  return sendEmpty("DELETE", `/app-api/proposals/${id}`);
}

/** GET /app-api/me/proposals, newest first. */
export async function getMyProposals(signal?: AbortSignal): Promise<Proposal[]> {
  return (await getJson<ProposalList>("/app-api/me/proposals", signal)).proposals;
}

/** POST /app-api/me/proposals/seen: stops announcing approvals and rejections. */
export function markProposalsSeen(): Promise<void> {
  return sendEmpty("POST", "/app-api/me/proposals/seen");
}

// Admin: proposals and dictionaries

/** GET /app-api/admin/proposals */
export async function getAdminProposals(status?: ProposalStatus, signal?: AbortSignal): Promise<AdminProposal[]> {
  const qs = status ? `?status=${status}` : "";
  return (await getJson<AdminProposalList>(`/app-api/admin/proposals${qs}`, signal)).proposals;
}

/** POST /app-api/admin/proposals/{id}/approve: indexing then runs in the background. */
export function approveProposal(id: string, req: ApproveProposalRequest): Promise<AdminProposal> {
  return sendJson<AdminProposal>("POST", `/app-api/admin/proposals/${id}/approve`, req);
}

/** POST /app-api/admin/proposals/{id}/reject: deletes the files, keeps the reason for the proposer. */
export function rejectProposal(id: string, note: string): Promise<AdminProposal> {
  return sendJson<AdminProposal>("POST", `/app-api/admin/proposals/${id}/reject`, { note } satisfies RejectProposalRequest);
}

/** GET /app-api/admin/dicts */
export async function getAdminDicts(signal?: AbortSignal): Promise<AdminDict[]> {
  return (await getJson<AdminDictList>("/app-api/admin/dicts", signal)).dicts;
}

/** POST /app-api/admin/dicts/rescan: wuDict reads its dictionary folder again. */
export async function rescanDicts(): Promise<AdminDict[]> {
  return (await sendJson<AdminDictList>("POST", "/app-api/admin/dicts/rescan", {})).dicts;
}

/** PATCH /app-api/admin/dicts/{id} */
export function updateAdminDict(id: string, change: UpdateAdminDictRequest): Promise<AdminDict> {
  return sendJson<AdminDict>("PATCH", `/app-api/admin/dicts/${id}`, change);
}

/** GET /app-api/admin/dicts/{id}/index-status */
export function getIndexStatus(id: string, signal?: AbortSignal): Promise<IndexStatus> {
  return getJson<IndexStatus>(`/app-api/admin/dicts/${id}/index-status`, signal);
}

/** POST /app-api/admin/dicts/{id}/index: indexes it again (after an error). */
export function reindexDict(id: string): Promise<IndexStatus> {
  return sendJson<IndexStatus>("POST", `/app-api/admin/dicts/${id}/index`, {});
}

// Admin: storage (dry-run plan, then execute), audit log, invites

/** GET /app-api/admin/storage: disk use and what can be cleaned up. */
export function getStorage(signal?: AbortSignal): Promise<StorageOverview> {
  return getJson<StorageOverview>("/app-api/admin/storage", signal);
}

/** POST /app-api/admin/storage/plan: a dry run listing every file that would be deleted. */
export function planStorageDeletion(items: StorageItemRef[]): Promise<StoragePlan> {
  return sendJson<StoragePlan>("POST", "/app-api/admin/storage/plan", { items });
}

/** POST /app-api/admin/storage/execute: deletes what the plan listed (files that changed are skipped). */
export function executeStoragePlan(planId: string): Promise<StorageExecuteResult> {
  return sendJson<StorageExecuteResult>("POST", "/app-api/admin/storage/execute", { planId });
}

/** GET /app-api/admin/audit: newest first; pass the previous page's nextCursor for more. */
export function getAudit(o: { cursor?: number; action?: string } = {}, signal?: AbortSignal): Promise<AuditPage> {
  const p = new URLSearchParams();
  if (o.cursor) p.set("cursor", String(o.cursor));
  if (o.action) p.set("action", o.action);
  const qs = p.toString();
  return getJson<AuditPage>(`/app-api/admin/audit${qs ? `?${qs}` : ""}`, signal);
}

/** GET /app-api/admin/invites */
export async function getInvites(signal?: AbortSignal): Promise<Invite[]> {
  return (await getJson<InviteList>("/app-api/admin/invites", signal)).invites;
}

/** POST /app-api/admin/invites: the code is in the answer, shown this once. */
export function createInvite(req: CreateInviteRequest): Promise<CreateInviteResponse> {
  return sendJson<CreateInviteResponse>("POST", "/app-api/admin/invites", req);
}

/** DELETE /app-api/admin/invites/{id} */
export function deleteInvite(id: string): Promise<void> {
  return sendEmpty("DELETE", `/app-api/admin/invites/${encodeURIComponent(id)}`);
}
