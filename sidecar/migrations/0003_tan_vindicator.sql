CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ts` integer NOT NULL,
	`tool` text NOT NULL,
	`raw_input` text NOT NULL,
	`human_line` text,
	`phase` text,
	`task_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
