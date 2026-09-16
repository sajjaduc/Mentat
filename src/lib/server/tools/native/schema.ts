/**
 * Native-tool boundary helpers.
 *
 * Tool input arrives from a model, which is untrusted. Every handler validates its
 * input with the same Zod schema that produced its declared JSON Schema, so the
 * contract shown to the model and the runtime check can never drift apart.
 * `z.toJSONSchema` is used rather than hand-written schemas for that reason; the
 * draft marker is stripped because tool-calling payloads do not need it.
 */
import { z } from 'zod';
import { errors } from '../../core/errors';
import type { JsonSchema } from '../types';

/** Parse untrusted tool input, converting Zod issues into an `AppError`. */
export function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw errors.validation('Invalid tool input', {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message
    }))
  });
}

/** JSON Schema for a tool's input contract. */
export function inputJsonSchema(schema: z.ZodType): JsonSchema {
  return stripDraftMarker(z.toJSONSchema(schema, { io: 'input' }));
}

/** JSON Schema for a tool's output payload. */
export function outputJsonSchema(schema: z.ZodType): JsonSchema {
  return stripDraftMarker(z.toJSONSchema(schema, { io: 'output' }));
}

function stripDraftMarker(schema: unknown): JsonSchema {
  const generated = { ...(schema as Record<string, unknown>) };
  delete generated.$schema;
  return generated;
}
