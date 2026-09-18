/**
 * Record contract tests: the clean-data-in / clean-data-out boundary.
 *
 * These are pure-function tests of the Zod derivation and validation, so they
 * fail fast without a database when the contract rules regress.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildRecordZodSchema,
  describeRecordContract,
  type RecordContract,
  recordContractJsonSchema,
  validateRecordAgainstContract,
  zodForFieldType
} from '../../../src/lib/server/records/contract';

const contract: RecordContract = {
  objectTypeId: 'ot-policy',
  objectTypeKey: 'policy',
  objectTypeName: 'Policy',
  workflowId: 'wf-renewal',
  workflowName: 'Renewal',
  fields: [
    {
      key: 'policy_number',
      name: 'Policy Number',
      type: 'short_text',
      required: true,
      source: 'base'
    },
    { key: 'premium', name: 'Premium', type: 'number', required: false, source: 'base' },
    { key: 'active', name: 'Active', type: 'boolean', required: false, source: 'base' },
    {
      key: 'status',
      name: 'Status',
      type: 'select',
      required: false,
      source: 'workflow',
      choices: [
        { value: 'active', label: 'Active' },
        { value: 'lapsed', label: 'Lapsed' }
      ]
    },
    {
      key: 'tags',
      name: 'Tags',
      type: 'multi_select',
      required: false,
      source: 'base',
      choices: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ]
    },
    { key: 'expiry', name: 'Expiry', type: 'date', required: false, source: 'base' }
  ]
};

describe('record contract: schema derivation', () => {
  test('accepts a conforming payload and strips nothing', () => {
    const result = validateRecordAgainstContract(contract, {
      policy_number: 'POL-1',
      premium: 100,
      active: true,
      status: 'active',
      tags: ['a', 'b'],
      expiry: '2026-01-01'
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.policy_number).toBe('POL-1');
      expect(result.data.premium).toBe(100);
      expect(result.data.tags).toEqual(['a', 'b']);
    }
  });

  test('rejects unknown fields so an agent cannot smuggle data past persistence', () => {
    const result = validateRecordAgainstContract(contract, {
      policy_number: 'POL-1',
      smuggled: 'nope'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === 'smuggled')).toBe(true);
    }
  });

  test('rejects missing required fields and wrong types with paths', () => {
    const missing = validateRecordAgainstContract(contract, { premium: 10 });
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.issues.some((issue) => issue.path === 'policy_number')).toBe(true);

    const wrong = validateRecordAgainstContract(contract, {
      policy_number: 'POL-1',
      premium: 'not-a-number'
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues.some((issue) => issue.path === 'premium')).toBe(true);
  });

  test('enforces select and multi-select choices', () => {
    const badStatus = validateRecordAgainstContract(contract, {
      policy_number: 'POL-1',
      status: 'cancelled'
    });
    expect(badStatus.ok).toBe(false);

    const badTag = validateRecordAgainstContract(contract, {
      policy_number: 'POL-1',
      tags: ['a', 'z']
    });
    expect(badTag.ok).toBe(false);
  });

  test('accepts ISO date strings and epoch milliseconds', () => {
    expect(
      validateRecordAgainstContract(contract, { policy_number: 'P', expiry: '2026-05-01' }).ok
    ).toBe(true);
    expect(
      validateRecordAgainstContract(contract, { policy_number: 'P', expiry: 1767225600000 }).ok
    ).toBe(true);
  });

  test('optional fields may be omitted or explicitly cleared with null', () => {
    const omitted = validateRecordAgainstContract(contract, { policy_number: 'P' });
    expect(omitted.ok).toBe(true);
    const cleared = validateRecordAgainstContract(contract, {
      policy_number: 'P',
      premium: null
    });
    expect(cleared.ok).toBe(true);
  });

  test('required fields may not be null', () => {
    const result = validateRecordAgainstContract(contract, { policy_number: null });
    expect(result.ok).toBe(false);
  });
});

describe('record contract: description and JSON schema', () => {
  test('describes every field with type, requirements and workflow provenance', () => {
    const description = describeRecordContract(contract);
    expect(description).toContain('Record contract: Policy');
    expect(description).toContain('Renewal');
    expect(description).toContain('policy_number');
    expect(description).toContain('select<active|lapsed>');
    expect(description).toContain('required');
  });

  test('emits a JSON schema with enums and required keys', () => {
    const json = recordContractJsonSchema(contract) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(json.required).toEqual(['policy_number']);
    expect(json.properties.status?.enum).toEqual(['active', 'lapsed']);
    expect(json.properties.tags?.items).toEqual({ type: 'string', enum: ['a', 'b'] });
  });

  test('falls back to free strings when a select has no choices', () => {
    const schema = zodForFieldType('select', []);
    expect(schema.safeParse('anything').success).toBe(true);
    expect(buildRecordZodSchema({ ...contract, fields: [] }).safeParse({}).success).toBe(true);
  });
});
