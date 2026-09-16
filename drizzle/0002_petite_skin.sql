CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`url` text NOT NULL,
	`transport` text DEFAULT 'http' NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_config` text,
	`default_headers` text,
	`timeout_ms` integer DEFAULT 15000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_discovered_at` integer,
	`last_error` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `mcp_servers_workspace_idx` ON `mcp_servers` (`workspace_id`,`archived_at`);