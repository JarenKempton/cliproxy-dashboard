CREATE TABLE `tailnet_devices` (
	`ip` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`dns_name` text,
	`os` text,
	`is_self` integer NOT NULL,
	`online` integer,
	`synced_at` integer NOT NULL
);
