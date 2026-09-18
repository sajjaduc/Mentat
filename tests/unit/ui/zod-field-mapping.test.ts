/**
 * Pin the Zod → field mapping reference against the real projector.
 *
 * The Object Types page describes the mapping from `zod-field-mapping.ts`. If the
 * projector in `server/schemas/zod-source.ts` changes, these tests fail, so the
 * page cannot quietly document a mapping the engine no longer performs.
 */
import { describe, expect, test } from 'bun:test';
import { compileZodSource } from '../../../src/lib/server/schemas/zod-source';
import { ZOD_MAPPING_GROUPS, ZOD_META_FLAGS } from '../../../src/lib/ui/schema/zod-field-mapping';

describe('zod-field-mapping reference', () => {
  for (const group of ZOD_MAPPING_GROUPS) {
    for (const row of group.rows) {
      test(`${group.id}: ${row.zod} → ${row.fieldType}`, () => {
        const compiled = compileZodSource(`z.object({ field: ${row.example} })`);
        expect(compiled.ok).toBe(true);
        if (!compiled.ok) return;
        const field = compiled.fields[0];
        expect(field?.type).toBe(row.fieldType);
        expect(field?.required).toBe(row.required);
        if (row.choices !== undefined) {
          expect(field?.options?.choices?.length).toBe(row.choices);
        }
      });
    }
  }

  test('every documented .meta() flag changes the projection as described', () => {
    // `.meta()` keys the projector reads, mapped to the projected flag they set.
    const booleans: Record<string, { flag: string; value: boolean }> = {
      identity: { flag: 'isIdentity', value: true },
      primary: { flag: 'isPrimaryDisplay', value: true },
      list: { flag: 'showInList', value: false },
      card: { flag: 'showOnCard', value: true },
      filterable: { flag: 'filterable', value: false }
    };
    const documented = ZOD_META_FLAGS.map((flag) => flag.key).sort();
    expect(documented).toEqual([
      'card',
      'description',
      'filterable',
      'identity',
      'list',
      'primary'
    ]);

    for (const flag of ZOD_META_FLAGS) {
      if (flag.key === 'description') {
        const compiled = compileZodSource(
          `z.object({ field: z.string().meta({ description: 'Helpful' }) })`
        );
        expect(compiled.ok).toBe(true);
        if (compiled.ok) expect(compiled.fields[0]?.description).toBe('Helpful');
        continue;
      }
      const entry = booleans[flag.key];
      expect(entry).toBeDefined();
      if (!entry) continue;
      const compiled = compileZodSource(
        `z.object({ field: z.string().meta({ ${flag.key}: ${entry.value} }) })`
      );
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      const field = compiled.fields[0] as unknown as Record<string, unknown>;
      expect(field[entry.flag]).toBe(entry.value);
    }
  });
});
