/**
 * Starter-schema generation tests.
 *
 * Migrating a legacy typed Object Type must not silently drop identity or display
 * flags, so the starter carries them across as `.meta({...})` — and only when they
 * differ from the default.
 */
import { describe, expect, test } from 'bun:test';
import { buildStarterZodSchema } from '../../../src/lib/ui/schema/starter';

describe('buildStarterZodSchema', () => {
  test('maps field types and requiredness to a Zod object', () => {
    const source = buildStarterZodSchema([
      { key: 'policy_number', name: 'Policy Number', type: 'short_text', required: true },
      { key: 'premium', name: 'Premium', type: 'number', required: false },
      {
        key: 'status',
        name: 'Status',
        type: 'select',
        required: true,
        options: { choices: [{ value: 'active', label: 'Active' }] }
      },
      {
        key: 'tags',
        name: 'Tags',
        type: 'multi_select',
        required: false,
        options: { choices: [{ value: 'a', label: 'A' }] }
      }
    ]);

    expect(source).toContain('policy_number: z.string()');
    expect(source).toContain('premium: z.number().optional()');
    expect(source).toContain(`status: z.enum(['active'])`);
    expect(source).toContain(`tags: z.array(z.enum(['a'])).optional()`);
  });

  test('carries non-default binding flags across as meta', () => {
    const source = buildStarterZodSchema([
      {
        key: 'code',
        name: 'Code',
        type: 'short_text',
        required: true,
        isIdentity: true,
        isPrimaryDisplay: true,
        showInList: false,
        showOnCard: true,
        filterable: false
      },
      { key: 'plain', name: 'Plain', type: 'short_text', required: true }
    ]);

    expect(source).toContain(
      'code: z.string().meta({ identity: true, primary: true, list: false, card: true, filterable: false })'
    );
    expect(source).not.toContain('plain: z.string().meta');
  });

  test('returns an empty object schema for no fields', () => {
    expect(buildStarterZodSchema([])).toContain('z.object');
  });
});
