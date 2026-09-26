import assert from 'node:assert/strict';
import test from 'node:test';

import * as dataService from '../dist/services/data-service.js';

const sessions = [
  {
    date: '2026-01-02',
    time: '09:05',
    source: 'Claude Code',
    file: 'claude.jsonl',
    cost: 3,
    input_tokens: 10,
    output_tokens: 20,
    cache_read: 30,
    cache_write: 40,
    model: 'claude-3-5-sonnet',
    hours: {
      9: { cost: 1, input_tokens: 1, output_tokens: 2, cache_read: 3, cache_write: 4 },
      10: { cost: 2, input_tokens: 9, output_tokens: 18, cache_read: 27, cache_write: 36 },
    },
  },
  {
    date: '2026-01-02',
    time: '10:15',
    source: 'Codex',
    file: 'codex.jsonl',
    cost: 5,
    input_tokens: 5,
    output_tokens: 10,
    cache_read: 15,
    cache_write: 20,
    model: 'gpt-5.6-luna',
    hours: {
      10: { cost: 5, input_tokens: 5, output_tokens: 10, cache_read: 15, cache_write: 20 },
    },
  },
  {
    date: '2026-01-03',
    time: '11:30',
    source: 'Claude Desktop',
    file: 'legacy.jsonl',
    cost: 7,
    input_tokens: 7,
    output_tokens: 14,
    cache_read: 21,
    cache_write: 28,
    model: 'claude-opus-4-6',
  },
];

function history(options) {
  assert.equal(
    typeof dataService.getHistoryChart,
    'function',
    'data-service must export getHistoryChart',
  );
  return dataService.getHistoryChart(sessions, options);
}

test('1d history groups USD and tokens by the requested dimension', () => {
  const byHarness = history({ timeframe: '1d', groupBy: 'harness', days: 0 });
  assert.equal(byHarness.timeframe, '1d');
  assert.equal(byHarness.groupBy, 'harness');
  assert.deepEqual(
    byHarness.buckets.find(bucket => bucket.timestamp === '2026-01-02'),
    {
      timestamp: '2026-01-02',
      values: {
        'Claude Code': { usd: 3, tokens: 100 },
        Codex: { usd: 5, tokens: 50 },
      },
    },
  );

  const byModel = history({ timeframe: '1d', groupBy: 'model', days: 0 });
  assert.deepEqual(
    byModel.buckets.find(bucket => bucket.timestamp === '2026-01-02'),
    {
      timestamp: '2026-01-02',
      values: {
        Sonnet: { usd: 3, tokens: 100 },
        'Codex Luna': { usd: 5, tokens: 50 },
      },
    },
  );
  assert.deepEqual(
    byModel.buckets.find(bucket => bucket.timestamp === '2026-01-03'),
    {
      timestamp: '2026-01-03',
      values: {
        Opus: { usd: 7, tokens: 70 },
      },
    },
  );
});

test('1h history uses Session.hours and does not synthesize legacy hourly usage', () => {
  const byHarness = history({ timeframe: '1h', groupBy: 'harness', days: 0 });
  assert.equal(byHarness.timeframe, '1h');
  assert.deepEqual(
    byHarness.buckets.map(bucket => bucket.timestamp),
    ['2026-01-02T09:00', '2026-01-02T10:00'],
  );
  assert.deepEqual(
    byHarness.buckets.find(bucket => bucket.timestamp === '2026-01-02T10:00'),
    {
      timestamp: '2026-01-02T10:00',
      values: {
        'Claude Code': { usd: 2, tokens: 90 },
        Codex: { usd: 5, tokens: 50 },
      },
    },
  );

  const byModel = history({ timeframe: '1h', groupBy: 'model', days: 0 });
  assert.deepEqual(
    byModel.buckets.find(bucket => bucket.timestamp === '2026-01-02T09:00'),
    {
      timestamp: '2026-01-02T09:00',
      values: {
        Sonnet: { usd: 1, tokens: 10 },
      },
    },
  );

  const hourlyUsd = byModel.buckets.reduce(
    (sum, bucket) => sum + Object.values(bucket.values).reduce((bucketSum, value) => bucketSum + value.usd, 0),
    0,
  );
  assert.equal(hourlyUsd, 8);
});

