/**
 * Generation option precedence is a product contract: model defaults are the
 * baseline, an agent's execution config tunes them, and an explicit request wins.
 * Getting this wrong silently changes model behaviour, so it is pinned by tests.
 */
import { describe, expect, test } from 'bun:test';
import { resolveGenerationOptions } from '../../../src/lib/server/providers/models';

const model = {
  inferenceDefaults: {
    temperature: 0.1,
    topP: 0.5,
    topK: 20,
    numCtx: 4096,
    numPredict: 256,
    stop: ['END'],
    seed: 7,
    repeatPenalty: 1.1
  },
  maxOutputTokens: 512
};

describe('resolveGenerationOptions', () => {
  test('falls back to model inference defaults', () => {
    const resolved = resolveGenerationOptions(model, null, {});
    expect(resolved.temperature).toBe(0.1);
    expect(resolved.topP).toBe(0.5);
    expect(resolved.topK).toBe(20);
    expect(resolved.maxOutputTokens).toBe(512);
    expect(resolved.stop).toEqual(['END']);
    expect(resolved.seed).toBe(7);
    expect(resolved.options).toEqual({ num_ctx: 4096, repeat_penalty: 1.1 });
  });

  test('agent execution config overrides model defaults', () => {
    const resolved = resolveGenerationOptions(
      model,
      { temperature: 0.2, topP: 0.6, maxOutputTokens: 128 },
      {}
    );
    expect(resolved.temperature).toBe(0.2);
    expect(resolved.topP).toBe(0.6);
    expect(resolved.maxOutputTokens).toBe(128);
    // Untouched values still come from the model row.
    expect(resolved.topK).toBe(20);
    expect(resolved.seed).toBe(7);
  });

  test('an explicit request overrides both', () => {
    const resolved = resolveGenerationOptions(
      model,
      { temperature: 0.2, topP: 0.6, maxOutputTokens: 128 },
      {
        temperature: 0.9,
        maxOutputTokens: 64,
        stop: ['STOP'],
        seed: 99,
        options: { num_ctx: 8192 }
      }
    );
    expect(resolved.temperature).toBe(0.9);
    expect(resolved.topP).toBe(0.6);
    expect(resolved.maxOutputTokens).toBe(64);
    expect(resolved.stop).toEqual(['STOP']);
    expect(resolved.seed).toBe(99);
    // Request options win, but model defaults survive.
    expect(resolved.options).toEqual({ num_ctx: 8192, repeat_penalty: 1.1 });
  });

  test('falls back to numPredict when the model has no maxOutputTokens column', () => {
    const resolved = resolveGenerationOptions(
      { inferenceDefaults: { numPredict: 96 }, maxOutputTokens: null },
      null,
      {}
    );
    expect(resolved.maxOutputTokens).toBe(96);
  });

  test('omits unset values and always returns an options object', () => {
    const resolved = resolveGenerationOptions(
      { inferenceDefaults: null, maxOutputTokens: null },
      null,
      {}
    );
    expect(resolved.temperature).toBeUndefined();
    expect(resolved.topP).toBeUndefined();
    expect(resolved.topK).toBeUndefined();
    expect(resolved.maxOutputTokens).toBeUndefined();
    expect(resolved.options).toEqual({});
  });

  test('resolves reasoning with the same precedence and merges native overrides', () => {
    const model = {
      inferenceDefaults: {
        reasoningEffort: 'low' as const,
        reasoningOptions: { budget: 1000, keep: 'model' }
      },
      maxOutputTokens: null
    };
    const agent = { reasoningEffort: 'high' as const, reasoningOptions: { budget: 4000 } };

    const resolved = resolveGenerationOptions(model, agent, {});
    expect(resolved.reasoningEffort).toBe('high');
    expect(resolved.reasoningOptions).toEqual({ budget: 4000, keep: 'model' });

    const explicit = resolveGenerationOptions(model, agent, {
      reasoningEffort: 'off',
      reasoningOptions: { budget: 250 }
    });
    expect(explicit.reasoningEffort).toBe('off');
    expect(explicit.reasoningOptions).toEqual({ budget: 250, keep: 'model' });

    const modelOnly = resolveGenerationOptions(model, null, {});
    expect(modelOnly.reasoningEffort).toBe('low');
    expect(modelOnly.reasoningOptions).toEqual({ budget: 1000, keep: 'model' });
  });
});
