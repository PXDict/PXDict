CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`details_json` text,
	`bytes_freed` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `dictionaries` (
	`id` text PRIMARY KEY NOT NULL,
	`wudict_id` text,
	`wudict_uuid` text,
	`library_dir` text,
	`title` text NOT NULL,
	`format` text,
	`source` text NOT NULL,
	`visibility` text DEFAULT 'hidden' NOT NULL,
	`owner_user_id` text,
	`trusted_render` integer DEFAULT false NOT NULL,
	`source_path` text,
	`source_bytes` integer,
	`index_bytes` integer,
	`media_packed` integer DEFAULT false NOT NULL,
	`source_deleted_at` integer,
	`proposal_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	CONSTRAINT "dictionaries_source_check" CHECK("dictionaries"."source" IN ('builtin', 'proposal')),
	CONSTRAINT "dictionaries_visibility_check" CHECK("dictionaries"."visibility" IN ('global', 'private', 'hidden')),
	CONSTRAINT "dictionaries_private_owner_check" CHECK("dictionaries"."visibility" <> 'private' OR "dictionaries"."owner_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dictionaries_wudict_uuid_unique` ON `dictionaries` (`wudict_uuid`);--> statement-breakpoint
CREATE INDEX `dictionaries_wudict_id_idx` ON `dictionaries` (`wudict_id`);