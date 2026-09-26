import assert from 'node:assert/strict';
import test from 'node:test';

import { getProjectStats } from '../dist/services/data-service.js';

function cents(usd) {
  return Math.round(usd * 100);
}

function assertExactBreakdownCents(project) {
  const totalCents = cents(project.cost);
  for (const field of ['byModel', 'byHarness']) {
    assert.equal(
      Object.values(project[field]).reduce((sum, value) => sum + cents(value.usd), 0),
      totalCents,
    );
  }
}

test('project stats aggregate totals and breakdowns by cwd and preserve cost sorting', () => {
  const stats = getProjectStats([
    {
      cwd: '/work/alpha',
      cost: 1.111,
      source: 'Claude Code',
      model: 'claude-sonnet',
      input_tokens: 10,
      output_tokens: 20,
      cache_read: 30,
      cache_write: 40,
    },
    {
      cwd: '/work/alpha',
      cost: 2.222,
      source: 'Claude Code',
      model: 'claude-sonnet',
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 3,
      cache_write: 4,
    },
    {
      cwd: '/work/alpha',
      cost: 1.444,
      source: 'Codex',
      model: 'gpt-5',
      input_tokens: 5,
      output_tokens: 6,
      cache_read: 7,
      cache_write: 8,
    },
    {
      cwd: '/work/alpha',
      cost: 0.226,
      source: '',
      model: '',
      input_tokens: 9,
      output_tokens: 10,
      cache_read: 11,
      cache_write: 12,
    },
    {
      cost: 8.009,
      source: 'Claude Desktop',
      model: 'claude-opus',
      input_tokens: 5,
      output_tokens: 6,
      cache_read: 7,
      cache_write: 8,
    },
  ]);

  assert.deepEqual(stats, [
    {
      cwd: '(no project)',
      cost: 8.01,
      tokens: 26,
      sessions: 1,
      sources: ['Claude Desktop'],
      models: ['claude-opus'],
      byModel: {
        'claude-opus': { usd: 8.01, tokens: 26, sessions: 1 },
      },
      byHarness: {
        'Claude Desktop': { usd: 8.01, tokens: 26, sessions: 1 },
      },
    },
    {
      cwd: '/work/alpha',
      cost: 5,
      tokens: 178,
      sessions: 4,
      sources: ['Claude Code', 'Codex', 'Unknown'],
      models: ['claude-sonnet', 'gpt-5', 'Unknown'],
      byModel: {
        'claude-sonnet': { usd: 3.33, tokens: 110, sessions: 2 },
        'gpt-5': { usd: 1.44, tokens: 26, sessions: 1 },
        Unknown: { usd: 0.23, tokens: 42, sessions: 1 },
      },
      byHarness: {
        'Claude Code': { usd: 3.33, tokens: 110, sessions: 2 },
        Codex: { usd: 1.44, tokens: 26, sessions: 1 },
        Unknown: { usd: 0.23, tokens: 42, sessions: 1 },
      },
    },
  ]);

  for (const project of stats) {
    for (const [keysField, breakdownField] of [
      ['models', 'byModel'],
      ['sources', 'byHarness'],
    ]) {
      const breakdown = Object.values(project[breakdownField]);
      assert.deepEqual(Object.keys(project[breakdownField]), project[keysField]);
      assert.equal(breakdown.reduce((sum, value) => sum + value.tokens, 0), project.tokens);
      assert.equal(breakdown.reduce((sum, value) => sum + value.sessions, 0), project.sessions);
    }
    assertExactBreakdownCents(project);
  }
});

test('project breakdowns allocate live-scale rounding remainders deterministically', () => {
  const [project] = getProjectStats([
    {
      cwd: '/work/live',
      cost: 6869.565,
      source: 'Harness A',
      model: 'model-a',
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 3,
      cache_write: 4,
    },
    {
      cwd: '/work/live',
      cost: 420.035,
      source: 'Harness B',
      model: 'model-b',
      input_tokens: 5,
      output_tokens: 6,
      cache_read: 7,
      cache_write: 8,
    },
  ]);

  assert.equal(cents(project.cost), 728960);
  assert.deepEqual(project.byModel, {
    'model-a': { usd: 6869.57, tokens: 10, sessions: 1 },
    'model-b': { usd: 420.03, tokens: 26, sessions: 1 },
  });
  assert.deepEqual(project.byHarness, {
    'Harness A': { usd: 6869.57, tokens: 10, sessions: 1 },
    'Harness B': { usd: 420.03, tokens: 26, sessions: 1 },
  });
  assertExactBreakdownCents(project);
});

test('project breakdowns preserve cents across single and many tiny positive categories', () => {
  const tinySessions = Array.from({ length: 250 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return {
      cwd: '/work/tiny-many',
      cost: 0.00004,
      source: `Harness ${suffix}`,
      model: `model-${suffix}`,
      input_tokens: 1,
      output_tokens: 0,
      cache_read: 0,
      cache_write: 0,
    };
  });
  const projects = getProjectStats([
    ...tinySessions,
    {
      cwd: '/work/tiny-single',
      cost: 0.006,
      source: 'Single Harness',
      model: 'single-model',
      input_tokens: 0,
      output_tokens: 1,
      cache_read: 0,
      cache_write: 0,
    },
  ]);
  const many = projects.find(project => project.cwd === '/work/tiny-many');
  const single = projects.find(project => project.cwd === '/work/tiny-single');

  assert.equal(cents(many.cost), 1);
  assert.equal(Object.keys(many.byModel).length, 250);
  assert.equal(Object.keys(many.byHarness).length, 250);
  assert.equal(many.byModel['model-000'].usd, 0.01);
  assert.equal(many.byHarness['Harness 000'].usd, 0.01);
  assert.equal(Object.values(many.byModel).filter(value => cents(value.usd) > 0).length, 1);
  assert.equal(Object.values(many.byHarness).filter(value => cents(value.usd) > 0).length, 1);
  assertExactBreakdownCents(many);

  assert.equal(cents(single.cost), 1);
  assert.equal(single.byModel['single-model'].usd, 0.01);
  assert.equal(single.byHarness['Single Harness'].usd, 0.01);
  assertExactBreakdownCents(single);
});
