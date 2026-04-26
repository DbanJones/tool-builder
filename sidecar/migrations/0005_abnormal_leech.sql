CREATE TABLE `drift_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`phase` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`resolution` text,
	`commit_hash` text,
	`occurred_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
