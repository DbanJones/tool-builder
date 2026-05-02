CREATE TABLE `research_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scan_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`topic` text NOT NULL,
	`body` text NOT NULL,
	`axis` text,
	`sources` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `research_findings_by_scan` ON `research_findings` (`scan_id`);--> statement-breakpoint
CREATE INDEX `research_findings_by_project` ON `research_findings` (`project_id`,`recorded_at`);