CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`question_id` text NOT NULL,
	`answer_text` text NOT NULL,
	`confidence` text DEFAULT 'tentative' NOT NULL,
	`source` text DEFAULT 'chat' NOT NULL,
	`rationale` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
