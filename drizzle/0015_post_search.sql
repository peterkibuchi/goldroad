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
	`owner` text NOT NULL,
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
--
-- `owner` is the writer as one token, matched with every query, so a search
-- reads one writer's postings instead of joining every writer's matches.
-- unicode61 with remove_diacritics 2 folds case and accents ("cafe" finds
-- "café") in any script. No stemmer: every query word of two or more letters
-- matches as a prefix (~/lib/search-query), which finds "gardens" and
-- "gardening" for "garden" in any language, where porter is English-only and
-- stops a half-typed word ("runn") from finding its own full form. The prefix
-- indexes keep the short prefixes from expanding into a scan of every term.
CREATE VIRTUAL TABLE `post_search` USING fts5(
	owner,
	title,
	description,
	body,
	content='search_documents',
	content_rowid='id',
	prefix='2 3',
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- An external-content index is only as current as these triggers keep it. A
-- 'delete' has to carry the OLD values, exactly as they were indexed.
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
	INSERT INTO post_search(rowid, owner, title, description, body)
	VALUES (new.id, new.owner, new.title, new.description, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
	INSERT INTO post_search(post_search, rowid, owner, title, description, body)
	VALUES ('delete', old.id, old.owner, old.title, old.description, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
	INSERT INTO post_search(post_search, rowid, owner, title, description, body)
	VALUES ('delete', old.id, old.owner, old.title, old.description, old.body);
	INSERT INTO post_search(rowid, owner, title, description, body)
	VALUES (new.id, new.owner, new.title, new.description, new.body);
END;
