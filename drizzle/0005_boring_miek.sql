CREATE TABLE `follower_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`did` text NOT NULL,
	`day` text NOT NULL,
	`followers` integer NOT NULL,
	`posts` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follower_snapshots_did_day_idx` ON `follower_snapshots` (`did`,`day`);