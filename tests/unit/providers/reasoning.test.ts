/**
 * Reasoning is a portable level each provider maps to its own knob.
 *
 * These tests pin the mapping and the "never send an unsupported level" rule: an
 * agent that asks for `max` on a model that only accepts low/medium/high must fall
 * back (or send nothing) and say so, never fail the run.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyReasoning,
  detectReasoningSupport,
  isReasoningEffort,
  normalizeReasoningEfforts,
  reasoningSettingFrom,
  resolveReasoning,
  supportedReasoningEfforts,
  toAnthropicReasoning,
  toOllamaThink,
  toOpenAiReasoningEffort
} from '../../../src/lib/server/providers/reasoning';

describe('reasoning vocabulary', () => {
  test('recognises only the portable levels', () => {
    expect(isReasoningEffort('off')).toBe(true);
    expect(isReasoningEffort('max')).toBe(true);
    expect(isReasoningEffort('xhigh')).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });

  test('normalizes a declared set into canonical order and drops junk', () => {
    expect(normalizeReasoningEfforts(['high', 'off', 'nope', 'medium'])).toEqual([
      'off',
      'medium',
      'high'
    ]);
    expect(normalizeReasoningEfforts([])).toBeUndefined();
    expect(normalizeReasoningEfforts('high')).toBeUndefined();
  });
});

describe('detectReasoningSupport', () => {
  test('seeds known Ollama reasoning families', () => {
    expect(detectReasoningSupport({ providerType: 'ollama', key: 'qwen3:8b' })).toEqual({
      reasoning: true,
      reasoningEfforts: ['off', 'low', 'medium', 'high', 'max']
    });
    expect(detectReasoningSupport({ providerType: 'ollama', key: 'llama3.1:8b' })).toEqual({
      reasoning: false
    });
  });

  test('never offers off to a model that cannot disable thinking', () => {
    const detected = detectReasoningSupport({ providerType: 'ollama', key: 'gpt-oss:20b' });
    expect(detected.reasoning).toBe(true);
    expect(detected.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(detected.reasoningEfforts).not.toContain('off');
  });

  test('knows the OpenAI and Anthropic thinking families', () => {
    expect(detectReasoningSupport({ providerType: 'openai', key: 'o3-mini' }).reasoning).toBe(true);
    expect(detectReasoningSupport({ providerType: 'openai', key: 'gpt-5' }).reasoning).toBe(true);
    expect(detectReasoningSupport({ providerType: 'openai', key: 'gpt-4o' }).reasoning).toBe(false);
    expect(
      detectReasoningSupport({ providerType: 'anthropic', key: 'claude-sonnet-4-6' }).reasoning
    ).toBe(true);
    expect(
      detectReasoningSupport({ providerType: 'anthropic', key: 'claude-3-5-sonnet' }).reasoning
    ).toBe(false);
  });

  test('stays conservative for a generic compatible endpoint', () => {
    expect(
      detectReasoningSupport({ providerType: 'openai_compatible', key: 'o3-mini' }).reasoning
    ).toBe(false);
  });
});

describe('supportedReasoningEfforts', () => {
  test('returns nothing when the model does not declare reasoning', () => {
    expect(supportedReasoningEfforts({ reasoning: false }, 'ollama')).toEqual([]);
    expect(supportedReasoningEfforts(null, 'ollama')).toEqual([]);
  });

  test('prefers the declared set and falls back to the provider default', () => {
    expect(
      supportedReasoningEfforts({ reasoning: true, reasoningEfforts: ['low', 'high'] }, 'ollama')
    ).toEqual(['low', 'high']);
    expect(supportedReasoningEfforts({ reasoning: true }, 'ollama')).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max'
    ]);
    expect(supportedReasoningEfforts({ reasoning: true }, 'anthropic')).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max'
    ]);
  });
});

describe('provider mappings', () => {
  test('Ollama think is a boolean only for off', () => {
    expect(toOllamaThink('off')).toBe(false);
    expect(toOllamaThink('minimal')).toBe('low');
    expect(toOllamaThink('max')).toBe('max');
  });

  test('OpenAI reasoning_effort maps off to none', () => {
    expect(toOpenAiReasoningEffort('off')).toBe('none');
    expect(toOpenAiReasoningEffort('minimal')).toBe('minimal');
    expect(toOpenAiReasoningEffort('max')).toBe('max');
  });

  test('Anthropic disables thinking for off and otherwise sets effort', () => {
    expect(toAnthropicReasoning('off')).toEqual({ thinking: { type: 'disabled' } });
    expect(toAnthropicReasoning('minimal')).toEqual({ output_config: { effort: 'low' } });
    expect(toAnthropicReasoning('high')).toEqual({ output_config: { effort: 'high' } });
  });
});

describe('applyReasoning', () => {
  test('maps the level and lets a native override win', () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, 'anthropic', {
      effort: 'medium',
      options: { thinking: { type: 'enabled', budget_tokens: 4000 } }
    });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  });

  test('sends an override even with no level configured', () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, 'openai', { options: { reasoning_effort: 'low' } });
    expect(body).toEqual({ reasoning_effort: 'low' });
  });

  test('is a no-op without a setting', () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, 'ollama', null);
    expect(body).toEqual({});
  });
});

describe('resolveReasoning', () => {
  const supported = ['off', 'low', 'medium', 'high'] as const;

  test('agent wins over model, request wins over both', () => {
    expect(
      resolveReasoning({
        supported: [...supported],
        request: { effort: 'high' },
        agent: { effort: 'off' },
        model: { effort: 'low' }
      }).effort
    ).toBe('high');
    expect(
      resolveReasoning({
        supported: [...supported],
        agent: { effort: 'off' },
        model: { effort: 'low' }
      }).effort
    ).toBe('off');
  });

  test('falls back to the next source that is accepted and warns', () => {
    const resolved = resolveReasoning({
      supported: ['low', 'medium', 'high'],
      agent: { effort: 'off' },
      model: { effort: 'medium' }
    });
    expect(resolved.effort).toBe('medium');
    expect(resolved.warning).toContain('agent "off"');
    expect(resolved.warning).toContain('supported: low, medium, high');
  });

  test('drops everything and warns when reasoning is unsupported', () => {
    const resolved = resolveReasoning({
      supported: [],
      agent: { effort: 'high' },
      model: { effort: 'low' }
    });
    expect(resolved.effort).toBeUndefined();
    expect(resolved.warning).toContain('not supported by this model');
  });

  test('merges native overrides with the agent winning', () => {
    const resolved = resolveReasoning({
      supported: [...supported],
      model: { options: { budget: 1000, keep: 'model' } },
      agent: { options: { budget: 4000 } }
    });
    expect(resolved.options).toEqual({ budget: 4000, keep: 'model' });
    expect(resolved.effort).toBeUndefined();
  });
});

describe('reasoningSettingFrom', () => {
  test('extracts configured fields and ignores empties', () => {
    expect(reasoningSettingFrom({ reasoningEffort: 'low' })).toEqual({ effort: 'low' });
    expect(reasoningSettingFrom({ reasoningOptions: {} })).toBeNull();
    expect(reasoningSettingFrom(null)).toBeNull();
    expect(reasoningSettingFrom({ reasoningEffort: 'bogus' as never })).toBeNull();
  });
});
