CREATE TABLE `permission_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_summary` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_message` text,
	`requested_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
