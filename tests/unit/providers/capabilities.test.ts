/**
 * Capability heuristics are the single place that decides whether Mentat will
 * offer tools, vision or JSON mode for an Ollama model. They are pure and
 * table-driven so corrections are one-line changes with a regression test.
 */
import { describe, expect, test } from 'bun:test';
import {
  detectModelCapabilities,
  isEmbeddingModel,
  isVisionModel
} from '../../../src/lib/server/providers/capabilities';

interface Case {
  key: string;
  family?: string;
  tools: boolean;
  vision: boolean;
  json: boolean;
  reasoning: boolean;
  embeddings?: boolean;
}

const CASES: Case[] = [
  // Tool-capable chat families.
  { key: 'llama3.1:8b', tools: true, vision: false, json: true, reasoning: false },
  { key: 'llama3.2:3b', tools: true, vision: false, json: true, reasoning: false },
  { key: 'llama3.3:70b', tools: true, vision: false, json: true, reasoning: false },
  { key: 'llama3.2-vision:11b', tools: true, vision: true, json: true, reasoning: false },
  { key: 'qwen2.5:7b', tools: true, vision: false, json: true, reasoning: false },
  { key: 'qwen2.5-coder:7b', tools: true, vision: false, json: true, reasoning: false },
  { key: 'qwen2.5-vl:7b', tools: true, vision: true, json: true, reasoning: false },
  { key: 'qwen3:8b', tools: true, vision: false, json: true, reasoning: true },
  { key: 'mistral-nemo:latest', tools: true, vision: false, json: true, reasoning: false },
  { key: 'firefunction-v2:latest', tools: true, vision: false, json: true, reasoning: false },
  { key: 'command-r:latest', tools: true, vision: false, json: true, reasoning: false },
  { key: 'command-r-plus:latest', tools: true, vision: false, json: true, reasoning: false },
  // Vision-only and reasoning-only models.
  { key: 'llava:13b', tools: false, vision: true, json: true, reasoning: false },
  { key: 'llava-llama3:8b', tools: false, vision: true, json: true, reasoning: false },
  { key: 'moondream:latest', tools: false, vision: true, json: true, reasoning: false },
  { key: 'deepseek-r1:8b', tools: false, vision: false, json: true, reasoning: true },
  { key: 'qwq:32b', tools: false, vision: false, json: true, reasoning: true },
  // Plain instruct models: JSON but no tools.
  { key: 'phi3:mini', tools: false, vision: false, json: true, reasoning: false },
  // Embedding models cannot generate at all.
  {
    key: 'nomic-embed-text:latest',
    tools: false,
    vision: false,
    json: false,
    reasoning: false,
    embeddings: true
  },
  {
    key: 'mxbai-embed-large:latest',
    tools: false,
    vision: false,
    json: false,
    reasoning: false,
    embeddings: true
  },
  // Unknown models fall back to the conservative chat defaults.
  { key: 'mystery-model:latest', tools: false, vision: false, json: true, reasoning: false }
];

describe('detectModelCapabilities', () => {
  for (const entry of CASES) {
    test(`${entry.key} → tools=${entry.tools} vision=${entry.vision} json=${entry.json}`, () => {
      const capabilities = detectModelCapabilities(
        entry.family ? { key: entry.key, family: entry.family } : entry.key
      );
      expect(capabilities.toolCalling).toBe(entry.tools);
      expect(capabilities.vision).toBe(entry.vision);
      expect(capabilities.jsonMode).toBe(entry.json);
      expect(capabilities.reasoning).toBe(entry.reasoning);
      expect(capabilities.embeddings).toBe(entry.embeddings ?? false);
      expect(capabilities.streaming).toBe(!(entry.embeddings ?? false));
    });
  }

  test('uses the family hint when the tag name is opaque', () => {
    const capabilities = detectModelCapabilities({
      key: 'internal-vision:latest',
      family: 'llava'
    });
    expect(capabilities.vision).toBe(true);
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.embeddings).toBe(false);
  });

  test('is pure: repeated calls agree and do not mutate the input', () => {
    const hints = { key: 'qwen3:8b', family: 'qwen3' };
    const frozen = JSON.stringify(hints);
    const first = detectModelCapabilities(hints);
    const second = detectModelCapabilities(hints);
    expect(first).toEqual(second);
    expect(JSON.stringify(hints)).toBe(frozen);
  });

  test('isEmbeddingModel and isVisionModel expose the same rules', () => {
    expect(isEmbeddingModel('nomic-embed-text:latest')).toBe(true);
    expect(isEmbeddingModel('llama3.1:8b')).toBe(false);
    expect(isVisionModel('llava:13b')).toBe(true);
    expect(isVisionModel('llama3.2-vision:11b')).toBe(true);
    expect(isVisionModel('llama3.1:8b')).toBe(false);
  });
});
