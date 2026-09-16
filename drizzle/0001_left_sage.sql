PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`workspace_id` text,
	`action` text NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`entity_type` text,
	`entity_id` text,
	`ticket_id` text,
	`workflow_id` text,
	`run_id` text,
	`job_id` text,
	`file_id` text,
	`approval_id` text,
	`summary` text,
	`data` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`("seq", "id", "workspace_id", "action", "actor_type", "actor_id", "actor_label", "entity_type", "entity_id", "ticket_id", "workflow_id", "run_id", "job_id", "file_id", "approval_id", "summary", "data", "occurred_at", "created_at") SELECT "seq", "id", "workspace_id", "action", "actor_type", "actor_id", "actor_label", "entity_type", "entity_id", "ticket_id", "workflow_id", "run_id", "job_id", "file_id", "approval_id", "summary", "data", "occurred_at", "created_at" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_id_unique` ON `audit_events` (`id`);--> statement-breakpoint
CREATE INDEX `audit_events_ticket_idx` ON `audit_events` (`workspace_id`,`ticket_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`workspace_id`,`action`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`workspace_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_run_idx` ON `audit_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_file_idx` ON `audit_events` (`workspace_id`,`file_id`,`seq`);