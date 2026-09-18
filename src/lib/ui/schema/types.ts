/**
 * Client shapes for the shared Zod-schema authoring surface.
 *
 * These mirror `server/schemas/zod-source.ts` and the `/schemas/test` response.
 */
import type { FieldOptions, FieldType } from '$ui/work/types';

export interface ZodProjectedField {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  description: string | null;
  options: FieldOptions | null;
  validation: Record<string, unknown> | null;
  defaultValue: unknown;
  isIdentity: boolean;
  isPrimaryDisplay: boolean;
  showInList: boolean;
  showOnCard: boolean;
  filterable: boolean;
  meta: Record<string, boolean | undefined>;
}

export interface ZodSchemaIssue {
  path: string;
  message: string;
}

export interface ZodSchemaTestResult {
  /** True only when the schema compiled and the sample parsed. */
  ok: boolean;
  compiled: boolean;
  message: string | null;
  issues: ZodSchemaIssue[];
  data: unknown;
  fields: ZodProjectedField[];
  invalidKeys: string[];
}
