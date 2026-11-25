// Dictionary proposals (docs/PLAN.md Phase 6, ADR 0008): a user uploads dictionary files in chunks, the
// gateway checks them on submit, and an admin approves or rejects them.
//
//   POST   /app-api/proposals                      create (metadata + file list) → status "uploading"
//   PUT    /app-api/proposals/{id}/files/{index}   one chunk, raw bytes, header Upload-Offset
//   POST   /app-api/proposals/{id}/submit          checks the files → status "pending"
//   DELETE /app-api/proposals/{id}                 withdraw while "uploading" or "pending"
//   GET    /app-api/me/proposals                   the user's proposals
//   POST   /app-api/me/proposals/seen              acknowledge approvals/rejections
//   GET    /app-api/admin/proposals?status=        admin list; GET .../{id} detail
//   POST   /app-api/admin/proposals/{id}/approve   publish; indexing runs in the background
//   POST   /app-api/admin/proposals/{id}/reject    delete the files, keep the reason
import { z } from "zod";
import { DictId } from "./me";

export const ProposalStatus = z.enum(["uploading", "pending", "approved", "rejected", "withdrawn"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

/** Who may use an approved dictionary; "hidden" lets an admin try it before publishing it. */
export const ApprovalScope = z.enum(["global", "private", "hidden"]);
export type ApprovalScope = z.infer<typeof ApprovalScope>;

/** A file name as uploaded: one path segment, no control characters. Further checks run on the gateway. */
export const UploadFileName = z
  .string()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  .refine((s) => !/[/\\\0-\x1f\x7f]/.test(s) && s !== "." && s !== "..", "invalid file name");

/** Body of POST /app-api/proposals. */
export const CreateProposalRequest = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  /** Shown to the admin as text; never fetched by the gateway. */
  sourceUrl: z.url({ protocol: /^https?$/ }).max(2000).optional(),
  licenseNote: z.string().trim().max(2000).optional(),
  files: z
    .array(z.object({ name: UploadFileName, size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }))
    .min(1)
    .max(50)
    .refine((list) => new Set(list.map((f) => f.name.toLowerCase())).size === list.length, "duplicate file name"),
});
export type CreateProposalRequest = z.infer<typeof CreateProposalRequest>;

/** What kind of file: the dictionary itself, its companions, or a resource. */
export const ProposalFileKind = z.enum(["main", "companion", "resource", "zip"]);
export type ProposalFileKind = z.infer<typeof ProposalFileKind>;

export const ProposalFile = z.object({
  /** Path inside the proposal (a zip's entries may sit in sub-folders). */
  path: z.string(),
  bytes: z.number().int(),
  /** Bytes received so far (equals `bytes` once complete). */
  received: z.number().int(),
  /** SHA-256 (hex), once the proposal was submitted. */
  sha256: z.string().nullable(),
  kind: ProposalFileKind,
});
export type ProposalFile = z.infer<typeof ProposalFile>;

/** Something the admin should look at; never blocks a proposal by itself. */
export const ProposalWarning = z.object({
  code: z.enum(["contains_js", "encrypted", "duplicate", "unreadable_header", "large_media"]),
  message: z.string(),
  /** The file it is about, if any. */
  path: z.string().optional(),
});
export type ProposalWarning = z.infer<typeof ProposalWarning>;

/** What the gateway read from the main file's header. */
export const DictionaryMetadata = z.object({
  /** wuDict format name: mdx, dsl, stardict, slob, bgl, zim. */
  format: z.string(),
  mainFile: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** MDX: GeneratedByEngineVersion. */
  version: z.string().nullable(),
  encoding: z.string().nullable(),
  /** Headword count, when the header says. */
  entries: z.number().int().nullable(),
  /** DSL: index and contents languages. */
  languages: z.string().nullable(),
});
export type DictionaryMetadata = z.infer<typeof DictionaryMetadata>;

export const Proposal = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  licenseNote: z.string().nullable(),
  status: ProposalStatus,
  totalBytes: z.number().int(),
  fileCount: z.number().int(),
  files: z.array(ProposalFile),
  metadata: DictionaryMetadata.nullable(),
  warnings: z.array(ProposalWarning),
  /** The admin's reason (rejected) or note (approved). */
  reviewNote: z.string().nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  approvedScope: ApprovalScope.nullable(),
  /** The dictionary created on approval. */
  dictId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
});
export type Proposal = z.infer<typeof Proposal>;

/** An admin's view adds the proposer. */
export const AdminProposal = Proposal.extend({
  proposer: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  reviewedBy: z.string().nullable(),
});
export type AdminProposal = z.infer<typeof AdminProposal>;

/** Body of GET /app-api/me/proposals, newest first. */
export const ProposalList = z.object({ proposals: z.array(Proposal) });
export type ProposalList = z.infer<typeof ProposalList>;

/** Upload limits, so the PWA can refuse early and size its chunks. */
export const UploadLimits = z.object({
  maxUploadBytes: z.number().int(),
  /** Largest body of one PUT .../files/{index}. */
  chunkBytes: z.number().int(),
  maxFiles: z.number().int(),
  maxPendingProposals: z.number().int(),
  /** File name extensions accepted (lower case, with the dot). */
  extensions: z.array(z.string()),
});
export type UploadLimits = z.infer<typeof UploadLimits>;

/** Body of GET /app-api/proposals/limits. */
export const UploadLimitsResponse = UploadLimits;

/** Body of PUT /app-api/proposals/{id}/files/{index}: bytes stored so far for that file. */
export const ChunkResponse = z.object({ received: z.number().int(), complete: z.boolean() });
export type ChunkResponse = z.infer<typeof ChunkResponse>;

/** A decision the user has not seen yet (GET /app-api/me). */
export const ProposalUpdate = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["approved", "rejected"]),
});
export type ProposalUpdate = z.infer<typeof ProposalUpdate>;

/** Query of GET /app-api/admin/proposals. */
export const AdminProposalQuery = z.object({ status: ProposalStatus.optional() });
export type AdminProposalQuery = z.infer<typeof AdminProposalQuery>;

/** Body of GET /app-api/admin/proposals, newest first. */
export const AdminProposalList = z.object({ proposals: z.array(AdminProposal) });
export type AdminProposalList = z.infer<typeof AdminProposalList>;

/** Body of POST /app-api/admin/proposals/{id}/approve. */
export const ApproveProposalRequest = z.object({
  /** The new dictionary's id, also its folder name. */
  dictId: DictId,
  scope: ApprovalScope,
  /** Allows same-origin rendering (ADR 0006); off unless the admin trusts the content. */
  trustedRender: z.boolean().default(false),
  /** Shown to users; the proposal's title by default. */
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type ApproveProposalRequest = z.input<typeof ApproveProposalRequest>;

/** Body of POST /app-api/admin/proposals/{id}/reject. */
export const RejectProposalRequest = z.object({ note: z.string().trim().min(1).max(2000) });
export type RejectProposalRequest = z.infer<typeof RejectProposalRequest>;
