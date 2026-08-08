ALTER TABLE `reports` ADD `notified_at` integer;--> statement-breakpoint
CREATE INDEX `reports_unnotified_idx` ON `reports` (`created_at`) WHERE "reports"."notified_at" is null;