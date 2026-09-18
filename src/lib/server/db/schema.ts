/**
 * Schema barrel.
 *
 * Table definitions live in per-domain modules so parallel work on unrelated
 * modules rarely touches the same file. This barrel gives the rest of the
 * application (and the repository layer) one import site.
 *
 * Dialect note: every table is declared with `sqliteTable`, but column types are
 * intentionally conservative — integers for timestamps, `text` for ids,
 * `text({ mode: 'json' })` for documents — so the PostgreSQL port is a
 * declaration swap rather than a data-model change (see docs/postgres-migration.md).
 */
export * from './schema/_helpers';
export * from './schema/agents';
export * from './schema/analytics';
export * from './schema/audit';
export * from './schema/cache';
export * from './schema/config';
export * from './schema/execution';
export * from './schema/fields';
export * from './schema/files';
export * from './schema/http';
export * from './schema/mcp';
export * from './schema/providers';
export * from './schema/records';
export * from './schema/tenancy';
export * from './schema/triggers';
export * from './schema/workflow-items';
export * from './schema/workflows';

import * as schema from './schema/_helpers';
import * as agents from './schema/agents';
import * as analytics from './schema/analytics';
import * as audit from './schema/audit';
import * as cache from './schema/cache';
import * as config from './schema/config';
import * as execution from './schema/execution';
import * as fields from './schema/fields';
import * as files from './schema/files';
import * as http from './schema/http';
import * as mcp from './schema/mcp';
import * as providers from './schema/providers';
import * as records from './schema/records';
import * as tenancy from './schema/tenancy';
import * as triggers from './schema/triggers';
import * as workflowItems from './schema/workflow-items';
import * as workflows from './schema/workflows';

/** All tables, used by migrations tooling and the drizzle client. */
export const allSchema = {
  ...schema,
  ...tenancy,
  ...fields,
  ...records,
  ...workflows,
  ...workflowItems,
  ...execution,
  ...agents,
  ...http,
  ...mcp,
  ...providers,
  ...config,
  ...cache,
  ...files,
  ...analytics,
  ...triggers,
  ...audit
};
