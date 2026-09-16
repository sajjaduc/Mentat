/**
 * `normalizeToolCalls` guards the boundary between a provider's raw tool-call
 * payload and the runner: models emit malformed JSON often enough that a parse
 * failure must degrade to a recorded raw string, never a crashed run.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeToolCalls } from '../../../src/lib/server/providers/types';

describe('normalizeToolCalls', () => {
  test('parses string arguments into an object', () => {
    const { toolCalls, parseErrors } = normalizeToolCalls([
      { id: 'call_1', function: { name: 'hubspot.get_contact', arguments: '{"id":"42"}' } }
    ]);
    expect(parseErrors).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.id).toBe('call_1');
    expect(toolCalls[0]?.name).toBe('hubspot.get_contact');
    expect(toolCalls[0]?.arguments).toEqual({ id: '42' });
    expect(toolCalls[0]?.rawArguments).toBe('{"id":"42"}');
  });

  test('accepts object-form arguments and re-serializes them', () => {
    const { toolCalls, parseErrors } = normalizeToolCalls([
      { function: { name: 'ticket.create', arguments: { title: 'New', priority: 'high' } } }
    ]);
    expect(parseErrors).toEqual([]);
    expect(toolCalls[0]?.arguments).toEqual({ title: 'New', priority: 'high' });
    expect(toolCalls[0]?.rawArguments).toBe('{"title":"New","priority":"high"}');
  });

  test('records a parse error for malformed JSON but still returns the call', () => {
    const { toolCalls, parseErrors } = normalizeToolCalls([
      { id: 'call_bad', function: { name: 'broken', arguments: '{"id": ' } }
    ]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.arguments).toEqual({});
    expect(toolCalls[0]?.rawArguments).toBe('{"id": ');
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]).toContain('broken');
  });

  test('rejects arguments that parse to a non-object', () => {
    const { toolCalls, parseErrors } = normalizeToolCalls([
      { function: { name: 'listy', arguments: '[1,2,3]' } }
    ]);
    expect(toolCalls[0]?.arguments).toEqual({});
    expect(parseErrors[0]).toContain('must be a JSON object');
  });

  test('synthesizes an id when the model omits one', () => {
    const { toolCalls } = normalizeToolCalls([{ function: { name: 'no_id', arguments: '{}' } }]);
    expect(toolCalls[0]?.id).toMatch(/^call_0_/);
  });

  test('skips entries without a function name and tolerates non-array input', () => {
    expect(normalizeToolCalls(null).toolCalls).toEqual([]);
    expect(normalizeToolCalls({ function: { name: 'x' } }).toolCalls).toEqual([]);
    const { toolCalls } = normalizeToolCalls([
      { id: 'a', function: { arguments: '{}' } },
      { id: 'b', function: { name: 'kept', arguments: '{}' } }
    ]);
    expect(toolCalls.map((call) => call.name)).toEqual(['kept']);
  });
});
