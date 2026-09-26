import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getPricing } from '@harness-analyzer/core';
import { collectClaudeCode } from '../../core/dist/parsers/claude-code.js';
import { getCacheExpiryStats } from '../dist/services/data-service.js';

const MINUTE = 60_000;
const MODEL = 'claude-sonnet-4';
const START = Date.parse('2026-01-02T10:00:00.000Z');

function usageEvent(timestamp_ms, overrides = {}) {
  return {
    timestamp_ms,
    model: MODEL,
    cost: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    ...overrides,
  };
}

function session(events, overrides = {}) {
  return {
    date: '2026-01-02',
    time: '10:00',
    source: 'Claude Code',
    file: 'session.jsonl',
    sessionId: 'session-1',
    cost: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    model: MODEL,
    events,
    ...overrides,
  };
}

function statsAfterGap(gapMs, currentOverrides, previousOverrides = {}) {
  return getCacheExpiryStats([session([
    usageEvent(START, { cache_read: 1_000_000, ...previousOverrides }),
    usageEvent(START + gapMs, currentOverrides),
  ])]);
}

test('cache expiry pricing covers the current Claude model families', () => {
  assert.deepEqual(getPricing('claude-opus-4-8'), {
    input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5,
  });
  assert.deepEqual(getPricing('claude-opus-5'), {
    input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5,
  });
  assert.deepEqual(getPricing('claude-fable-5'), {
    input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1,
  });
});

test('Claude JSONL preserves explicit 5m and 1h cache-write events', () => {
  const previousHome = process.env.HOME;
  const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-expiry-fixture-'));
  const projectDir = path.join(fixtureHome, '.claude', 'projects', 'fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session.jsonl'), `${JSON.stringify({
    timestamp: '2026-01-02T10:00:00.000Z',
    sessionId: 'fixture-session',
    cwd: '/fixture/project',
    message: {
      role: 'assistant',
      model: MODEL,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 300,
        cache_creation: {
          ephemeral_5m_input_tokens: 100,
          ephemeral_1h_input_tokens: 200,
        },
      },
    },
  })}\n`);

  try {
    process.env.HOME = fixtureHome;
    const sessions = collectClaudeCode();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].events, [usageEvent(Date.parse('2026-01-02T10:00:00.000Z'), {
      input_tokens: 100,
      output_tokens: 20,
      cache_read: 400,
      cache_write: 300,
      cache_write_5m: 100,
      cache_write_1h: 200,
      cost: 0.002295,
    })]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
});

test('5m expiry uses strict 4:59 and 5:01 boundaries', () => {
  const before = statsAfterGap(4 * MINUTE + 59_000, {
    cache_write: 1_000_000,
    cache_write_5m: 1_000_000,
  });
  const after = statsAfterGap(5 * MINUTE + 1_000, {
    cache_write: 1_000_000,
    cache_write_5m: 1_000_000,
  });

  assert.equal(before.incidents, 0);
  assert.equal(after.incidents, 1);
  assert.equal(after.estimated_expired_tokens, 1_000_000);
  assert.equal(after.estimated_lost_cost, 3.45);
  assert.deepEqual(after.by_ttl['5m'], { cost: 3.45, tokens: 1_000_000, incidents: 1 });
});

test('1h expiry uses strict 59:59 and 60:01 boundaries', () => {
  const before = statsAfterGap(59 * MINUTE + 59_000, {
    cache_write: 1_000_000,
    cache_write_1h: 1_000_000,
  });
  const after = statsAfterGap(60 * MINUTE + 1_000, {
    cache_write: 1_000_000,
    cache_write_1h: 1_000_000,
  });

  assert.equal(before.incidents, 0);
  assert.equal(after.incidents, 1);
  assert.equal(after.estimated_expired_tokens, 1_000_000);
  assert.equal(after.estimated_lost_cost, 5.7);
  assert.deepEqual(after.by_ttl['1h'], { cost: 5.7, tokens: 1_000_000, incidents: 1 });
});

test('expired tokens are capped by the previous cacheable prefix', () => {
  const result = statsAfterGap(6 * MINUTE, {
    cache_write: 2_000_000,
    cache_write_5m: 2_000_000,
  }, { cache_read: 400_000 });

  assert.equal(result.estimated_expired_tokens, 400_000);
  assert.equal(result.estimated_lost_cost, 1.38);
});

