CREATE TABLE `atproto_cursor` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `atproto_identities` (
	`username` text PRIMARY KEY NOT NULL,
	`did` text NOT NULL,
	`handle` text NOT NULL,
	`domain_label` text,
	`pds_url` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `users`(`username`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atproto_identities_did_unique` ON `atproto_identities` (`did`);--> statement-breakpoint
CREATE UNIQUE INDEX `atproto_identities_domain_label_unique` ON `atproto_identities` (`domain_label`);--> statement-breakpoint
CREATE TABLE `atproto_oauth_sessions` (
	`did` text PRIMARY KEY NOT NULL,
	`session` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `atproto_oauth_states` (
	`key` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `atproto_seen` (
	`uri` text PRIMARY KEY NOT NULL,
	`seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `atproto_seen_seen_at_idx` ON `atproto_seen` (`seen_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hanting_feedback` (
	`word_id` integer NOT NULL,
	`variant` integer DEFAULT 0 NOT NULL,
	`username` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`word_id`, `variant`, `username`, `type`),
	FOREIGN KEY (`username`) REFERENCES `users`(`username`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_hanting_feedback`("word_id", "variant", "username", "type", "created_at") SELECT "word_id", "variant", "username", "type", "created_at" FROM `hanting_feedback`;--> statement-breakpoint
DROP TABLE `hanting_feedback`;--> statement-breakpoint
ALTER TABLE `__new_hanting_feedback` RENAME TO `hanting_feedback`;--> statement-breakpoint
PRAGMA foreign_keys=ON;