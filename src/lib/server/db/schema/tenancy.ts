/**
 * Tenancy, identity and access.
 *
 * A Workspace is the tenant boundary. Every repository entry point takes a
 * `workspaceId` and scopes its query by it; there is no "global" read path for
 * domain data. Users are global identities that belong to one or more workspaces
 * through memberships with practical roles.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, createdAt, epochMs, json, primaryId, updatedAt } from './_helpers';

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type MemberStatus = 'active' | 'invited' | 'suspended';

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: primaryId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    /** Workspace-level defaults: storage, retention, branding, agent policy. */
    settings: json<WorkspaceSettings>('settings'),
    storageProvider: text('storage_provider').$type<'local' | 'gcs'>().notNull().default('local'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: epochMs('archived_at')
  },
  (table) => [uniqueIndex('workspaces_slug_unique').on(table.slug)]
);

export interface WorkspaceSettings {
  defaultTimezone?: string;
  retentionDays?: number;
  allowAgentTicketCreation?: boolean;
  allowAgentTransfer?: boolean;
  dailyRunLimit?: number;
  branding?: { accent?: string; logoUrl?: string };
}

export const users = sqliteTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    avatarColor: text('avatar_color'),
    timezone: text('timezone').notNull().default('UTC'),
    isPlatformAdmin: bool('is_platform_admin'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastLoginAt: epochMs('last_login_at'),
    disabledAt: epochMs('disabled_at')
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)]
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<WorkspaceRole>().notNull().default('member'),
    status: text('status').$type<MemberStatus>().notNull().default('active'),
    title: text('title'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [
    uniqueIndex('workspace_members_unique').on(table.workspaceId, table.userId),
    index('workspace_members_user_idx').on(table.userId)
  ]
);

export const teams = sqliteTable(
  'teams',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex('teams_workspace_name_unique').on(table.workspaceId, table.name)]
);

export const teamMembers = sqliteTable(
  'team_members',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt()
  },
  (table) => [uniqueIndex('team_members_unique').on(table.teamId, table.userId)]
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque cookie token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    activeWorkspaceId: text('active_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null'
    }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: createdAt(),
    lastSeenAt: epochMs('last_seen_at'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    revokedAt: epochMs('revoked_at')
  },
  (table) => [
    uniqueIndex('sessions_token_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId)
  ]
);

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    scopes: json<string[]>('scopes'),
    lastUsedAt: epochMs('last_used_at'),
    expiresAt: epochMs('expires_at'),
    createdAt: createdAt(),
    revokedAt: epochMs('revoked_at')
  },
  (table) => [
    uniqueIndex('api_tokens_hash_unique').on(table.tokenHash),
    index('api_tokens_workspace_idx').on(table.workspaceId)
  ]
);

/**
 * Idempotency ledger for inbound webhooks and mutating API calls. The uniqueness
 * of (workspaceId, scope, key) is the dedupe primitive; the stored response lets a
 * retried delivery receive the original outcome instead of creating duplicate work.
 */
export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: primaryId(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestFingerprint: text('request_fingerprint'),
    status: text('status').$type<'in_progress' | 'completed' | 'failed'>().notNull(),
    response: json<unknown>('response'),
    createdAt: createdAt(),
    expiresAt: epochMs('expires_at')
  },
  (table) => [
    uniqueIndex('idempotency_keys_unique').on(table.workspaceId, table.scope, table.key),
    index('idempotency_keys_expiry_idx').on(table.expiresAt)
  ]
);

/**
 * Monotonic per-workspace counters (ticket numbers, workflow key suffixes).
 *
 * A single-row update inside the creating transaction is portable to PostgreSQL
 * and avoids any dependence on autoincrement behaviour.
 */
export const counters = sqliteTable(
  'counters',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: integer('value').notNull().default(0),
    updatedAt: updatedAt()
  },
  (table) => [uniqueIndex('counters_unique').on(table.workspaceId, table.name)]
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