test('datetime range includes and clips a session with activity after its start time', () => {
  const filtered = dataService.filterSessions([sessions[0]], {
    from: '2026-01-02T10:00',
    to: '2026-01-02T10:59',
  });

  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].hours, {
    10: { cost: 2, input_tokens: 9, output_tokens: 18, cache_read: 27, cache_write: 36 },
  });
  assert.deepEqual(
    {
      cost: filtered[0].cost,
      input_tokens: filtered[0].input_tokens,
      output_tokens: filtered[0].output_tokens,
      cache_read: filtered[0].cache_read,
      cache_write: filtered[0].cache_write,
    },
    { cost: 2, input_tokens: 9, output_tokens: 18, cache_read: 27, cache_write: 36 },
  );
  assert.deepEqual(dataService.getSourceStats(filtered), { 'Claude Code': 2 });
  assert.deepEqual(dataService.getSourceUsage(filtered), {
    'Claude Code': { cost: 2, sessions: 1, tokens: 90 },
  });
  assert.deepEqual(dataService.getModelUsage(filtered), {
    'claude-3-5-sonnet': { cost: 2, sessions: 1, tokens: 90 },
  });
  assert.deepEqual(dataService.getModelStats(filtered), {
    'claude-3-5-sonnet': 2,
  });
  assert.deepEqual(dataService.getHeatmapData(filtered), [
    { date: '2026-01-02', hour: 10, cost: 2, sessions: 1 },
  ]);
  assert.equal(dataService.getHourlyStats(filtered)[9].cost, 0);
  assert.equal(dataService.getHourlyStats(filtered)[10].cost, 2);
});

test('model usage aggregates cost, tokens, and sessions while preserving the legacy cost adapter', () => {
  const usage = dataService.getModelUsage([
    sessions[0],
    { ...sessions[0], cost: 1.235, input_tokens: 1, output_tokens: 2, cache_read: 3, cache_write: 4 },
    { ...sessions[1], model: '', cost: 0.335 },
  ]);

  assert.deepEqual(usage, {
    'claude-3-5-sonnet': { cost: 4.24, sessions: 2, tokens: 110 },
    Unknown: { cost: 0.34, sessions: 1, tokens: 50 },
  });
  assert.deepEqual(dataService.getModelStats([
    sessions[0],
    { ...sessions[0], cost: 1.235, input_tokens: 1, output_tokens: 2, cache_read: 3, cache_write: 4 },
    { ...sessions[1], model: '', cost: 0.335 },
  ]), {
    'claude-3-5-sonnet': 4.24,
    Unknown: 0.34,
  });
});

test('date-only bounds and legacy datetime filtering retain their prior behavior', () => {
  const wholeDay = dataService.filterSessions([sessions[0]], {
    from: '2026-01-02',
    to: '2026-01-02',
  });
  assert.equal(wholeDay.length, 1);
  assert.equal(wholeDay[0].cost, 3);
  assert.deepEqual(Object.keys(wholeDay[0].hours), ['9', '10']);

  assert.equal(dataService.filterSessions([sessions[2]], {
    from: '2026-01-03T11:00',
    to: '2026-01-03T11:59',
  }).length, 1);
  assert.equal(dataService.filterSessions([sessions[2]], {
    from: '2026-01-03T12:00',
    to: '2026-01-03T12:59',
  }).length, 0);
});

test('legacy daily adapter keeps model USD and harness token dimensions', () => {
  const entries = dataService.getDailyModelChart(sessions, 0);
  assert.deepEqual(
    entries.find(entry => entry.date === '2026-01-02'),
    {
      date: '2026-01-02',
      models: { Sonnet: 3, 'Codex Luna': 5 },
      tokens: { 'Claude Code': 100, Codex: 50 },
    },
  );
});

test('local day formatting follows the configured process timezone without a fixed UTC offset', {
  concurrency: false,
}, () => {
  assert.equal(
    typeof dataService.formatLocalDay,
    'function',
    'data-service must export formatLocalDay',
  );
  if (typeof dataService.formatLocalDay !== 'function') return;

  const previousTimezone = process.env.TZ;
  try {
    const instant = new Date('2026-01-02T01:00:00Z');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(dataService.formatLocalDay(instant), '2026-01-01');
    process.env.TZ = 'Europe/Moscow';
    assert.equal(dataService.formatLocalDay(instant), '2026-01-02');
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
