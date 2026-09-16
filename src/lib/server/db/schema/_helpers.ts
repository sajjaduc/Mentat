/**
 * Shared column helpers.
 *
 * Timestamps are epoch milliseconds stored as integers: SQLite has no native
 * timestamp type, and integers avoid timezone/round-trip ambiguity entirely while
 * migrating cleanly to PostgreSQL `bigint`. Ids are application-generated UUIDv7
 * strings (ADR-0003). JSON payloads live in typed `text({ mode: 'json' })` columns
 * that map to `jsonb` on PostgreSQL.
 */
import { index, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from '../../core/ids';

export function primaryId() {
  return text('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
}

export function createdAt() {
  return integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now());
}

export function updatedAt() {
  return integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now());
}

export function epochMs(name: string) {
  return integer(name);
}

export function bool(name: string, defaultValue = false) {
  return integer(name, { mode: 'boolean' }).notNull().default(defaultValue);
}

export function json<T>(name: string) {
  return text(name, { mode: 'json' }).$type<T>();
}

export function jsonArray<T>(name: string) {
  return text(name, { mode: 'json' })
    .$type<T[]>()
    .notNull()
    .default([] as unknown as T[]);
}

export { index, uniqueIndex };

/**
 * How a workflow-scoped resource relates to its workspace-level counterpart.
 * This is the shared vocabulary for "Use as-is / Override / Fork" and is
 * deliberately not a single polymorphic table: each resource type keeps its own
 * storage and only the *binding* is modelled uniformly (ADR-0006).
 */
export type ResourceBindingMode = 'use_asis' | 'override' | 'fork';

/** Resource types that participate in workspace/workflow binding semantics. */
export type BindableResourceType =
  | 'agent'
  | 'skill'
  | 'tool'
  | 'http_service'
  | 'http_operation'
  | 'field_definition'
  | 'collection'
  | 'provider'
  | 'model'
  | 'secret'
  | 'environment_variable';
