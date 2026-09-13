CREATE TABLE `atproto_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`did` text NOT NULL,
	`username` text NOT NULL,
	`kind` text NOT NULL,
	`rkey` text NOT NULL,
	`uri` text NOT NULL,
	`record` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`username`) REFERENCES `users`(`username`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atproto_outbox_uri_kind_unique` ON `atproto_outbox` (`uri`,`kind`);--> statement-breakpoint
CREATE INDEX `atproto_outbox_claim_idx` ON `atproto_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `atproto_identities` ADD `publish_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `atproto_uri` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `atproto_cid` text;--> statement-breakpoint
CREATE UNIQUE INDEX `posts_atproto_uri_unique` ON `posts` (`atproto_uri`);