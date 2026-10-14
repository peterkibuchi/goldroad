CREATE TABLE `hosted_publications` (
	`did` text PRIMARY KEY NOT NULL,
	`ident` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hosted_publications_updated_idx` ON `hosted_publications` (`updated_at`);