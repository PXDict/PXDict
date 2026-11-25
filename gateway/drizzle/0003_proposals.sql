CREATE TABLE `proposal_files` (
	`proposal_id` text NOT NULL,
	`position` integer NOT NULL,
	`rel_path` text NOT NULL,
	`bytes` integer NOT NULL,
	`received` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`kind` text NOT NULL,
	PRIMARY KEY(`proposal_id`, `rel_path`),
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proposal_files_kind_check" CHECK("proposal_files"."kind" IN ('main', 'companion', 'resource', 'zip'))
);
--> statement-breakpoint
CREATE INDEX `proposal_files_sha256_idx` ON `proposal_files` (`sha256`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`title` text NOT NULL,
	`description` text,
	`source_url` text,
	`license_note` text,
	`status` text NOT NULL,
	`total_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`metadata_json` text,
	`warnings_json` text,
	`review_note` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`approved_scope` text,
	`dict_id` text,
	`decision_seen` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`submitted_at` integer,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "proposals_status_check" CHECK("proposals"."status" IN ('uploading', 'pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "proposals_scope_check" CHECK("proposals"."approved_scope" IS NULL OR "proposals"."approved_scope" IN ('global', 'private', 'hidden'))
);
--> statement-breakpoint
CREATE INDEX `proposals_user_created_idx` ON `proposals` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `proposals_status_idx` ON `proposals` (`status`);