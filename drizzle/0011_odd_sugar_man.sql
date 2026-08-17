CREATE TABLE `reader_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`writer_did` text NOT NULL,
	`source` text NOT NULL,
	`consented_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reader_emails_writer_email_idx` ON `reader_emails` (`writer_did`,`email`);