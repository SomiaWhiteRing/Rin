CREATE TABLE `__new_comments` (
	`id` integer PRIMARY KEY NOT NULL,
	`feed_id` integer NOT NULL,
	`user_id` integer,
	`author_name` text NOT NULL,
	`author_avatar` text,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_comments` (`id`, `feed_id`, `user_id`, `author_name`, `author_avatar`, `content`, `created_at`, `updated_at`)
SELECT
	`comments`.`id`,
	`comments`.`feed_id`,
	`comments`.`user_id`,
	COALESCE(`users`.`username`, 'Anonymous'),
	`users`.`avatar`,
	`comments`.`content`,
	`comments`.`created_at`,
	`comments`.`updated_at`
FROM `comments`
LEFT JOIN `users` ON `users`.`id` = `comments`.`user_id`;
--> statement-breakpoint
DROP TABLE `comments`;
--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;
--> statement-breakpoint
UPDATE `info` SET `value` = '10' WHERE `key` = 'migration_version';
