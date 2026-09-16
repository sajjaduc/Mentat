/**
 * Group selection arithmetic.
 *
 * The catalogue and every agent picker derive "is this namespace fully selected?" from
 * the same helpers, so these cases are the contract those surfaces rely on.
 */
import { describe, expect, test } from 'bun:test';
import {
  groupSelectionState,
  toggleGroupSelection
} from '../../../src/lib/ui/agents/tools/group-selection';

describe('groupSelectionState', () => {
  test('an empty group is none', () => {
    expect(groupSelectionState([], [])).toBe('none');
  });

  test('nothing selected is none', () => {
    expect(groupSelectionState([], ['a', 'b'])).toBe('none');
  });

  test('some selected is some', () => {
    expect(groupSelectionState(['a'], ['a', 'b'])).toBe('some');
  });

  test('all selected is all', () => {
    expect(groupSelectionState(['a', 'b', 'extra'], ['a', 'b'])).toBe('all');
  });
});

describe('toggleGroupSelection', () => {
  test('adds every missing key', () => {
    expect(toggleGroupSelection(['a'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('clears the whole group when it is fully selected', () => {
    expect(toggleGroupSelection(['a', 'b', 'other'], ['a', 'b'])).toEqual(['other']);
  });

  test('preserves selections outside the group', () => {
    expect(toggleGroupSelection(['keep'], ['a'])).toEqual(['keep', 'a']);
  });

  test('does not duplicate an already selected key', () => {
    const result = toggleGroupSelection(['a', 'keep'], ['a', 'b']);
    expect(result.filter((entry) => entry === 'a')).toHaveLength(1);
    expect(result).toEqual(['a', 'keep', 'b']);
  });

  test('an empty group is a no-op', () => {
    expect(toggleGroupSelection(['a'], [])).toEqual(['a']);
  });
});
