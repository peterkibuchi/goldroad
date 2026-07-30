CREATE TABLE `backup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_runs_at_idx` ON `backup_runs` (`at`);
