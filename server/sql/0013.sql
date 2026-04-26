ALTER TABLE `image_assets` ADD COLUMN `favorite` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `info` SET `value` = '13' WHERE `key` = 'migration_version';
