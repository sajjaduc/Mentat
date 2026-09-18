CREATE TABLE `agent_state` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope` text NOT NULL,
	`workflow_id` text,
	`workflow_item_id` text,
	`agent_id` text,
	`run_id` text,
	`namespace` text DEFAULT 'default' NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`created_by_type` text,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_state_unique` ON `agent_state` (`workspace_id`,`scope`,`workflow_id`,`workflow_item_id`,`agent_id`,`run_id`,`namespace`,`key`);--> statement-breakpoint
CREATE INDEX `agent_state_lookup_idx` ON `agent_state` (`workspace_id`,`scope`,`namespace`);--> statement-breakpoint
CREATE TABLE `agent_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tools_unique` ON `agent_tools` (`agent_id`,`tool_id`);--> statement-breakpoint
CREATE TABLE `agent_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`change_note` text,
	`created_by_type` text,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_versions_unique` ON `agent_versions` (`agent_id`,`version`);--> statement-breakpoint
CREATE INDEX `agent_versions_agent_idx` ON `agent_versions` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text,
	`source_agent_id` text,
	`binding_mode` text DEFAULT 'use_asis' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`instructions` text DEFAULT '' NOT NULL,
	`provider_id` text,
	`model_id` text,
	`skill_ids` text,
	`tool_ids` text,
	`output_schema` text,
	`execution_config` text,
	`permissions` text,
	`current_version_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`workspace_id`,`workflow_id`,`name`);--> statement-breakpoint
CREATE INDEX `agents_workspace_idx` ON `agents` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`examples` text,
	`references` text,
	`recommended_tool_keys` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_versions_unique` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text,
	`source_skill_id` text,
	`binding_mode` text DEFAULT 'use_asis' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`current_version_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`workspace_id`,`workflow_id`,`name`);--> statement-breakpoint
CREATE INDEX `skills_workspace_idx` ON `skills` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`implementation` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`permissions` text,
	`timeout_seconds` integer DEFAULT 30 NOT NULL,
	`retry_policy` text,
	`approval_policy` text,
	`cache_policy` text,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tools_key_unique` ON `tools` (`workspace_id`,`key`);--> statement-breakpoint
