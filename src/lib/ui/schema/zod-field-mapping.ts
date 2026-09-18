/**
 * The Zod → field mapping reference, as data.
 *
 * Object Type, workflow overlay and state schemas are all authored as Zod source
 * and projected onto the typed-field engine (see `server/schemas/zod-source.ts`).
 * This module is the human-readable counterpart: every construct the projectors
 * understand, what field it creates, and how `.meta()` binds behaviour.
 *
 * It is deliberately data, not prose, so it can be rendered anywhere and pinned
 * against the real projector in `tests/unit/ui/zod-field-mapping.test.ts` — the
 * page cannot quietly describe a mapping the engine no longer performs.
 */
import type { FieldType } from '$ui/work/types';

export interface ZodMappingRow {
  /** The Zod construct as an author writes it. */
  zod: string;
  /** The field type the projection creates. */
  fieldType: FieldType;
  /** Whether the construct is required after unwrapping wrappers. */
  required: boolean;
  /** When to reach for it, and what the projection keeps. */
  note: string;
  /**
   * A self-contained field expression. `example` is compiled by the unit test and
   * must project to `fieldType` / `required` (and `choices`, when declared).
   */
  example: string;
  /** Expected choice count, for enum/literal rows. */
  choices?: number;
}

export interface ZodMappingGroup {
  id: string;
  title: string;
  description: string;
  rows: ZodMappingRow[];
}