test('mixed TTL writes share the cap proportionally', () => {
  const result = statsAfterGap(61 * MINUTE, {
    cache_write: 1_200_000,
    cache_write_5m: 600_000,
    cache_write_1h: 600_000,
  });

  assert.deepEqual(result.by_ttl, {
    '5m': { cost: 1.725, tokens: 500_000, incidents: 1 },
    '1h': { cost: 2.85, tokens: 500_000, incidents: 1 },
  });
  assert.equal(result.estimated_expired_tokens, 1_000_000);
  assert.equal(result.estimated_lost_cost, 4.575);
  assert.equal(result.incidents, 2);
  assert.equal(result.total_idle_minutes, 61);
});

test('a model change breaks the cache-expiry sequence', () => {
  const result = statsAfterGap(6 * MINUTE, {
    model: 'claude-opus-4-6',
    cache_write: 1_000_000,
    cache_write_5m: 1_000_000,
  });

  assert.equal(result.incidents, 0);
  assert.equal(result.estimated_expired_tokens, 0);
});

test('the previous event may precede the selected range', () => {
  const currentTimestamp = START + 6 * MINUTE;
  const result = getCacheExpiryStats([session([
    usageEvent(START, { cache_read: 1_000_000 }),
    usageEvent(currentTimestamp, { cache_write: 1_000_000, cache_write_5m: 1_000_000 }),
  ])], {
    from: new Date(currentTimestamp).toISOString(),
    to: new Date(currentTimestamp).toISOString(),
  });

  assert.equal(result.incidents, 1);
  assert.equal(result.top_incidents[0].timestamp, new Date(currentTimestamp).toISOString());
  assert.deepEqual(result.top_incidents[0], {
    timestamp: new Date(currentTimestamp).toISOString(),
    source: 'Claude Code',
    model: MODEL,
    session_id: 'session-1',
    title: undefined,
    project: undefined,
    idle_minutes: 6,
    ttl: '5m',
    estimated_cost: 3.45,
    estimated_tokens: 1_000_000,
    confidence: 'estimated',
  });
});

test('empty and event-less inputs report zero values and coverage', () => {
  const empty = getCacheExpiryStats([]);
  const legacy = getCacheExpiryStats([session(undefined)]);

  for (const result of [empty, legacy]) {
    assert.equal(result.methodology, 'heuristic-v1');
    assert.equal(result.estimated_lost_cost, 0);
    assert.equal(result.estimated_expired_tokens, 0);
    assert.equal(result.incidents, 0);
    assert.deepEqual(result.top_incidents, []);
  }
  assert.deepEqual(empty.coverage, {
    eligible_sessions: 0,
    excluded_sessions: 0,
    analyzed_events: 0,
    sources: [],
  });
  assert.deepEqual(legacy.coverage, {
    eligible_sessions: 0,
    excluded_sessions: 1,
    analyzed_events: 0,
    sources: [],
  });
});

test('cache-expiry route keeps the raw predecessor outside from', async () => {
  process.env.NODE_ENV = 'test';
  const { createApp } = await import('../dist/server.js');
  const previousTimestamp = Date.parse('2026-01-01T23:50:00.000Z');
  const currentTimestamp = Date.parse('2026-01-02T00:01:00.000Z');
  const rawSessions = [
    session([usageEvent(previousTimestamp, { cache_read: 1_000_000 })], {
      date: '2026-01-01', time: '23:50', file: 'previous.jsonl',
    }),
    session([usageEvent(currentTimestamp, { cache_write: 1_000_000, cache_write_5m: 1_000_000 })], {
      date: '2026-01-02', time: '00:01', file: 'current.jsonl',
    }),
  ];
  const app = createApp({
    isReady: () => true,
    dataProvider: () => ({ sessions: rawSessions, summary: {}, sourceResults: {} }),
    authVerifier: async () => ({ subject: 'test-user', services: { 'harness-analyzer': 'admin' } }),
  });

  const response = await app.request(
    `/api/charts/cache-expiry?from=${encodeURIComponent('2026-01-02T00:00:00.000Z')}`,
    { headers: { Authorization: 'Bearer test-token' } },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.incidents, 1);
  assert.equal(body.estimated_expired_tokens, 1_000_000);
  assert.deepEqual(body.coverage, {
    eligible_sessions: 1,
    excluded_sessions: 0,
    analyzed_events: 1,
    sources: ['Claude Code'],
  });
});
