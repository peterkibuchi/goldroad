ALTER TABLE `import_fetches` ADD `kind` text DEFAULT 'feed' NOT NULL;--> statement-breakpoint
CREATE INDEX `import_fetches_did_kind_created_idx` ON `import_fetches` (`did`,`kind`,`created_at`);--> statement-breakpoint
ALTER TABLE `import_items` ADD `source_kind` text DEFAULT 'feed' NOT NULL;