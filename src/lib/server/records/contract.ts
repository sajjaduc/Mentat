/**
 * Record contracts: the clean-data-in / clean-data-out boundary for AI execution.
 *
 * Every Object Type's effective schema (base fields + the workflow's overlay
 * fields) is compiled into a Zod schema. Agents receive the record they are
 * working on plus that schema, and must return the record (and a workflow
 * directive) that validates. Invalid output is fed back for repair and, after the
 * retry budget, fails the run — Mentat never persists a record that does not match
 * its declared schema (ADR-0023).
 *
 * The Object Type and the workflow overlay may each declare their contract as Zod
 * source, authored and tested in the shared schema box. When they do, that source is
 * authoritative: it is compiled here on every build and applied verbatim (ADR-0023),
 * so constraints the typed-field engine cannot express — coercions, minimum lengths,
 * unions — are still enforced. Where the overlay names a key the Object Type also
 * declares, the two are intersected: the base constraint always holds and the overlay
 * can only tighten it. The bound field definitions are a projection of the
 * source, which is what keeps lists, filters, history and analytics working. When no
 * source exists, the schema is derived from the typed fields exactly as before.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { errors } from '../core/errors';
import type { Executor } from '../db/client';
import type { FieldChoice, FieldType } from '../db/schema';
import { workflows } from '../db/schema';
import { compileZodSource } from '../schemas/zod-source';
import { requireObjectType } from './object-types';
import { listEffectiveFields } from './service';
import type { EffectiveField } from './types';

export interface RecordContractField {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  source: 'base' | 'workflow';
  description?: string | null;
  choices?: FieldChoice[];
  isIdentity?: boolean;
}

export interface RecordContract {
  objectTypeId: string;
  objectTypeKey: string;
  objectTypeName: string;
  workflowId: string | null;
  workflowName: string | null;
  fields: RecordContractField[];
  /**
   * The Object Type's authoritative Zod contract, when one was authored as source.
   * In-memory only: it is compiled from stored source on every build (ADR-0023).
   */
  baseZodSchema?: z.ZodObject<z.ZodRawShape> | null;
  /** The workflow overlay's authoritative Zod contract, when authored as source. */
  overlayZodSchema?: z.ZodObject<z.ZodRawShape> | null;
}

export interface RecordContractIssue {
  path: string;
  message: string;
}

export type RecordValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: RecordContractIssue[] };

/** Build the effective contract for a record's Object Type (and workflow overlay). */
export async function buildRecordContract(
  db: Executor,
  workspaceId: string,
  objectTypeId: string,
  workflowId: string | null
): Promise<RecordContract> {
  const objectType = requireObjectType(db, workspaceId, objectTypeId);
  const workflow = workflowId
    ? (db
        .select({ name: workflows.name, settings: workflows.settings })
        .from(workflows)
        .where(eq(workflows.id, workflowId))
        .all()[0] ?? null)
    : null;
  const effective = await listEffectiveFields(db, workspaceId, objectTypeId, workflowId, null);
  return {
    objectTypeId,
    objectTypeKey: objectType.key,
    objectTypeName: objectType.name,
    workflowId,
    workflowName: workflow?.name ?? null,
    fields: effective.map(toContractField),
    baseZodSchema: compileObjectSchema(objectType.settings?.zodSchema),
    overlayZodSchema: compileObjectSchema(workflow?.settings?.zodSchema)
  };
}

/**
 * Compile stored source into an object schema. A stored schema that no longer
 * compiles falls back to the field-derived contract rather than making every
 * submission fail with an opaque evaluator error; saving validates source, so this
 * path only matters if the stored data was edited out of band.
 */
function compileObjectSchema(source: string | undefined | null): z.ZodObject<z.ZodRawShape> | null {
  if (!source) return null;
  const compiled = compileZodSource(source);
  return compiled.ok ? compiled.object : null;
}

function toContractField(field: EffectiveField): RecordContractField {
  const options = field.options as { choices?: FieldChoice[] } | null;
  return {
    key: field.key,
    name: field.name,
    type: field.type,
    required: field.required,
    source: field.source,
    description: field.description,
    choices: options?.choices,
    isIdentity: field.isIdentity
  };
}

/** The Zod field type for one declared field type. */
export function zodForFieldType(type: FieldType, choices?: FieldChoice[]): z.ZodTypeAny {
  const choiceValues = (choices ?? []).map((choice) => choice.value).filter(Boolean);
  switch (type) {
    case 'short_text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
    case 'user':
    case 'team':
      return z.string();
    case 'number':
    case 'currency':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
    case 'datetime':
      // ISO date string or epoch milliseconds; the field engine normalizes on write.
      return z.union([z.string(), z.number()]);
    case 'select':
      return choiceValues.length > 0 ? z.enum(choiceValues as [string, ...string[]]) : z.string();
    case 'multi_select':
      return choiceValues.length > 0
        ? z.array(z.enum(choiceValues as [string, ...string[]]))
        : z.array(z.string());
    case 'json':
      return z.unknown();
    default:
      return z.unknown();
  }
}

/** One field's Zod type, honoring requiredness. */
function fieldSchema(field: RecordContractField): z.ZodTypeAny {
  const base = zodForFieldType(field.type, field.choices);
  return field.required ? base : base.nullable().optional();
}

