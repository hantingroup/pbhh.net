ALTER TABLE `atproto_identities` ADD `sync_likes_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `post_likes` ADD `atproto_uri` text;--> statement-breakpoint
CREATE UNIQUE INDEX `post_likes_atproto_uri_unique` ON `post_likes` (`atproto_uri`);