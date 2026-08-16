import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HandleConflictError,
  InvalidHandleError,
  MemoryProfileStore,
  PostgresProfileStore,
  StaleSnapshotError,
  normalizeHandle,
} from '../dist/profile-store.js';
import {
  InvalidSnapshotError,
  buildPublicSnapshot,
  validatePublicSnapshot,
} from '../dist/public-snapshot.js';
import { buildPrivateAnalyticsSnapshot } from '@claude-stats/core';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../dist/server.js');

const sessions = [{
  date: '2026-07-31',
  time: '10:15',
  source: 'Codex',
  file: '/secret/session.jsonl',
  cost: 2.5,
  input_tokens: 100,
  output_tokens: 20,
  cache_read: 200,
  cache_write: 30,
  model: 'gpt-5.6-sol',
  title: 'Secret product name',
  sessionId: 'secret-session-id',
  cwd: '/Users/alice/secret-project',
  history: [{ role: 'user', text: 'secret prompt' }],
  hours: {
    10: { cost: 2.5, input_tokens: 100, output_tokens: 20, cache_read: 200, cache_write: 30 },
  },
  events: [{
    timestamp_ms: new Date('2026-07-31T10:15:00').getTime(),
    model: 'gpt-5.6-sol',
    cost: 2.5,
    input_tokens: 100,
    output_tokens: 20,
    cache_read: 200,
    cache_write: 30,
    cache_write_5m: 30,
    cache_write_1h: 0,
  }],
}];

function snapshot(level = 'details', value = 2.5) {
  const result = buildPublicSnapshot(sessions, level);
  result.totals.total_cost = value;
  result.totals.total_tokens = Math.round(value * 1000);
  result.totals.total_sessions = Math.round(value * 10);
  return result;
}

