CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`original_name` text NOT NULL,
	`stored_path` text NOT NULL,
	`kind` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`summary` text,
	`has_pii_warning` integer DEFAULT false NOT NULL,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
