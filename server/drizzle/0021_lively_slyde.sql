DROP INDEX `atproto_identities_domain_label_unique`;--> statement-breakpoint
ALTER TABLE `atproto_identities` DROP COLUMN `domain_label`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_lower_idx` ON `users` (lower(username));