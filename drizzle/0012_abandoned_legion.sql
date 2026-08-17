CREATE TABLE `writer_prefs` (
	`did` text PRIMARY KEY NOT NULL,
	`auto_announce` integer DEFAULT true NOT NULL,
	`auto_count` integer DEFAULT 0 NOT NULL,
	`auto_window_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `scheduled_posts` ADD `announce` integer DEFAULT false NOT NULL;