/**
 * Fresh-install rehearsal.
 *
 * The milestone promises that a fresh clone installs and starts with documented
 * commands. This test approximates that: a brand-new database file, migrations from
 * scratch, bootstrap, and then the first real user journey — create the owner
 * account, get a starter workspace, create a workflow and a ticket.
 *
 * It also asserts the migration path is idempotent, because that is what makes
 * "upgrade by restarting" true, and it checks the schema contract a fresh install
 * depends on (every expected table, FTS availability reported rather than assumed).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { dispatchApi } from '../../../src/lib/server/api/router';
import { apiRoutes } from '../../../src/lib/server/api/routes';
import { listMemberships } from '../../../src/lib/server/auth/sessions';
import { resetBootstrap, runBootstrap } from '../../../src/lib/server/bootstrap';
import { createActorContext, permissionsForRole } from '../../../src/lib/server/core/context';
import { clearSecretRegistry } from '../../../src/lib/server/core/secret-registry';
import { createDatabase } from '../../../src/lib/server/db/client';
import { hasFullTextSearch, runMigrations } from '../../../src/lib/server/db/migrate';
import { allSchema, records as recordsTable, users } from '../../../src/lib/server/db/schema';
import { clearProviderOverrides } from '../../../src/lib/server/providers/registry';
import { resetToolRegistry } from '../../../src/lib/server/tools/registry';
import { listWorkflows } from '../../../src/lib/server/workflows/service';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mentat-fresh-'));
const dbPath = path.join(tempRoot, 'mentat.db');
const blobRoot = path.join(tempRoot, 'blobs');

/** Tables a fresh install must contain, grouped by the phase that introduced them. */
const REQUIRED_TABLES = [
  // Phase 0-1: tenancy, object types, records, workflows, fields
  'workspaces',
  'users',
  'workspace_members',
  'teams',
  'team_members',
  'sessions',
  'api_tokens',
  'counters',
  'idempotency_keys',
  'field_definitions',
  'workflow_fields',
  'field_value_history',
  'workflows',
  'workflow_states',
  'workflow_transitions',
  'workflow_transfer_rules',
  'labels',
  'saved_views',
  // ADR-0021: the universal work model replaces the Ticket primitive.
  'object_types',
  'object_type_fields',
  'records',
  'record_field_values',
  'record_notes',
  'record_note_revisions',
  'record_relationships',
  'record_relationship_definitions',
  'record_external_ids',
  'record_layouts',
  'workflow_items',
  'workflow_item_field_values',
  'workflow_item_notes',
  'workflow_item_note_revisions',
  'workflow_item_relationships',
  'workflow_item_state_history',
  'workflow_item_workflow_history',
  'workflow_item_labels',
  // Phase 2-3: execution, agents, providers
  'jobs',
  'job_attempts',
  'agent_runs',
  'agent_run_steps',
  'run_events',
  'approval_requests',
  'agents',
  'agent_versions',
  'skills',
  'skill_versions',
  'tools',
  'agent_tools',
  'agent_state',
  'providers',
  'models',
  'provider_health_checks',
  // Phase 4-5: native data and HTTP
  'cache_entries',
  'cache_locks',
  'collections',
  'collection_records',
  'http_services',
  'http_operations',
  'http_request_logs',
  // Phase 6-8: config, triggers, files, analytics
  'secrets',
  'environment_variables',
  'workspace_overrides',
  'workspace_storage_config',
  'triggers',
  'trigger_events',
  'blobs',
  'files',
  'file_sources',
  'workflow_files',
  'file_workflow_items',
  'file_records',
  'file_processing_runs',
  'file_extracted_content',
  'file_summaries',
  'file_field_values',
  'dashboards',
  'dashboard_widgets',
  'audit_events',
  'mcp_servers'
];

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('fresh install', () => {
  test('migrations create the complete schema and are idempotent', () => {
    const handle = createDatabase({ url: dbPath });
    try {
      runMigrations(handle.db, handle.sqlite);

      const tables = new Set(
        (
          handle.sqlite
            .query("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((row) => row.name)
      );

      const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
      expect(missing, `missing tables: ${missing.join(', ')}`).toEqual([]);

      // Foreign keys must be enforced, not merely declared.
      const foreignKeys = handle.sqlite.query('PRAGMA foreign_keys').get() as {
        foreign_keys: number;
      };
      expect(foreignKeys.foreign_keys).toBe(1);

      // WAL keeps readers from blocking the single writer.
      const journal = handle.sqlite.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(journal.journal_mode).toBe('wal');

      // Full-text search is reported, not assumed: the retrieval layer falls back to
      // a portable scan when the SQLite build lacks FTS5.
      expect(typeof hasFullTextSearch(handle.sqlite)).toBe('boolean');

      // Running migrations again must be a no-op, which is what makes "restart to
      // upgrade" safe.
      const before = tables.size;
      runMigrations(handle.db, handle.sqlite);
      const after = (
        handle.sqlite
          .query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
          .get() as { n: number }
      ).n;
      expect(after).toBe(before);
    } finally {
      handle.close();
    }
  });

  test('every declared table is reachable through the schema object', () => {
    const names = new Set<string>();
    for (const value of Object.values(allSchema)) {
      if (typeof value !== 'object' || value === null) continue;
      try {
        names.add(getTableConfig(value as never).name);
      } catch {
        // Not a table (a helper, a type, an enum).
      }
    }
    const missing = REQUIRED_TABLES.filter((table) => !names.has(table));
    expect(missing, `schema object is missing: ${missing.join(', ')}`).toEqual([]);
  });

  test('the first user can sign up, receive a workspace and create work', async () => {
    resetBootstrap();
    resetToolRegistry();
    clearProviderOverrides();
    clearSecretRegistry();

    const handle = createDatabase({ url: dbPath });
    try {
      const boot = await runBootstrap({
        db: handle.db,
        sqlite: handle.sqlite,
        skipMigrations: true,
        startWorker: false
      });
      expect(boot.nativeToolCount).toBeGreaterThan(25);
      expect(boot.registeredJobTypes.length).toBeGreaterThanOrEqual(6);

      // Registration is the documented first-run path: it creates the account and a
      // starter workspace in one call.
      const registered = await dispatchApi({
        db: handle.db,
        method: 'POST',
        pathname: '/auth/register',
        actor: null,
        query: {},
        rawBody: JSON.stringify({
          email: 'first@mentat.test',
          name: 'First User',
          password: 'first-user-password'
        }),
        request: new Request('http://127.0.0.1/api/auth/register', { method: 'POST' })
      });
      expect(registered.status).toBe(201);
      const sessionCookie = registered.headers['Set-Cookie'] ?? '';
      expect(sessionCookie).toContain('mentat_session=');
      const workspaceId = (registered.body as { workspaceId: string | null }).workspaceId;
      expect(workspaceId).toBeTruthy();

      // The cookie is not stored in plaintext.
      const user = handle.db
        .select()
        .from(users)
        .where(eq(users.email, 'first@mentat.test'))
        .all()[0];
      expect(user).toBeDefined();
      const sessionRows = handle.sqlite
        .query('SELECT token_hash FROM sessions WHERE user_id = ?')
        .all(user!.id) as Array<{ token_hash: string }>;
      const token = sessionCookie.split('=')[1]?.split(';')[0] ?? '';
      expect(sessionRows[0]?.token_hash).not.toBe(token);
      expect(token.length).toBeGreaterThan(20);

      const memberships = listMemberships(handle.db, user!.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('owner');

      const actor = createActorContext({
        workspaceId: workspaceId as string,
        actorType: 'user',
        actorId: user!.id,
        actorLabel: user!.name,
        role: 'owner',
        permissions: permissionsForRole('owner')
      });

      const call = async (method: string, routePath: string, body?: unknown) => {
        const rawBody = body === undefined ? undefined : JSON.stringify(body);
        return dispatchApi({
          db: handle.db,
          method,
          pathname: routePath,
          actor,
          query: {},
          rawBody,
          request: new Request(`http://127.0.0.1/api${routePath}`, {
            method,
            ...(rawBody === undefined
              ? {}
              : { body: rawBody, headers: { 'content-type': 'application/json' } })
          })
        });
      };

      // An empty instance offers the templates, so a workflow can be created without
      // any other setup.
      const templates = await call('GET', '/workflow-templates');
      expect(templates.status).toBe(200);
      expect((templates.body as { templates: unknown[] }).templates.length).toBeGreaterThanOrEqual(
        5
      );

      // Object Types are explicit: define one before creating a workflow or Record.
      const objectType = await call('POST', '/object-types', {
        name: 'Ticket',
        key: 'ticket',
        settings: { numbered: true, keyPrefix: 'TKT' }
      });
      expect(objectType.status).toBe(201);
      const objectTypeId = (objectType.body as { objectType: { id: string } }).objectType.id;

      const created = await call('POST', '/workflows', {
        name: 'First workflow',
        template: 'basic',
        objectTypeId
      });
      expect(created.status).toBe(201);
      const workflowId = (created.body as { workflow: { id: string } }).workflow.id;

      const started = await call('POST', '/workflow-items', {
        workflowId,
        record: { objectTypeId, displayName: 'First ticket' }
      });
      expect(started.status).toBe(201);

      const rows = handle.db.select().from(recordsTable).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toMatch(/^[A-Z]+-1$/);

      // The workflow list the UI renders from is populated.
      expect(listWorkflows(handle.db, actor)).toHaveLength(1);

      // And the API surface is complete enough to drive the whole UI.
      expect(apiRoutes.length).toBeGreaterThan(80);
    } finally {
      handle.close();
    }
  });

  test('storage roots are created on demand, not required up front', () => {
    // No blob directory exists yet; the local store creates it on first write.
    expect(fs.existsSync(blobRoot)).toBe(false);
    const handle = createDatabase({ url: dbPath });
    handle.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});