export const ZOD_MAPPING_GROUPS: ZodMappingGroup[] = [
  {
    id: 'text',
    title: 'Text',
    description:
      'Strings become text fields; length and pattern rules carry across as field validation.',
    rows: [
      {
        zod: 'z.string()',
        fieldType: 'short_text',
        required: true,
        note: 'The default text field. Long prose is still stored as text; `long_text` only changes the editor.',
        example: 'z.string()'
      },
      {
        zod: 'z.string().min(3).max(120)',
        fieldType: 'short_text',
        required: true,
        note: 'Inclusive length bounds become `minLength` / `maxLength` on the field.',
        example: 'z.string().min(3).max(120)'
      },
      {
        zod: 'z.string().regex(/^[A-Z]{2}-\\d+$/)',
        fieldType: 'short_text',
        required: true,
        note: 'A regular expression becomes `pattern`. The source still enforces it exactly.',
        example: 'z.string().regex(/^[A-Z]{2}-\\d+$/)'
      },
      {
        zod: 'z.email()  ·  z.string().email()',
        fieldType: 'email',
        required: true,
        note: 'Recognised by the `email` format on either form.',
        example: 'z.email()'
      },
      {
        zod: 'z.url()  ·  z.string().url()',
        fieldType: 'url',
        required: true,
        note: 'Recognised by the `url` format.',
        example: 'z.url()'
      },
      {
        zod: 'z.e164()',
        fieldType: 'phone',
        required: true,
        note: 'Recognised by the `e164` format.',
        example: 'z.e164()'
      },
      {
        zod: 'z.iso.date()',
        fieldType: 'date',
        required: true,
        note: 'A calendar date (no time).',
        example: 'z.iso.date()'
      },
      {
        zod: 'z.iso.datetime()  ·  z.date()',
        fieldType: 'datetime',
        required: true,
        note: 'A point in time. `z.date()` also maps here; the source keeps the JS Date semantics.',
        example: 'z.iso.datetime()'
      }
    ]
  },
  {
    id: 'numbers',
    title: 'Numbers and booleans',
    description: 'Numeric bounds are projected; every other numeric rule stays in the source.',
    rows: [
      {
        zod: 'z.number()',
        fieldType: 'number',
        required: true,
        note: 'A numeric field.',
        example: 'z.number()'
      },
      {
        zod: 'z.number().min(0).max(1000)',
        fieldType: 'number',
        required: true,
        note: 'Inclusive `min` / `max` become field validation. Exclusive `.gt()` / `.lt()` are enforced by the source but not projected.',
        example: 'z.number().min(0).max(1000)'
      },
      {
        zod: 'z.bigint()',
        fieldType: 'number',
        required: true,
        note: 'Stored as a number by the field engine; the source keeps bigint semantics.',
        example: 'z.bigint()'
      },
      {
        zod: 'z.coerce.number()',
        fieldType: 'number',
        required: true,
        note: 'Coercion (e.g. `"7"` → `7`) runs from the source at validation time; the projection is a number field.',
        example: 'z.coerce.number()'
      },
      {
        zod: 'z.boolean()',
        fieldType: 'boolean',
        required: true,
        note: 'A true/false field.',
        example: 'z.boolean()'
      }
    ]
  },
  {
    id: 'choices',
    title: 'Choices',
    description:
      'Enums and literals become select fields with their choices carried across as options.',
    rows: [
      {
        zod: "z.enum(['active', 'lapsed'])",
        fieldType: 'select',
        required: true,
        note: 'Becomes a single-choice select. Choice labels are humanised automatically.',
        example: "z.enum(['active', 'lapsed'])",
        choices: 2
      },
      {
        zod: "z.literal('yes')",
        fieldType: 'select',
        required: true,
        note: 'A single allowed value becomes a one-choice select.',
        example: "z.literal('yes')",
        choices: 1
      },
      {
        zod: "z.array(z.enum(['a', 'b']))",
        fieldType: 'multi_select',
        required: true,
        note: 'An array of enum values becomes a multi-select with those choices.',
        example: "z.array(z.enum(['a', 'b']))",
        choices: 2
      },
      {
        zod: "z.array(z.literal('x'))",
        fieldType: 'multi_select',
        required: true,
        note: 'An array of literals becomes a multi-select with those choices.',
        example: "z.array(z.literal('x'))",
        choices: 1
      }
    ]
  },
  {
    id: 'json',
    title: 'Everything else → JSON',
    description:
      'Constructs the field engine cannot type become `json` fields: lists, filters and history still work, and the stored source still validates them exactly.',
    rows: [
      {
        zod: 'z.record(z.string(), z.number())',
        fieldType: 'json',
        required: true,
        note: 'Key/value maps are free-form JSON.',
        example: 'z.record(z.string(), z.number())'
      },
      {
        zod: 'z.object({ ... })',
        fieldType: 'json',
        required: true,
        note: 'Nested objects stay JSON; the source enforces their shape.',
        example: 'z.object({ a: z.string() })'
      },
      {
        zod: 'z.tuple([...])  ·  z.union([...])',
        fieldType: 'json',
        required: true,
        note: 'Tuples, unions, intersections and transforms are JSON.',
        example: 'z.tuple([z.string(), z.number()])'
      },
      {
        zod: 'z.array(z.string())',
        fieldType: 'json',
        required: true,
        note: 'A choice-less array is not a select, so it stays JSON. Add an enum to get a multi-select.',
        example: 'z.array(z.string())'
      },
      {
        zod: 'z.unknown()  ·  z.any()',
        fieldType: 'json',
        required: false,
        note: 'An unconstrained field is also treated as optional: there is no meaning in requiring an unknown key.',
        example: 'z.unknown()'
      }
    ]
  },
  {
    id: 'requiredness',
    title: 'Requiredness, null and defaults',
    description:
      'Wrappers decide whether the key must be present. They are read through the chain, so `.optional().default(...)` behaves as expected.',
    rows: [
      {
        zod: 'z.string()',
        fieldType: 'short_text',
        required: true,
        note: 'No wrapper: the key is required.',
        example: 'z.string()'
      },
      {
        zod: 'z.string().optional()',
        fieldType: 'short_text',
        required: false,
        note: 'May be omitted. `.nonoptional()` currently projects as optional too — prefer `.optional()`.',
        example: 'z.string().optional()'
      },
      {
        zod: 'z.string().nullable()',
        fieldType: 'short_text',
        required: true,
        note: 'Accepts `null` but is still required: the key must be present. Add `.optional()` to make it omittable.',
        example: 'z.string().nullable()'
      },
      {
        zod: "z.string().default('x')",
        fieldType: 'short_text',
        required: false,
        note: 'Makes the key omittable and supplies the value when it is missing. Function defaults are applied by the source but not stored as a field default.',
        example: "z.string().default('x')"
      },
      {
        zod: "z.string().prefault('x')",
        fieldType: 'short_text',
        required: false,
        note: 'Like `.default()`, but the value is applied before validation.',
        example: "z.string().prefault('x')"
      },
      {
        zod: 'z.string().readonly()  ·  z.string().catch(...)',
        fieldType: 'short_text',
        required: true,
        note: '`readonly` and `catch` are unwrapped for projection without changing requiredness.',
        example: 'z.string().readonly()'
      }
    ]
  }
];

export interface ZodConstraintMapping {
  zod: string;
  projected: string;
}

export const ZOD_CONSTRAINT_MAPPINGS: ZodConstraintMapping[] = [
  { zod: 'z.string().min(n)', projected: 'validation.minLength = n' },
  { zod: 'z.string().max(n)', projected: 'validation.maxLength = n' },
  { zod: 'z.string().regex(/…/)', projected: 'validation.pattern = source' },
  { zod: 'z.number().min(n) / .gte(n)', projected: 'validation.min = n' },
  { zod: 'z.number().max(n) / .lte(n)', projected: 'validation.max = n' },
  { zod: 'z.number().gt(n) / .lt(n)', projected: 'Not projected — enforced by the source only' },
  {
    zod: 'z.string().min(n) on a formatted string',
    projected: 'Format wins for the type; the bound still applies'
  }
];

