CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drafts_did_updated_idx` ON `drafts` (`did`,`updated_at`);