CREATE INDEX `tools_workspace_idx` ON `tools` (`workspace_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `dashboard_widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`dashboard_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`size` text DEFAULT 'md' NOT NULL,
	`data_source` text NOT NULL,
	`filter` text,
	`measure` text NOT NULL,
	`grouping` text,
	`time_range` text,
	`visualization` text,
	`saved_view_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dashboard_widgets_dashboard_idx` ON `dashboard_widgets` (`dashboard_id`,`position`);--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`global_filters` text,
	`layout` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_shared` integer DEFAULT true NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_name_unique` ON `dashboards` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `dashboards_workspace_idx` ON `dashboards` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`workspace_id` text,
	`action` text NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`entity_type` text,
	`entity_id` text,
	`record_id` text,
	`workflow_item_id` text,
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
CREATE UNIQUE INDEX `audit_events_id_unique` ON `audit_events` (`id`);--> statement-breakpoint
CREATE INDEX `audit_events_record_idx` ON `audit_events` (`workspace_id`,`record_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_workflow_item_idx` ON `audit_events` (`workspace_id`,`workflow_item_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`workspace_id`,`action`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`workspace_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_events_workspace_idx` ON `audit_events` (`workspace_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_run_idx` ON `audit_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_file_idx` ON `audit_events` (`workspace_id`,`file_id`,`seq`);--> statement-breakpoint
CREATE TABLE `cache_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`namespace` text DEFAULT 'default' NOT NULL,
	`key` text NOT NULL,
	`auth_scope` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`tags` text,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_accessed_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cache_entries_unique` ON `cache_entries` (`workspace_id`,`namespace`,`auth_scope`,`key`);--> statement-breakpoint
CREATE INDEX `cache_entries_expiry_idx` ON `cache_entries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `cache_entries_ns_idx` ON `cache_entries` (`workspace_id`,`namespace`);--> statement-breakpoint
CREATE TABLE `cache_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`namespace` text NOT NULL,
	`auth_scope` text DEFAULT '' NOT NULL,
	`key` text NOT NULL,
	`holder` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cache_locks_unique` ON `cache_locks` (`workspace_id`,`namespace`,`auth_scope`,`key`);--> statement-breakpoint
CREATE INDEX `cache_locks_expiry_idx` ON `cache_locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `collection_records` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`collection_id` text NOT NULL,
	`external_key` text,
	`data` text NOT NULL,
	`search_text` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_type` text,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collection_records_collection_idx` ON `collection_records` (`workspace_id`,`collection_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `collection_records_external_unique` ON `collection_records` (`collection_id`,`external_key`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`schema` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_key_unique` ON `collections` (`workspace_id`,`workflow_id`,`key`);--> statement-breakpoint
CREATE INDEX `collections_workspace_idx` ON `collections` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `environment_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope` text DEFAULT 'workspace' NOT NULL,
	`workflow_id` text,
	`source_variable_id` text,
	`binding_mode` text DEFAULT 'use_asis' NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`secret_id` text,
	`is_secret` integer DEFAULT false NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_variables_unique` ON `environment_variables` (`workspace_id`,`workflow_id`,`key`);--> statement-breakpoint
CREATE INDEX `environment_variables_workspace_idx` ON `environment_variables` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope` text DEFAULT 'workspace' NOT NULL,
	`workflow_id` text,
	`source_secret_id` text,
	`binding_mode` text DEFAULT 'use_asis' NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`algorithm` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`last_four` text,
	`value_length` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`rotated_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_key_unique` ON `secrets` (`workspace_id`,`workflow_id`,`key`);--> statement-breakpoint
CREATE INDEX `secrets_workspace_idx` ON `secrets` (`workspace_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `workspace_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`source_resource_id` text,
	`mode` text NOT NULL,
	`overridden_fields` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_overrides_unique` ON `workspace_overrides` (`workspace_id`,`workflow_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `workspace_overrides_lookup_idx` ON `workspace_overrides` (`workspace_id`,`resource_type`);--> statement-breakpoint
CREATE TABLE `workspace_storage_config` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text DEFAULT 'local' NOT NULL,
	`bucket` text,
	`prefix` text,
	`credentials_secret_id` text,
	`local_root` text,
	`config` text,
	`max_file_bytes` integer DEFAULT 52428800 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credentials_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_storage_config_unique` ON `workspace_storage_config` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `agent_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'completed' NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`tool_id` text,
	`tool_key` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`metadata` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_steps_unique` ON `agent_run_steps` (`run_id`,`step_index`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`record_id` text,
	`workflow_item_id` text,
	`workflow_id` text NOT NULL,
	`state_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version_id` text NOT NULL,
	`agent_version` integer DEFAULT 1 NOT NULL,
	`provider_id` text,
	`provider_type` text,
	`model_id` text,
	`model_key` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`job_id` text,
	`trigger_type` text DEFAULT 'state_entry' NOT NULL,
	`trigger_id` text,
	`input_snapshot` text,
	`context_config` text,
	`prompt_version` text,
	`output` text,
	`output_text` text,
	`usage` text,
	`cache_status` text,
	`requested_transition_id` text,
	`applied_transition_id` text,
	`error` text,
	`error_code` text,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_record_idx` ON `agent_runs` (`workspace_id`,`record_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_workflow_item_idx` ON `agent_runs` (`workspace_id`,`workflow_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_idx` ON `agent_runs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_agent_idx` ON `agent_runs` (`workspace_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`record_id` text,
	`workflow_item_id` text,
	`workflow_id` text,
	`run_id` text,
	`step_id` text,
	`job_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`requested_action` text NOT NULL,
	`context_snapshot` text,
	`requested_by_type` text NOT NULL,
	`requested_by_id` text,
	`requested_by_label` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_user_id` text,
	`reviewer_team_id` text,
	`decided_by_user_id` text,
	`decided_by_label` text,
	`decision_comment` text,
	`decision` text,
	`resume_token` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `approval_requests_status_idx` ON `approval_requests` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `approval_requests_workflow_item_idx` ON `approval_requests` (`workspace_id`,`workflow_item_id`);--> statement-breakpoint
CREATE INDEX `approval_requests_run_idx` ON `approval_requests` (`run_id`);--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`worker_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`error` text,
	`error_code` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_unique` ON `job_attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `job_attempts_job_idx` ON `job_attempts` (`job_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`queue` text DEFAULT 'default' NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`available_at` integer NOT NULL,
	`leased_at` integer,
	`leased_by` text,
	`lease_expires_at` integer,
	`last_error` text,
	`last_error_code` text,
	`result` text,
	`timeout_seconds` integer,
	`dedupe_key` text,
	`idempotency_key` text,
	`record_id` text,
	`workflow_item_id` text,
	`run_id` text,
	`parent_job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`status`,`queue`,`available_at`,`priority`);--> statement-breakpoint
CREATE INDEX `jobs_dedupe_idx` ON `jobs` (`workspace_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `jobs_workflow_item_idx` ON `jobs` (`workspace_id`,`workflow_item_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`workspace_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`run_id` text,
	`record_id` text,
	`workflow_item_id` text,
	`type` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_id_unique` ON `run_events` (`id`);--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `run_events_record_idx` ON `run_events` (`workspace_id`,`record_id`,`seq`);--> statement-breakpoint
CREATE INDEX `run_events_workflow_item_idx` ON `run_events` (`workspace_id`,`workflow_item_id`,`seq`);--> statement-breakpoint
CREATE TABLE `field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`scope` text NOT NULL,
	`options` text,
	`default_value` text,
	`validation` text,
	`display` text,
	`is_system` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_definitions_unique` ON `field_definitions` (`workspace_id`,`scope`,`key`);--> statement-breakpoint
CREATE INDEX `field_definitions_scope_idx` ON `field_definitions` (`workspace_id`,`scope`);--> statement-breakpoint
CREATE TABLE `field_value_history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`workflow_id` text,
	`previous_value` text,
	`new_value` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`run_id` text,
	`source` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `field_value_history_owner_idx` ON `field_value_history` (`workspace_id`,`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `field_value_history_field_idx` ON `field_value_history` (`workspace_id`,`field_definition_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `file_field_values` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`workflow_id` text,
	`field_definition_id` text NOT NULL,
	`confidence` real,
	`source_page` integer,
	`source_span` text,
	`value_text` text,
	`value_number` real,
	`value_bool` integer,
	`value_date` integer,
	`value_json` text,
	`search_text` text,
	`updated_by_type` text,
	`updated_by_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_field_values_unique` ON `file_field_values` (`file_id`,`workflow_id`,`field_definition_id`);--> statement-breakpoint
CREATE INDEX `file_field_values_text_idx` ON `file_field_values` (`workspace_id`,`field_definition_id`,`value_text`);--> statement-breakpoint
CREATE INDEX `file_field_values_file_idx` ON `file_field_values` (`workspace_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `workflow_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`editable` integer DEFAULT true NOT NULL,
	`default_value` text,
	`required_in_states` text,
	`show_on_card` integer DEFAULT false NOT NULL,
	`show_in_list` integer DEFAULT true NOT NULL,
	`filterable` integer DEFAULT true NOT NULL,
	`required_for_transfer` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_fields_unique` ON `workflow_fields` (`workflow_id`,`field_definition_id`);--> statement-breakpoint
CREATE INDEX `workflow_fields_workspace_idx` ON `workflow_fields` (`workspace_id`,`workflow_id`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`size` integer NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`storage_provider` text NOT NULL,
	`storage_key` text NOT NULL,
	`verified_at` integer,
	`orphaned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blobs_workspace_hash_unique` ON `blobs` (`workspace_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `blobs_workspace_idx` ON `blobs` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `file_extracted_content` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`processing_run_id` text NOT NULL,
	`content_kind` text DEFAULT 'text' NOT NULL,
	`text` text NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`page_count` integer,
	`language` text,
	`segments` text,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`processing_run_id`) REFERENCES `file_processing_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_extracted_content_unique` ON `file_extracted_content` (`processing_run_id`);--> statement-breakpoint
CREATE INDEX `file_extracted_content_file_idx` ON `file_extracted_content` (`workspace_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `file_processing_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`workflow_id` text,
	`processor_type` text NOT NULL,
	`processor_version` text NOT NULL,
	`configuration_fingerprint` text NOT NULL,
	`processing_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`job_id` text,
	`provider_id` text,
	`model_id` text,
	`result_summary` text,
	`error` text,
	`error_code` text,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_processing_runs_key_unique` ON `file_processing_runs` (`file_id`,`processing_key`);--> statement-breakpoint
CREATE INDEX `file_processing_runs_file_idx` ON `file_processing_runs` (`workspace_id`,`file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_processing_runs_status_idx` ON `file_processing_runs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `file_records` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`record_id` text NOT NULL,
	`relationship` text DEFAULT 'attachment' NOT NULL,
	`caption` text,
	`added_by_type` text,
	`added_by_id` text,
	`added_by_label` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_records_unique` ON `file_records` (`file_id`,`record_id`,`relationship`);--> statement-breakpoint
CREATE INDEX `file_records_record_idx` ON `file_records` (`workspace_id`,`record_id`,`removed_at`);--> statement-breakpoint
CREATE INDEX `file_records_file_idx` ON `file_records` (`workspace_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `file_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_reference` text,
	`source_label` text,
	`actor_type` text,
	`actor_id` text,
	`actor_label` text,
	`run_id` text,
	`tool_call_id` text,
	`trigger_event_id` text,
	`deduplicated` integer DEFAULT false NOT NULL,
	`observed_content_hash` text,
	`detail` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_sources_file_idx` ON `file_sources` (`workspace_id`,`file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_sources_type_idx` ON `file_sources` (`workspace_id`,`source_type`);--> statement-breakpoint
CREATE TABLE `file_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`processing_run_id` text,
	`summary` text NOT NULL,
	`provider_id` text,
	`model_id` text,
	`prompt_version` text,
	`is_current` integer DEFAULT true NOT NULL,
	`edited_by_type` text,
	`edited_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`processing_run_id`) REFERENCES `file_processing_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `file_summaries_file_idx` ON `file_summaries` (`workspace_id`,`file_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `file_workflow_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_id` text NOT NULL,
	`workflow_item_id` text NOT NULL,
	`relationship` text DEFAULT 'attachment' NOT NULL,
	`caption` text,
	`added_by_type` text,
	`added_by_id` text,
	`added_by_label` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_workflow_items_unique` ON `file_workflow_items` (`file_id`,`workflow_item_id`,`relationship`);--> statement-breakpoint
CREATE INDEX `file_workflow_items_item_idx` ON `file_workflow_items` (`workspace_id`,`workflow_item_id`,`removed_at`);--> statement-breakpoint
CREATE INDEX `file_workflow_items_file_idx` ON `file_workflow_items` (`workspace_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`blob_id` text NOT NULL,
	`original_filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text DEFAULT 'upload' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`summary` text,
	`metadata` text,
	`primary_workflow_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_type` text DEFAULT 'user' NOT NULL,
	`created_by_id` text,
	`created_by_label` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_id`) REFERENCES `blobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `files_workspace_idx` ON `files` (`workspace_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `files_blob_idx` ON `files` (`blob_id`);--> statement-breakpoint
CREATE INDEX `files_status_idx` ON `files` (`workspace_id`,`status`);--> statement-breakpoint
CREATE TABLE `workflow_files` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`file_id` text NOT NULL,
	`context_label` text,
	`metadata` text,
	`added_by_type` text,
	`added_by_id` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_files_unique` ON `workflow_files` (`workflow_id`,`file_id`);--> statement-breakpoint
CREATE INDEX `workflow_files_workflow_idx` ON `workflow_files` (`workspace_id`,`workflow_id`,`removed_at`);--> statement-breakpoint
CREATE TABLE `http_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`service_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`parameters` text,
	`headers` text,
	`body` text,
	`input_schema` text,
	`output_schema` text,
	`success_rules` text,
	`response_mapping` text,
	`timeout_ms` integer,
	`retry_policy` text,
	`cache_policy` text,
	`approval_policy` text,
	`rate_limit_override` text,
	`expose_as_tool` integer DEFAULT true NOT NULL,
	`tool_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `http_services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `http_operations_key_unique` ON `http_operations` (`workspace_id`,`key`);--> statement-breakpoint
CREATE INDEX `http_operations_service_idx` ON `http_operations` (`service_id`,`position`);--> statement-breakpoint
CREATE TABLE `http_request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`service_id` text NOT NULL,
	`operation_id` text,
	`run_id` text,
	`step_id` text,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_headers` text,
	`request_body` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`response_status` integer,
	`response_headers` text,
	`response_body_preview` text,
	`response_bytes` integer,
	`latency_ms` integer,
	`cache_status` text,
	`from_test_console` integer DEFAULT false NOT NULL,
	`error` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `http_request_logs_service_idx` ON `http_request_logs` (`workspace_id`,`service_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `http_request_logs_run_idx` ON `http_request_logs` (`run_id`);--> statement-breakpoint
CREATE TABLE `http_services` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text,
	`source_service_id` text,
	`binding_mode` text DEFAULT 'use_asis' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_url` text NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_config` text,
	`default_headers` text,
	`timeout_ms` integer DEFAULT 15000 NOT NULL,
	`retry_policy` text,
	`cache_policy` text,
	`rate_limit` text,
	`default_approval_policy` text,
	`allowed_hosts` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `http_services_name_unique` ON `http_services` (`workspace_id`,`workflow_id`,`name`);--> statement-breakpoint
CREATE INDEX `http_services_workspace_idx` ON `http_services` (`workspace_id`,`archived_at`);--> statement-breakpoint
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
CREATE INDEX `mcp_servers_workspace_idx` ON `mcp_servers` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_key` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`family` text,
	`parameter_size` text,
	`quantization` text,
	`capabilities` text,
	`context_window` integer,
	`max_output_tokens` integer,
	`inference_defaults` text,
	`input_cost_per_mtokens_cents` real,
	`output_cost_per_mtokens_cents` real,
	`enabled` integer DEFAULT true NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`discovered` integer DEFAULT false NOT NULL,
	`discovered_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_key_unique` ON `models` (`provider_id`,`model_key`);--> statement-breakpoint
CREATE INDEX `models_workspace_idx` ON `models` (`workspace_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `provider_health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`message` text,
	`model_count` integer,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_health_checks_idx` ON `provider_health_checks` (`provider_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text,
	`api_key_secret_id` text,
	`config` text,
	`enabled` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`health_message` text,
	`health_checked_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_unique` ON `providers` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `providers_workspace_idx` ON `providers` (`workspace_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `object_type_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`object_type_id` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`is_identity` integer DEFAULT false NOT NULL,
	`is_primary_display` integer DEFAULT false NOT NULL,
	`is_secondary_display` integer DEFAULT false NOT NULL,
	`show_in_list` integer DEFAULT true NOT NULL,
	`show_on_card` integer DEFAULT false NOT NULL,
	`filterable` integer DEFAULT true NOT NULL,
	`default_value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `object_type_fields_unique` ON `object_type_fields` (`object_type_id`,`field_definition_id`);--> statement-breakpoint
CREATE INDEX `object_type_fields_object_idx` ON `object_type_fields` (`workspace_id`,`object_type_id`,`position`);--> statement-breakpoint
CREATE TABLE `object_types` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`plural_name` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`settings` text,
	`is_system` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `object_types_key_unique` ON `object_types` (`workspace_id`,`key`);--> statement-breakpoint
CREATE INDEX `object_types_workspace_idx` ON `object_types` (`workspace_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `record_external_ids` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`record_id` text NOT NULL,
	`system` text NOT NULL,
	`external_id` text NOT NULL,
	`label` text,
	`url` text,
	`metadata` text,
	`created_by_type` text,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_external_ids_unique` ON `record_external_ids` (`workspace_id`,`system`,`external_id`);--> statement-breakpoint
CREATE INDEX `record_external_ids_record_idx` ON `record_external_ids` (`workspace_id`,`record_id`);--> statement-breakpoint
CREATE TABLE `record_field_values` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`record_id` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`value_text` text,
	`value_number` real,
	`value_bool` integer,
	`value_date` integer,
	`value_json` text,
	`search_text` text,
	`updated_by_type` text,
	`updated_by_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_field_values_unique` ON `record_field_values` (`record_id`,`field_definition_id`);--> statement-breakpoint
CREATE INDEX `record_field_values_text_idx` ON `record_field_values` (`workspace_id`,`field_definition_id`,`value_text`);--> statement-breakpoint
CREATE INDEX `record_field_values_number_idx` ON `record_field_values` (`workspace_id`,`field_definition_id`,`value_number`);--> statement-breakpoint
CREATE INDEX `record_field_values_date_idx` ON `record_field_values` (`workspace_id`,`field_definition_id`,`value_date`);--> statement-breakpoint
CREATE INDEX `record_field_values_record_idx` ON `record_field_values` (`workspace_id`,`record_id`);--> statement-breakpoint
CREATE TABLE `record_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`object_type_id` text NOT NULL,
	`sections` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_layouts_unique` ON `record_layouts` (`object_type_id`);--> statement-breakpoint
CREATE TABLE `record_note_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`note_id` text NOT NULL,
	`body` text NOT NULL,
	`edited_by_type` text,
	`edited_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `record_notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_note_revisions_note_idx` ON `record_note_revisions` (`note_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `record_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`record_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text,
	`author_label` text,
	`body` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`edited_by_type` text,
	`edited_by_id` text,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_notes_record_idx` ON `record_notes` (`workspace_id`,`record_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `record_relationship_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_object_type_id` text NOT NULL,
	`target_object_type_id` text,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`inverse_name` text NOT NULL,
	`cardinality` text DEFAULT 'many_to_many' NOT NULL,
	`description` text,
	`is_system` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_object_type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_object_type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_relationship_definitions_unique` ON `record_relationship_definitions` (`workspace_id`,`source_object_type_id`,`key`);--> statement-breakpoint
CREATE INDEX `record_relationship_definitions_source_idx` ON `record_relationship_definitions` (`workspace_id`,`source_object_type_id`);--> statement-breakpoint
CREATE TABLE `record_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`from_record_id` text NOT NULL,
	`to_record_id` text NOT NULL,
	`note` text,
	`metadata` text,
	`created_by_type` text NOT NULL,
	`created_by_id` text,
	`created_by_label` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`definition_id`) REFERENCES `record_relationship_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_relationships_unique` ON `record_relationships` (`from_record_id`,`to_record_id`,`definition_id`);--> statement-breakpoint
CREATE INDEX `record_relationships_from_idx` ON `record_relationships` (`workspace_id`,`from_record_id`);--> statement-breakpoint
CREATE INDEX `record_relationships_to_idx` ON `record_relationships` (`workspace_id`,`to_record_id`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`object_type_id` text NOT NULL,
	`display_name` text NOT NULL,
	`key` text,
	`number` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_type` text DEFAULT 'user' NOT NULL,
	`created_by_id` text,
	`created_by_label` text,
	`provenance` text,
	`structured_data` text,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	`archived_by_type` text,
	`archived_by_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_key_unique` ON `records` (`workspace_id`,`object_type_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `records_number_unique` ON `records` (`workspace_id`,`object_type_id`,`number`);--> statement-breakpoint
CREATE INDEX `records_object_idx` ON `records` (`workspace_id`,`object_type_id`,`archived_at`);--> statement-breakpoint
CREATE INDEX `records_display_idx` ON `records` (`workspace_id`,`object_type_id`,`display_name`);--> statement-breakpoint
CREATE INDEX `records_updated_idx` ON `records` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text,
	`last_used_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `counters` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `counters_unique` ON `counters` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_fingerprint` text,
	`status` text NOT NULL,
	`response` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_keys_unique` ON `idempotency_keys` (`workspace_id`,`scope`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_expiry_idx` ON `idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`active_workspace_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`user_agent` text,
	`ip_address` text,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_unique` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_workspace_name_unique` ON `teams` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`avatar_color` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`is_platform_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_unique` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`settings` text,
	`storage_provider` text DEFAULT 'local' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE TABLE `trigger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`trigger_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`source` text,
	`payload` text,
	`payload_bytes` integer,
	`record_id` text,
	`workflow_item_id` text,
	`job_id` text,
	`error` text,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trigger_events_idempotency_unique` ON `trigger_events` (`trigger_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `trigger_events_trigger_idx` ON `trigger_events` (`workspace_id`,`trigger_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`webhook_token` text,
	`config` text,
	`target_state_id` text,
	`upsert_on_dedupe` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`last_fired_at` integer,
	`next_run_at` integer,
	`last_error` text,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_name_unique` ON `triggers` (`workspace_id`,`workflow_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_token_unique` ON `triggers` (`webhook_token`);--> statement-breakpoint
CREATE INDEX `triggers_schedule_idx` ON `triggers` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `triggers_workspace_idx` ON `triggers` (`workspace_id`,`workflow_id`);--> statement-breakpoint
CREATE TABLE `workflow_item_field_values` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_item_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`value_text` text,
	`value_number` real,
	`value_bool` integer,
	`value_date` integer,
	`value_json` text,
	`search_text` text,
	`updated_by_type` text,
	`updated_by_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_definition_id`) REFERENCES `field_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_item_field_values_unique` ON `workflow_item_field_values` (`workflow_item_id`,`field_definition_id`);--> statement-breakpoint
CREATE INDEX `workflow_item_field_values_text_idx` ON `workflow_item_field_values` (`workspace_id`,`field_definition_id`,`value_text`);--> statement-breakpoint
CREATE INDEX `workflow_item_field_values_item_idx` ON `workflow_item_field_values` (`workspace_id`,`workflow_item_id`);--> statement-breakpoint
CREATE TABLE `workflow_item_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_item_id` text NOT NULL,
	`label_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_item_labels_unique` ON `workflow_item_labels` (`workflow_item_id`,`label_id`);--> statement-breakpoint
CREATE INDEX `workflow_item_labels_label_idx` ON `workflow_item_labels` (`workspace_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `workflow_item_note_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`note_id` text NOT NULL,
	`body` text NOT NULL,
	`edited_by_type` text,
	`edited_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `workflow_item_notes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_item_note_revisions_note_idx` ON `workflow_item_note_revisions` (`note_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_item_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_item_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text,
	`author_label` text,
	`body` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`edited_by_type` text,
	`edited_by_id` text,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_item_notes_item_idx` ON `workflow_item_notes` (`workspace_id`,`workflow_item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_item_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`from_workflow_item_id` text NOT NULL,
	`to_workflow_item_id` text NOT NULL,
	`type` text NOT NULL,
	`note` text,
	`created_by_type` text NOT NULL,
	`created_by_id` text,
	`created_by_label` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_item_relationships_unique` ON `workflow_item_relationships` (`from_workflow_item_id`,`to_workflow_item_id`,`type`);--> statement-breakpoint
CREATE INDEX `workflow_item_relationships_from_idx` ON `workflow_item_relationships` (`workspace_id`,`from_workflow_item_id`);--> statement-breakpoint
CREATE INDEX `workflow_item_relationships_to_idx` ON `workflow_item_relationships` (`workspace_id`,`to_workflow_item_id`);--> statement-breakpoint
CREATE TABLE `workflow_item_state_history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_item_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`state_id` text NOT NULL,
	`state_name` text NOT NULL,
	`state_kind` text NOT NULL,
	`previous_state_id` text,
	`entered_at` integer NOT NULL,
	`exited_at` integer,
	`duration_ms` integer,
	`entered_by_type` text NOT NULL,
	`entered_by_id` text,
	`entered_by_label` text,
	`run_id` text,
	`transition_id` text,
	`reason` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_item_state_history_item_idx` ON `workflow_item_state_history` (`workspace_id`,`workflow_item_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `workflow_item_state_history_state_idx` ON `workflow_item_state_history` (`workspace_id`,`state_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `workflow_item_state_history_open_idx` ON `workflow_item_state_history` (`workflow_item_id`,`exited_at`);--> statement-breakpoint
CREATE TABLE `workflow_item_workflow_history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_workflow_id` text,
	`from_state_id` text,
	`to_workflow_id` text NOT NULL,
	`to_state_id` text NOT NULL,
	`source_workflow_item_id` text,
	`reason` text,
	`field_mappings_applied` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`run_id` text,
	`approval_request_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_item_workflow_history_item_idx` ON `workflow_item_workflow_history` (`workspace_id`,`workflow_item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`record_id` text NOT NULL,
	`state_id` text NOT NULL,
	`owner_user_id` text,
	`owner_team_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`structured_data` text,
	`origin_workflow_item_id` text,
	`source_workflow_item_id` text,
	`participation` text DEFAULT 'primary' NOT NULL,
	`created_by_type` text DEFAULT 'user' NOT NULL,
	`created_by_id` text,
	`created_by_label` text,
	`provenance` text,
	`entered_state_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`due_at` integer,
	`sla_due_at` integer,
	`closed_at` integer,
	`completed_at` integer,
	`state_run_count` integer DEFAULT 0 NOT NULL,
	`waiting_on` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`origin_workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_workflow_item_id`) REFERENCES `workflow_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_items_board_idx` ON `workflow_items` (`workspace_id`,`workflow_id`,`state_id`);--> statement-breakpoint
CREATE INDEX `workflow_items_record_idx` ON `workflow_items` (`workspace_id`,`record_id`);--> statement-breakpoint
CREATE INDEX `workflow_items_owner_idx` ON `workflow_items` (`workspace_id`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `workflow_items_state_entered_idx` ON `workflow_items` (`workspace_id`,`state_id`,`entered_state_at`);--> statement-breakpoint
CREATE INDEX `workflow_items_updated_idx` ON `workflow_items` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_items_waiting_idx` ON `workflow_items` (`workspace_id`,`waiting_on`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_unique` ON `labels` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'workflowItems' NOT NULL,
	`workflow_id` text,
	`filter_ast` text,
	`sort` text,
	`columns` text,
	`is_shared` integer DEFAULT true NOT NULL,
	`is_pinned` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `saved_views_scope_idx` ON `saved_views` (`workspace_id`,`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_unique` ON `saved_views` (`workspace_id`,`scope`,`name`);--> statement-breakpoint
CREATE TABLE `workflow_states` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'manual' NOT NULL,
	`category` text DEFAULT 'active' NOT NULL,
	`color` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_start` integer DEFAULT false NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	`agent_id` text,
	`agent_version_id` text,
	`auto_execute` integer DEFAULT true NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`timeout_seconds` integer,
	`failure_state_id` text,
	`human_gate` text,
	`config` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_states_name_unique` ON `workflow_states` (`workflow_id`,`name`);--> statement-breakpoint
CREATE INDEX `workflow_states_workflow_idx` ON `workflow_states` (`workspace_id`,`workflow_id`,`position`);--> statement-breakpoint
CREATE TABLE `workflow_transfer_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source_workflow_id` text NOT NULL,
	`target_workflow_id` text NOT NULL,
	`default_target_state_id` text,
	`field_mappings` text,
	`required_target_field_keys` text,
	`allow_agents` integer DEFAULT true NOT NULL,
	`allow_humans` integer DEFAULT true NOT NULL,
	`requires_approval` integer DEFAULT false NOT NULL,
	`carry_labels` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_transfer_rules_unique` ON `workflow_transfer_rules` (`source_workflow_id`,`target_workflow_id`);--> statement-breakpoint
CREATE TABLE `workflow_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`from_state_id` text,
	`to_state_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`position` integer DEFAULT 0 NOT NULL,
	`requires_comment` integer DEFAULT false NOT NULL,
	`required_field_keys` text,
	`allowed_roles` text,
	`condition` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_state_id`) REFERENCES `workflow_states`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_transitions_from_idx` ON `workflow_transitions` (`workspace_id`,`workflow_id`,`from_state_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_transitions_unique` ON `workflow_transitions` (`from_state_id`,`to_state_id`,`name`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`object_type_id` text,
	`default_state_id` text,
	`settings` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`object_type_id`) REFERENCES `object_types`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_key_unique` ON `workflows` (`workspace_id`,`key`);--> statement-breakpoint
CREATE INDEX `workflows_workspace_idx` ON `workflows` (`workspace_id`,`archived_at`);