/**
 * Compile a contract into a strict Zod object schema.
 *
 * When the Object Type or the workflow overlay was authored as Zod source, that
 * source is authoritative: its shape is used verbatim and any legacy typed overlay
 * fields not named by the source are added on top. Without sources this is exactly
 * the field-derived schema it always was.
 *
 * The Object Type schema is a floor. A workflow overlay that redeclares one of its
 * keys is intersected with the base definition rather than replacing it, so an
 * overlay can only tighten — never silently drop — a constraint the base declares.
 */
export function buildRecordZodSchema(contract: RecordContract): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const base = contract.baseZodSchema ?? null;
  if (base) {
    Object.assign(shape, base.shape);
  } else {
    for (const field of contract.fields) {
      if (field.source === 'base') shape[field.key] = fieldSchema(field);
    }
  }
  if (contract.overlayZodSchema) {
    for (const [key, node] of Object.entries(contract.overlayZodSchema.shape)) {
      const existing = shape[key];
      // Zod v4 types object-shape entries and intersections as the core `$ZodType`;
      // the runtime values are classic schemas, so narrow them for the object shape.
      shape[key] = (existing ? z.intersection(existing, node) : node) as unknown as z.ZodTypeAny;
    }
  }
  for (const field of contract.fields) {
    if (field.source === 'workflow' && shape[field.key] === undefined) {
      shape[field.key] = fieldSchema(field);
    }
  }
  return z.object(shape).strict();
}

/**
 * Validate a raw record payload against the contract. Unknown keys are rejected
 * (`strict`) so an agent cannot smuggle undocumented fields past persistence.
 */
export function validateRecordAgainstContract(
  contract: RecordContract,
  raw: unknown
): RecordValidation {
  const schema = buildRecordZodSchema(contract);
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) {
    return { ok: true, data: parsed.data as Record<string, unknown> };
  }
  return {
    ok: false,
    issues: parsed.error.issues.flatMap((issue) => {
      const detail = issue as {
        code?: string;
        keys?: string[];
        path: PropertyKey[];
        message: string;
      };
      if (detail.code === 'unrecognized_keys' && Array.isArray(detail.keys)) {
        return detail.keys.map((key) => ({
          path: key,
          message: `Unrecognized field: ${key}`
        }));
      }
      return [{ path: detail.path.map(String).join('.'), message: detail.message }];
    })
  };
}

/** Reject an empty submission when at least one field is required. */
export function assertContractSatisfiable(contract: RecordContract): void {
  if (contract.fields.length === 0) {
    throw errors.validation(
      `Object Type ${contract.objectTypeName} has no fields to contract against`
    );
  }
}

/** Model-facing description of the expected record shape. */
export function describeRecordContract(contract: RecordContract): string {
  const lines = contract.fields.map((field) => {
    const kind =
      field.type === 'select' || field.type === 'multi_select'
        ? `${field.type}<${(field.choices ?? []).map((choice) => choice.value).join('|')}>`
        : field.type;
    const required = field.required ? 'required' : 'optional';
    const provenance =
      field.source === 'workflow' ? `, ${contract.workflowName ?? 'workflow'}` : '';
    const description = field.description ? ` — ${field.description}` : '';
    return `- ${field.key} (${field.name}): ${kind}, ${required}${provenance}${description}`;
  });
  return [
    `Record contract: ${contract.objectTypeName}` +
      (contract.workflowName ? ` in workflow ${contract.workflowName}` : ''),
    ...lines
  ].join('\n');
}

/** The JSON Schema for the record portion of a submission, for tool descriptors. */
export function recordContractJsonSchema(contract: RecordContract): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of contract.fields) {
    properties[field.key] = fieldJsonSchema(field);
    if (field.required) required.push(field.key);
  }
  return {
    type: 'object',
    description: `${contract.objectTypeName} record fields`,
    properties,
    required,
    additionalProperties: false
  };
}

function fieldJsonSchema(field: RecordContractField): Record<string, unknown> {
  const values = (field.choices ?? []).map((choice) => choice.value);
  switch (field.type) {
    case 'number':
    case 'currency':
      return { type: 'number', description: field.description ?? undefined };
    case 'boolean':
      return { type: 'boolean', description: field.description ?? undefined };
    case 'date':
    case 'datetime':
      return {
        type: ['string', 'number'],
        description: `${field.description ?? ''} ISO date or epoch milliseconds`.trim()
      };
    case 'select':
      return values.length > 0
        ? { type: 'string', enum: values }
        : { type: 'string', description: field.description ?? undefined };
    case 'multi_select':
      return values.length > 0
        ? { type: 'array', items: { type: 'string', enum: values } }
        : { type: 'array', items: { type: 'string' } };
    case 'json':
      return { description: field.description ?? undefined };
    default:
      return { type: 'string', description: field.description ?? undefined };
  }
}

/** Structural view used by prompt assembly and the API. */
export function contractToJson(contract: RecordContract): Record<string, unknown> {
  return {
    objectTypeId: contract.objectTypeId,
    objectTypeKey: contract.objectTypeKey,
    objectTypeName: contract.objectTypeName,
    workflowId: contract.workflowId,
    workflowName: contract.workflowName,
    fields: contract.fields
  };
}
