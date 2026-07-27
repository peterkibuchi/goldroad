CREATE TABLE `import_fetches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`did` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_fetches_did_created_idx` ON `import_fetches` (`did`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_items` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`guid_hash` text NOT NULL,
	`source_url` text,
	`original_at` integer,
	`draft_id` text,
	`published_rkey` text,
	`adopted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_items_did_guid_idx` ON `import_items` (`did`,`guid_hash`);--> statement-breakpoint
CREATE INDEX `import_items_did_draft_idx` ON `import_items` (`did`,`draft_id`);--> statement-breakpoint
CREATE INDEX `import_items_did_rkey_idx` ON `import_items` (`did`,`published_rkey`);