function request(token, init = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

function syncRequest(token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Sync ${token}`);
  return { ...init, headers };
}

function appFor(store, options = {}) {
  const identities = {
    alice: { subject: 'alice-id', username: 'alice', services: { 'harness-analyzer': 'user' } },
    bob: { subject: 'bob-id', username: 'bob', services: { 'harness-analyzer': 'superuser' } },
    admin: { subject: 'admin-id', username: 'root-user', services: { 'harness-analyzer': 'admin' } },
    outsider: { subject: 'out-id', username: 'out', services: {} },
  };
  return createApp({
    isReady: options.isReady || (() => true),
    dataProvider: () => ({ sessions, summary: {}, sourceResults: {} }),
    profileStore: store,
    authVerifier: async token => {
      if (!identities[token]) throw new Error('invalid');
      return identities[token];
    },
    snapshotExportEnabled: options.snapshotExportEnabled,
    snapshotExportOwnerSubject: options.snapshotExportOwnerSubject,
  });
}

test('snapshot builder publishes aggregates without raw sessions, projects, or incidents', () => {
  const result = buildPublicSnapshot(sessions, 'details');
  const encoded = JSON.stringify(result);
  for (const secret of [
    '/secret/session.jsonl', 'Secret product name', 'secret-session-id',
    '/Users/alice/secret-project', 'secret prompt', 'top_incidents', 'projects',
  ]) {
    assert.equal(encoded.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(result.details.history.timeframe, '1d');
  assert.equal(result.details.hourly.length, 24);
  assert.equal(result.totals.total_tokens, 350);
  assert.doesNotThrow(() => validatePublicSnapshot(result));
});

test('snapshot validator rejects additional raw keys, invalid values, and oversized payloads', () => {
  const raw = snapshot('details');
  raw.sessions = sessions;
  assert.throws(() => validatePublicSnapshot(raw), InvalidSnapshotError);

  const negative = snapshot('totals');
  negative.totals.total_tokens = -1;
  assert.throws(() => validatePublicSnapshot(negative), InvalidSnapshotError);

  const incidents = snapshot('details');
  incidents.details.cache_expiry.top_incidents = [{ title: 'secret' }];
  assert.throws(() => validatePublicSnapshot(incidents), InvalidSnapshotError);

  const oversized = snapshot('totals');
  oversized.unexpected = 'x'.repeat(1_000_001);
  assert.throws(() => validatePublicSnapshot(oversized), InvalidSnapshotError);
});

test('handle normalization is strict and case-insensitively canonical', () => {
  assert.equal(normalizeHandle(' Alice-Smith '), 'alice-smith');
  for (const invalid of ['a', '-alice', 'alice-', 'alice--smith', 'ali_ce', 'dashboard', 'users']) {
    assert.throws(() => normalizeHandle(invalid), InvalidHandleError);
  }
});

test('memory store defaults private, isolates owners, clones values, and rejects handle collisions', async () => {
  const store = new MemoryProfileStore();
  await store.init();
  const alice = await store.upsertSharing('alice', { handle: 'Alice-One' });
  assert.equal(alice.visibility, 'private');
  assert.equal(alice.leaderboard_opt_in, false);
  await assert.rejects(() => store.upsertSharing('bob', { handle: 'alice-one' }), HandleConflictError);

  alice.handle = 'mutated';
  assert.equal((await store.getSharing('alice')).handle, 'alice-one');
  await store.saveSnapshot('alice', snapshot('details'));
  assert.equal(await store.getPublicProfile('alice-one'), null);
  await store.upsertSharing('alice', { handle: 'alice-one', visibility: 'details' });
  const publicResult = await store.getPublicProfile('ALICE-ONE');
  publicResult.snapshot.totals.total_cost = 999;
  assert.equal((await store.getPublicProfile('alice-one')).snapshot.totals.total_cost, 2.5);
});

test('details to totals downgrade removes stored details immediately', async () => {
  const store = new MemoryProfileStore();
  await store.upsertSharing('alice', { handle: 'alice-one', visibility: 'details' });
  await store.saveSnapshot('alice', snapshot('details'));
  assert.ok((await store.getPublicProfile('alice-one')).snapshot.details);

  await store.upsertSharing('alice', { handle: 'alice-one', visibility: 'totals' });
  assert.equal((await store.getPublicProfile('alice-one')).snapshot.details, undefined);
  await store.upsertSharing('alice', { handle: 'alice-one', visibility: 'private' });
  assert.equal(await store.getPublicProfile('alice-one'), null);
});

test('leaderboard contains only explicitly opted-in public profiles with deterministic ties', async () => {
  const store = new MemoryProfileStore();
  for (const [subject, handle, visibility, optIn, value] of [
    ['alice', 'alice-one', 'totals', true, 10],
    ['bob', 'bob-one', 'details', true, 10],
    ['carol', 'carol-one', 'private', true, 100],
    ['dave', 'dave-one', 'totals', false, 200],
  ]) {
    await store.upsertSharing(subject, { handle, visibility, leaderboard_opt_in: optIn });
    await store.saveSnapshot(subject, snapshot('details', value));
  }
  assert.deepEqual((await store.getLeaderboard('cost', 10)).map(user => user.handle), ['alice-one', 'bob-one']);
});

test('public routes bypass auth and collector readiness while private/nonexistent share one 404', async () => {
  const store = new MemoryProfileStore();
  await store.upsertSharing('alice', { handle: 'alice-one', visibility: 'totals' });
  await store.saveSnapshot('alice', snapshot('details'));
  await store.upsertSharing('bob', { handle: 'bob-one', visibility: 'private' });
  await store.saveSnapshot('bob', snapshot('details'));
  const app = appFor(store, { isReady: () => false });

  const visible = await app.request('/api/public/users/alice-one');
  assert.equal(visible.status, 200);
  assert.equal((await visible.json()).snapshot.details, undefined);
  assert.equal((await app.request('/api/public/users/bob-one')).status, 404);
  assert.equal((await app.request('/api/public/users/missing-user')).status, 404);
  assert.equal((await app.request('/api/public/leaderboard')).status, 200);
});

test('status reports profile storage initialization failure without exposing an error', async () => {
  const failedStore = {
    init: async () => { throw new Error('secret database details'); },
  };
  const app = appFor(failedStore);
  const response = await app.request('/api/status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ready: false,
    collector_ready: true,
    profile_storage_ready: false,
  });
});

test('me routes accept user/superuser/admin but global data remains admin-only', async () => {
  const app = appFor(new MemoryProfileStore());
  for (const token of ['alice', 'bob', 'admin']) {
    const response = await app.request('/api/me/sharing', request(token));
    assert.equal(response.status, 200);
    assert.equal(Object.hasOwn(await response.json(), 'subject'), false);
  }
  assert.equal((await app.request('/api/me/sharing', request('outsider'))).status, 403);
  assert.equal((await app.request('/api/summary', request('alice'))).status, 403);
  assert.equal((await app.request('/api/summary', request('bob'))).status, 403);
  assert.equal((await app.request('/api/summary', request('admin'))).status, 200);
});

test('sharing and snapshot routes isolate owners and enforce private-first profile creation', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store);
  assert.equal((await app.request('/api/me/public-snapshot', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot('totals')),
  }))).status, 409);

  const createAlice = await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: 'shared-user', visibility: 'private' }),
  }));
  assert.equal(createAlice.status, 200);
  const collision = await app.request('/api/me/sharing', request('bob', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: 'SHARED-USER' }),
  }));
  assert.equal(collision.status, 409);

  const upload = await app.request('/api/me/public-snapshot', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot('details')),
  }));
  assert.equal(upload.status, 200);
  await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility: 'details', leaderboard_opt_in: true }),
  }));
  assert.equal((await app.request('/api/public/users/shared-user')).status, 200);
  assert.equal(await store.getSharing('bob-id') !== null, true);
  assert.equal((await store.getSharing('bob-id')).visibility, 'private');
});

test('sync tokens are scoped, replaceable, and revocable', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store);
  const created = await app.request('/api/me/sync-token', request('alice', { method: 'POST' }));
  assert.equal(created.status, 200);
  const token = (await created.json()).token;
  assert.match(token, /^ha_sync_[A-Za-z0-9_-]{40,}$/);

  assert.equal((await app.request('/api/me/sharing', syncRequest(token))).status, 200);
  assert.equal((await app.request('/api/summary', syncRequest(token))).status, 403);
  const upload = await app.request('/api/me/public-snapshot', syncRequest(token, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot('details')),
  }));
  assert.equal(upload.status, 200);

  const replacement = await app.request('/api/me/sync-token', request('alice', { method: 'POST' }));
  const replacementToken = (await replacement.json()).token;
  assert.equal((await app.request('/api/me/sharing', syncRequest(token))).status, 401);
  assert.equal((await app.request('/api/me/sharing', syncRequest(replacementToken))).status, 200);
  assert.equal((await app.request('/api/me/sync-token', request('alice', { method: 'DELETE' }))).status, 200);
  assert.equal((await app.request('/api/me/sharing', syncRequest(replacementToken))).status, 401);
});

test('snapshot upload rejects an oversized body before JSON parsing', async () => {
  const app = appFor(new MemoryProfileStore());
  await app.request('/api/me/sharing', request('alice'));
  const body = JSON.stringify({ payload: 'x'.repeat(1_000_001) });
  const response = await app.request('/api/me/public-snapshot', request('alice', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
  }));
  assert.equal(response.status, 413);
});

test('private analytics are writable by a sync token and readable only by their owner', async () => {
  const app = appFor(new MemoryProfileStore());
  const tokenResponse = await app.request('/api/me/sync-token', request('alice', { method: 'POST' }));
  const syncToken = (await tokenResponse.json()).token;
  const privateSnapshot = buildPrivateAnalyticsSnapshot(sessions);
  const upload = await app.request('/api/me/analytics', syncRequest(syncToken, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(privateSnapshot),
  }));
  assert.equal(upload.status, 200);
  const ownerSessions = await app.request('/api/me/analytics/sessions', request('alice'));
  assert.equal(ownerSessions.status, 200);
  const stored = await ownerSessions.json();
  assert.equal(stored.total, 1);
  assert.equal(stored.sessions[0].file, 'remote');
  assert.equal(JSON.stringify(stored).includes('secret prompt'), false);
  const devices = await app.request('/api/me/analytics/charts/devices', request('alice'));
  assert.equal(devices.status, 200);
  assert.deepEqual((await devices.json()).map(device => ({ id: device.id, name: device.name })), [
    { id: 'legacy', name: 'Legacy device' },
  ]);
  assert.equal((await app.request('/api/me/analytics/sessions', request('bob'))).status, 404);
  assert.equal((await app.request('/api/me/analytics/sessions', syncRequest(syncToken))).status, 403);
  assert.equal((await app.request('/api/me/analytics/charts/devices', syncRequest(syncToken))).status, 403);
});

test('memory store aggregates latest snapshots per device without double-counting replacements', async () => {
  const store = new MemoryProfileStore();
  await store.upsertSharing('alice', { handle: 'alice-one' });
  const first = buildPrivateAnalyticsSnapshot(sessions, false, {
    id: 'device_alpha', name: 'Server Alpha', platform: 'linux', architecture: 'x64',
  });
  first.generated_at = '2026-08-16T10:00:00.000Z';
  const secondSessions = [{ ...sessions[0], date: '2026-08-01', cost: 4 }];
  const second = buildPrivateAnalyticsSnapshot(secondSessions, true, {
    id: 'device_beta', name: 'Server Beta', platform: 'linux', architecture: 'arm64',
  });
  second.generated_at = '2026-08-16T10:01:00.000Z';
  await store.savePrivateAnalytics('alice', first);
  await store.savePrivateAnalytics('alice', second);

  const replacement = buildPrivateAnalyticsSnapshot([{ ...sessions[0], cost: 7 }], false, first.device);
  replacement.generated_at = '2026-08-16T10:02:00.000Z';
  await store.savePrivateAnalytics('alice', replacement);

  const aggregate = await store.getPrivateAnalytics('alice');
  assert.equal(aggregate.sessions.length, 2);
  assert.deepEqual(aggregate.sessions.map(session => session.cost).sort((a, b) => a - b), [4, 7]);
  assert.equal(aggregate.generated_at, replacement.generated_at);
  assert.equal(aggregate.history_included, true);
  assert.equal(aggregate.device, undefined);
  assert.equal((await store.getPrivateAnalyticsDevices('alice')).length, 2);

  const stale = structuredClone(replacement);
  stale.generated_at = '2026-08-16T09:59:00.000Z';
  await assert.rejects(() => store.savePrivateAnalytics('alice', stale), StaleSnapshotError);
});

test('device chart is owner-only, date-filtered, sorted, and absent from public snapshots', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store);
  const alpha = buildPrivateAnalyticsSnapshot(sessions, false, {
    id: 'device_alpha', name: 'Server Alpha', platform: 'linux', architecture: 'x64',
  });
  const beta = buildPrivateAnalyticsSnapshot([{ ...sessions[0], date: '2026-08-01', cost: 4 }], false, {
    id: 'device_beta', name: 'Server Beta', platform: 'linux', architecture: 'arm64',
  });
  assert.equal((await app.request('/api/me/analytics', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alpha),
  }))).status, 200);
  assert.equal((await app.request('/api/me/analytics', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(beta),
  }))).status, 200);

  assert.equal((await app.request('/api/me/analytics/charts/devices')).status, 401);
  assert.equal((await app.request('/api/me/analytics/charts/devices', request('bob'))).status, 404);
  const response = await app.request('/api/me/analytics/charts/devices?from=2026-08-01', request('alice'));
  assert.equal(response.status, 200);
  const entries = await response.json();
  assert.deepEqual(entries.map(entry => entry.id), ['device_beta', 'device_alpha']);
  assert.deepEqual(entries[0], {
    id: 'device_beta',
    name: 'Server Beta',
    platform: 'linux',
    architecture: 'arm64',
    last_synced_at: entries[0].last_synced_at,
    cost: 4,
    tokens: 350,
    sessions: 1,
  });
  assert.equal(entries[1].cost, 0);
  assert.equal(entries[1].tokens, 0);
  assert.equal(entries[1].sessions, 0);

  await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: 'details' }),
  }));
  const publicProfile = await app.request('/api/public/users/alice');
  const publicBody = await publicProfile.json();
  assert.equal(publicBody.snapshot.totals.total_cost, 6.5);
  assert.equal(publicBody.snapshot.totals.total_sessions, 2);
  const encoded = JSON.stringify(publicBody);
  for (const privateValue of ['device_alpha', 'device_beta', 'Server Alpha', 'Server Beta']) {
    assert.equal(encoded.includes(privateValue), false, `leaked ${privateValue}`);
  }
});

test('snapshot source supports development default, explicit disable, and strict owner exception', async () => {
  const development = appFor(new MemoryProfileStore());
  assert.equal((await development.request('/api/me/public-snapshot-source?level=totals', request('alice'))).status, 200);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const productionDefault = appFor(new MemoryProfileStore());
  process.env.NODE_ENV = previousNodeEnv;
  assert.equal((await productionDefault.request('/api/me/public-snapshot-source?level=totals', request('alice'))).status, 403);

  const closed = appFor(new MemoryProfileStore(), { snapshotExportEnabled: false });
  assert.equal((await closed.request('/api/me/public-snapshot-source?level=totals', request('admin'))).status, 403);

  const owner = appFor(new MemoryProfileStore(), { snapshotExportEnabled: false, snapshotExportOwnerSubject: 'admin-id' });
  assert.equal((await owner.request('/api/me/public-snapshot-source?level=details', request('admin'))).status, 200);
  assert.equal((await owner.request('/api/me/public-snapshot-source?level=details', request('alice'))).status, 403);
  assert.equal((await owner.request('/api/me/public-snapshot-source?level=raw', request('admin'))).status, 400);

  const enabled = appFor(new MemoryProfileStore(), { snapshotExportEnabled: true });
  assert.equal((await enabled.request('/api/me/public-snapshot-source?level=totals', request('alice'))).status, 200);
});

test('Postgres store schema initialization is idempotent SQL', async () => {
  const calls = [];
  const pool = { query: async sql => { calls.push(sql); return { rows: [], rowCount: 0 }; } };
  const store = new PostgresProfileStore(pool);
  await store.init();
  await store.init();
  assert.equal(calls.length, 2);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS share_profiles/);
  assert.match(calls[0], /CREATE UNIQUE INDEX IF NOT EXISTS share_profiles_handle_lower_idx/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS public_snapshots/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS private_analytics_device_snapshots/);
  assert.match(calls[0], /PRIMARY KEY \(subject, device_id\)/);
});

test('Postgres private analytics prefer per-device rows and fall back to the legacy aggregate', async () => {
  const deviceSnapshot = buildPrivateAnalyticsSnapshot(sessions, false, {
    id: 'device_alpha', name: 'Server Alpha', platform: 'linux', architecture: 'x64',
  });
  let calls = 0;
  const deviceStore = new PostgresProfileStore({
    query: async sql => {
      calls += 1;
      assert.match(sql, /private_analytics_device_snapshots/);
      return { rows: [{
        device_id: 'device_alpha', device_name: 'Server Alpha', platform: 'linux', architecture: 'x64',
        generated_at: deviceSnapshot.generated_at, uploaded_at: deviceSnapshot.generated_at, snapshot: deviceSnapshot,
      }], rowCount: 1 };
    },
  });
  assert.equal((await deviceStore.getPrivateAnalytics('alice')).sessions.length, 1);
  assert.equal(calls, 1, 'legacy aggregate must not be queried when device rows exist');

  const legacySnapshot = buildPrivateAnalyticsSnapshot([{ ...sessions[0], cost: 9 }]);
  const legacyStore = new PostgresProfileStore({
    query: async sql => sql.includes('private_analytics_device_snapshots')
      ? { rows: [], rowCount: 0 }
      : { rows: [{ generated_at: legacySnapshot.generated_at, uploaded_at: legacySnapshot.generated_at, snapshot: legacySnapshot }], rowCount: 1 },
  });
  const legacy = await legacyStore.getPrivateAnalyticsDevices('alice');
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].device.id, 'legacy');
  assert.equal(legacy[0].device.name, 'Legacy device');
  assert.equal(legacy[0].snapshot.sessions[0].cost, 9);
});

test('Postgres store projects details out of totals-only public profiles', async () => {
  const stored = snapshot('details');
  const pool = {
    query: async () => ({
      rows: [{ handle: 'alice-one', display_name: 'Alice', visibility: 'totals', snapshot: structuredClone(stored) }],
      rowCount: 1,
    }),
  };
  const store = new PostgresProfileStore(pool);
  const result = await store.getPublicProfile('alice-one');
  assert.equal(result.snapshot.details, undefined);
  assert.ok(stored.details);
});
