CREATE TABLE `handle_history` (
	`handle` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `handle_history_did_idx` ON `handle_history` (`did`);