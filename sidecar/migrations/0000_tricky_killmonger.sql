CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`status` text NOT NULL,
	`current_phase` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text DEFAULT 'novice' NOT NULL,
	`action` text NOT NULL,
	`target_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
