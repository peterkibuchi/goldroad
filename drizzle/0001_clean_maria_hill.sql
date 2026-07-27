CREATE TABLE `oauth_kv` (
	`k` text PRIMARY KEY NOT NULL,
	`v` text NOT NULL,
	`expires_at` integer
);
