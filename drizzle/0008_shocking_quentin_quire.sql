CREATE TABLE `scheduled_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`draft_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`claimed_at` integer,
	`published_rkey` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_posts_due_idx` ON `scheduled_posts` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `scheduled_posts_did_status_idx` ON `scheduled_posts` (`did`,`status`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_posts_did_draft_pending_idx` ON `scheduled_posts` (`did`,`draft_id`) WHERE "scheduled_posts"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `drafts` ADD `markdown` text DEFAULT '' NOT NULL;