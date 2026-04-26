CREATE TABLE `image_assets` (
	`id` integer PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`storage_key` text,
	`source` text DEFAULT 'article' NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`content_type` text DEFAULT '' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`width` integer,
	`height` integer,
	`blurhash` text DEFAULT '' NOT NULL,
	`compression_status` text DEFAULT 'idle' NOT NULL,
	`compression_error` text DEFAULT '' NOT NULL,
	`original_size` integer,
	`compressed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_assets_url_unique` ON `image_assets` (`url`);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_assets_storage_key_unique` ON `image_assets` (`storage_key`);
--> statement-breakpoint
CREATE TABLE `image_usages` (
	`id` integer PRIMARY KEY NOT NULL,
	`asset_id` integer NOT NULL,
	`feed_id` integer NOT NULL,
	`raw_url` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `image_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `feeds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_usages_asset_feed_unique` ON `image_usages` (`asset_id`,`feed_id`);
--> statement-breakpoint
UPDATE `info` SET `value` = '12' WHERE `key` = 'migration_version';
