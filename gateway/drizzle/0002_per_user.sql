CREATE TABLE `favorites` (
	`user_id` text NOT NULL,
	`headword` text NOT NULL,
	`dict_id` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`user_id`, `headword`, `dict_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dict_id`) REFERENCES `dictionaries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `favorites_user_created_idx` ON `favorites` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `search_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`query` text NOT NULL,
	`mode` text NOT NULL,
	`dict_ids_json` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `search_history_user_created_idx` ON `search_history` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_dicts` (
	`user_id` text NOT NULL,
	`dict_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer NOT NULL,
	`is_new` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`user_id`, `dict_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dict_id`) REFERENCES `dictionaries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`history_enabled` integer DEFAULT true NOT NULL,
	`history_retention_days` integer NOT NULL,
	`default_mode` text DEFAULT 'exact' NOT NULL,
	`ui_lang` text,
	`theme` text DEFAULT 'system' NOT NULL,
	`font_size` text DEFAULT 'medium' NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_settings_mode_check" CHECK("user_settings"."default_mode" IN ('exact', 'prefix', 'fts', 'wildcard')),
	CONSTRAINT "user_settings_theme_check" CHECK("user_settings"."theme" IN ('system', 'light', 'dark')),
	CONSTRAINT "user_settings_font_check" CHECK("user_settings"."font_size" IN ('small', 'medium', 'large', 'xlarge')),
	CONSTRAINT "user_settings_retention_check" CHECK("user_settings"."history_retention_days" >= 0)
);
