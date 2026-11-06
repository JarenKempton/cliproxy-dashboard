CREATE TABLE `pool_peers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`proxy_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pool_peers_name_unique` ON `pool_peers` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `pool_peers_token_hash_unique` ON `pool_peers` (`token_hash`);--> statement-breakpoint
CREATE TABLE `pool_sharing` (
	`pool` text PRIMARY KEY NOT NULL,
	`until` integer
);
