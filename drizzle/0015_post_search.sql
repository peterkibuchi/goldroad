CREATE TABLE `search_backfills` (
	`did` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`did` text NOT NULL,
	`rkey` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_documents_did_rkey_idx` ON `search_documents` (`did`,`rkey`);
--> statement-breakpoint
-- The full-text index over search_documents. External content: the index
-- stores no text of its own, so the nightly backup can skip it (D1 cannot
-- export a virtual table) and a restore rebuilds it from search_documents
-- with: INSERT INTO post_search(post_search) VALUES('rebuild');
-- porter stems English ("running" finds "run"); unicode61 with
-- remove_diacritics 2 folds accents ("cafe" finds "café").
CREATE VIRTUAL TABLE `post_search` USING fts5(
	title,
	description,
	body,
	content='search_documents',
	content_rowid='id',
	tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- An external-content index is only as current as these triggers keep it. A
-- 'delete' has to carry the OLD values, exactly as they were indexed.
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
	INSERT INTO post_search(rowid, title, description, body)
	VALUES (new.id, new.title, new.description, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
	INSERT INTO post_search(post_search, rowid, title, description, body)
	VALUES ('delete', old.id, old.title, old.description, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
	INSERT INTO post_search(post_search, rowid, title, description, body)
	VALUES ('delete', old.id, old.title, old.description, old.body);
	INSERT INTO post_search(rowid, title, description, body)
	VALUES (new.id, new.title, new.description, new.body);
END;