export interface ZodMetaFlagMapping {
  /** The `.meta()` key. */
  key: string;
  /** The binding it writes on the Object Type field. */
  binding: string;
  /** What happens when the key is absent. */
  fallback: string;
  /** What the flag changes. */
  effect: string;
  /** A snippet an author can copy. */
  example: string;
}

export const ZOD_META_FLAGS: ZodMetaFlagMapping[] = [
  {
    key: 'identity',
    binding: 'isIdentity',
    fallback: 'false — the field is not an identity',
    effect:
      'Marks the field as this Object Type’s identity. Duplicate values are rejected when a record is created or updated, naming the existing record.',
    example: 'identity: true'
  },
  {
    key: 'primary',
    binding: 'isPrimaryDisplay',
    fallback:
      'The first field in the schema becomes primary unless a field opts out with `primary: false`',
    effect:
      'Sets the record display name from this field’s value. Only the first primary field in schema order is used. With no primary field, the label is “Untitled <Object Type>”.',
    example: 'primary: true'
  },
  {
    key: 'list',
    binding: 'showInList',
    fallback: 'true — the field appears in record lists',
    effect:
      'Shows the field as a column in record lists and in board list mode. `list: false` hides it there.',
    example: 'list: false'
  },
  {
    key: 'card',
    binding: 'showOnCard',
    fallback: 'false — the field is not on board cards',
    effect: 'Shows the field on board cards.',
    example: 'card: true'
  },
  {
    key: 'filterable',
    binding: 'filterable',
    fallback: 'true — the field can be filtered and sorted',
    effect:
      'Offers the field in filter and sort pickers. `filterable: false` removes it from them.',
    example: 'filterable: false'
  },
  {
    key: 'description',
    binding: 'description',
    fallback: 'none',
    effect:
      "Help text carried with the field and shown to agents. `.describe('…')` sets the same value; `.meta({ description })` wins when both are present.",
    example: "description: 'The policy identifier'"
  }
];

/** A copyable example that combines several meta flags. */
export const ZOD_META_EXAMPLE = `z.object({
  policy_number: z.string().min(3).meta({ identity: true, primary: true }),
  premium: z.number().min(0).meta({ card: true }),
  internal_note: z.string().optional().meta({ list: false, filterable: false }),
  reviewer_note: z.string().optional().describe('Filled in while a reviewer holds the work')
})`;

export interface ZodLayerDoc {
  id: string;
  title: string;
  where: string;
  effect: string;
}

export const ZOD_LAYERS: ZodLayerDoc[] = [
  {
    id: 'object-type',
    title: 'Object Type schema',
    where: 'Settings → Object Types → Schema',
    effect:
      'The base contract for the Record. It is compiled into every workflow contract, so it is checked on every agent submission no matter which state the work is in. Keep it to the fields that must always be true.'
  },
  {
    id: 'workflow',
    title: 'Workflow overlay schema',
    where: 'Workflow → Configuration → Fields',
    effect:
      'Extra fields for work items in one workflow. It is merged over the base shape; keys it does not mention are still enforced by the base. A key it redeclares is combined with the base definition, so the overlay can only tighten that field — never loosen it.'
  },
  {
    id: 'state',
    title: 'State schema',
    where: 'Workflow → Configuration → States → State schema',
    effect:
      'An additional requirement applied both when a submission is made while work is in that state and when work enters it: a submission must satisfy the state it leaves, and the record must satisfy the state it lands in. It layers on top of the base and overlay contracts — the tighter rule wins. It can only require keys those contracts already declare: a key it introduces is rejected as an unrecognized field, so declare the field (as optional) in the base or overlay first.'
  }
];

export const ZOD_LAYER_EXAMPLE = `// 1. Object Type: loose, always true
z.object({
  policy_number: z.string(),
  premium: z.number().optional(),
  reviewer_note: z.string().optional()
})

// 2. Workflow overlay: adds work fields, and tightens a base field it restates
z.object({
  renewal_quote: z.number().min(0),
  policy_number: z.string().min(5)
})

// 3. State "Review": requires data the base left optional
z.object({ reviewer_note: z.string().min(1) })`;

/** Object keys become field keys through these rules; unusable keys block saving. */
export const ZOD_KEY_RULES = [
  'camelCase and snake_case keys are normalised to snake_case, e.g. `policyNumber` → `policy_number`.',
  'Keys must match `^[a-z][a-z0-9_]{1,47}$`: lowercase letters, numbers and underscores, starting with a letter.',
  'The display name is humanised from the key, e.g. `policy_number` → “Policy number”.',
  'Keys that cannot be normalised are reported when you test the schema and block saving.',
  'Field order follows the order of keys in the object.'
];
