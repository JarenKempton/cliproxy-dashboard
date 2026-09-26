CREATE TABLE `machine_identities` (
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`machine_id` integer NOT NULL,
	PRIMARY KEY(`kind`, `value`),
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `machines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_name_unique` ON `machines` (`name`);--> statement-breakpoint
CREATE TABLE `price_overrides` (
	`model` text PRIMARY KEY NOT NULL,
	`input_per_mtok` integer NOT NULL,
	`output_per_mtok` integer NOT NULL,
	`cache_read_per_mtok` integer,
	`cache_write_per_mtok` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`requested_model` text,
	`account_ref` text,
	`account_label` text,
	`client_key_hash` text,
	`client_ip` text,
	`user_agent` text,
	`tool` text,
	`session_id` text,
	`endpoint` text,
	`failed` integer NOT NULL,
	`status_code` integer,
	`latency_ms` integer,
	`ttft_ms` integer,
	`input_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`cost_micros` integer,
	`priced_as` text
);
--> statement-breakpoint
CREATE INDEX `requests_occurred_at` ON `requests` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `requests_model` ON `requests` (`model`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `requests_client_key` ON `requests` (`client_key_hash`);--> statement-breakpoint
CREATE INDEX `requests_client_ip` ON `requests` (`client_ip`);