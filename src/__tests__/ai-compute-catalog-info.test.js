'use strict';

const { entries } = require('../services/ai-compute-catalog');

test('all catalog entries have readable use cases, integration steps and attributed source summaries', () => {
  expect(entries).toHaveLength(35);
  expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  for (const entry of entries) {
    expect(entry.id).toMatch(/^[a-z0-9-]+$/);
    expect(entry.details.problem.length).toBeGreaterThan(30);
    expect(entry.details.summary.length).toBeGreaterThan(30);
    expect(entry.details.integration.length).toBeGreaterThanOrEqual(2);
    expect(entry.details.sources.length).toBeGreaterThanOrEqual(1);
    expect(entry.details.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const source of entry.details.sources) {
      const url = new URL(source.url);
      expect(url.protocol).toBe('https:');
      expect(['huggingface.co', 'ollama.com', 'github.com', 'hf.co']).toContain(url.hostname);
      expect(source.label.length).toBeGreaterThan(3);
    }
  }
});

test('reviewed specialist metadata cannot be mistaken for a runnable pinned recipe', () => {
  const models = entries.filter(e => e.integrationRequired);
  expect(models).toHaveLength(14);
  for (const entry of models) {
    expect(entry).toMatchObject({ tier: 'planned', deployable: false, downloadable: false });
    expect(entry.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(entry).not.toHaveProperty('revision');
    expect(entry).not.toHaveProperty('runtime');
    expect(entry).not.toHaveProperty('memoryBytes');
  }
});

test('two image generators and distinct Romanian/multilingual speech options describe their actual limits', () => {
  expect(entries.filter(e => e.capability === 'text-to-image').map(e => e.id)).toEqual(['flux2-klein4b', 'z-image-turbo']);
  const piper = entries.find(e => e.id === 'piper-ro-mihai');
  const qwen = entries.find(e => e.id === 'qwen3-tts17b');
  expect(piper.details.summary).toContain('Romanian');
  expect(piper.details.integration.join(' ')).toContain('Piper 1.5+');
  expect(piper.details.sources.some(s => s.url.endsWith('/MODEL_CARD'))).toBe(true);
  expect(qwen.details.notes.join(' ')).toContain('Romanian is not among');
  expect(qwen.capability).toBe('text-to-speech');
});
