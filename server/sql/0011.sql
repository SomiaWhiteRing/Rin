CREATE TABLE `__new_friends` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`desc` text,
	`avatar` text NOT NULL,
	`url` text NOT NULL,
	`uid` integer,
	`accepted` integer DEFAULT 0 NOT NULL,
	`health` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`uid`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_friends` (`id`, `name`, `desc`, `avatar`, `url`, `uid`, `accepted`, `health`, `sort_order`, `created_at`, `updated_at`)
SELECT
	`id`,
	`name`,
	`desc`,
	`avatar`,
	`url`,
	`uid`,
	`accepted`,
	`health`,
	`sort_order`,
	`created_at`,
	`updated_at`
FROM `friends`;
--> statement-breakpoint
DROP TABLE `friends`;
--> statement-breakpoint
ALTER TABLE `__new_friends` RENAME TO `friends`;
--> statement-breakpoint
UPDATE `info` SET `value` = '11' WHERE `key` = 'migration_version';
