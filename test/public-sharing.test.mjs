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
import { buildPrivateAnalyticsSnapshot } from '@harness-analyzer/core';

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
    alice: { subject: 'alice-id', username: 'alice', email: 'alice@example.com', services: { 'harness-analyzer': 'user' } },
    bob: { subject: 'bob-id', username: 'bob', email: ' Bob@Example.com ', services: { 'harness-analyzer': 'superuser' } },
    carol: { subject: 'carol-id', username: 'carol', email: 'carol@example.com', services: { 'harness-analyzer': 'user' } },
    admin: { subject: 'admin-id', username: 'root-user', services: { 'harness-analyzer': 'admin' } },
    outsider: { subject: 'out-id', username: 'out', services: {} },
  };
  return createApp({
    isReady: options.isReady || (() => true),
    dataProvider: () => ({ sessions, summary: {}, sourceResults: {} }),
    profileStore: store,
    authGroupsProvider: options.authGroupsProvider || (async () => []),
    authVerifier: async token => {
      if (!identities[token]) throw new Error('invalid');
      return identities[token];
    },
    snapshotExportEnabled: options.snapshotExportEnabled,
    snapshotExportOwnerSubject: options.snapshotExportOwnerSubject,
  });
}

function sharingPut(token, body) {
  return request(token, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const GROUP_ID = 'bd92d55c-24a5-41bc-9e78-40b9c515462c';
const OTHER_GROUP_ID = 'b5c035af-032c-4fee-a3de-5c6ddbc94c93';
function group(id = GROUP_ID, is_owner = true) {
  return { id, name: 'Friends', member_count: 2, is_owner };
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
  assert.equal(alice.share_sessions, false);
  assert.equal(alice.share_projects, false);
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

test('details to totals downgrade removes stored details and public page access immediately', async () => {
  const store = new MemoryProfileStore();
  await store.upsertSharing('alice', {
    handle: 'alice-one', visibility: 'details', share_sessions: true, share_projects: true,
  });
  await store.saveSnapshot('alice', snapshot('details'));
  assert.ok((await store.getPublicProfile('alice-one')).snapshot.details);

  const totals = await store.upsertSharing('alice', { handle: 'alice-one', visibility: 'totals' });
  assert.equal(totals.share_sessions, false);
  assert.equal(totals.share_projects, false);
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

test('public analytics pages use the same 404 for unknown, private, totals, and disabled profiles', async () => {
  const store = new MemoryProfileStore();
  for (const [subject, handle, visibility] of [
    ['private-id', 'private-user', 'private'],
    ['totals-id', 'totals-user', 'totals'],
    ['disabled-id', 'disabled-user', 'details'],
  ]) {
    await store.upsertSharing(subject, { handle, visibility });
    await store.saveSnapshot(subject, snapshot('details'));
    await store.savePrivateAnalytics(subject, buildPrivateAnalyticsSnapshot(sessions));
  }
  const app = appFor(store);
  for (const handle of ['missing-user', 'private-user', 'totals-user', 'disabled-user']) {
    for (const page of ['sessions', 'projects']) {
      const response = await app.request(`/api/public/users/${handle}/${page}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Not found' });
    }
  }
});

test('selected friends see shared pages while other viewers get the same 404 as a missing profile', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store);
  const privateAnalytics = buildPrivateAnalyticsSnapshot(sessions);
  await store.upsertSharing('alice-id', {
    handle: 'alice-one', visibility: 'details', audience: 'selected',
    allowed_emails: ['bob@example.com'], share_sessions: true, share_projects: true,
  });
  await store.saveSnapshot('alice-id', snapshot('details'));
  await store.savePrivateAnalytics('alice-id', privateAnalytics);

  for (const token of ['alice', 'bob']) {
    for (const page of ['', '/sessions', '/projects']) {
      const response = await app.request(`/api/public/users/alice-one${page}`, request(token));
      assert.equal(response.status, 200, `${token} ${page}`);
      const body = await response.json();
      const encoded = JSON.stringify(body);
      assert.equal(encoded.includes('bob@example.com'), false);
      assert.equal(encoded.includes('allowed_emails'), false);
      assert.equal(encoded.includes('allowed_group_ids'), false);
    }
  }

  for (const token of [null, 'carol', 'invalid']) {
    for (const page of ['', '/sessions', '/projects']) {
      const response = await app.request(`/api/public/users/alice-one${page}`, request(token));
      assert.equal(response.status, 404, `${token} ${page}`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Not found' });
    }
  }
  const missing = await app.request('/api/public/users/missing-user');
  assert.deepEqual(await missing.json(), { error: 'Not found' });
});

test('selected group access tracks current membership and fails closed on group outages', async () => {
  const store = new MemoryProfileStore();
  const memberships = new Map([['alice', [group()]], ['bob', [group(GROUP_ID, false)]]]);
  let unavailable = false;
  const app = appFor(store, { authGroupsProvider: async token => {
    if (unavailable) throw new Error('auth service unavailable');
    return memberships.get(token) || [];
  } });
  assert.equal((await app.request('/api/me/sharing', sharingPut('alice', {
    visibility: 'details', audience: 'selected', allowed_group_ids: [GROUP_ID],
    share_sessions: true, share_projects: true,
  }))).status, 200);
  await store.saveSnapshot('alice-id', snapshot('details'));
  await store.savePrivateAnalytics('alice-id', buildPrivateAnalyticsSnapshot(sessions));

  for (const page of ['', '/sessions', '/projects']) {
    assert.equal((await app.request(`/api/public/users/alice${page}`, request('bob'))).status, 200);
  }
  memberships.set('bob', []);
  for (const page of ['', '/sessions', '/projects']) {
    assert.equal((await app.request(`/api/public/users/alice${page}`, request('bob'))).status, 404);
  }
  memberships.set('bob', [group(GROUP_ID, false)]);
  unavailable = true;
  for (const page of ['', '/sessions', '/projects']) {
    const response = await app.request(`/api/public/users/alice${page}`, request('bob'));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  }
  assert.equal((await app.request('/api/public/users/alice', request('alice'))).status, 200);
});

test('selected profiles stay off the leaderboard and switching audiences changes access immediately', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store);
  await store.upsertSharing('alice-id', { handle: 'alice', visibility: 'details', leaderboard_opt_in: true });
  await store.saveSnapshot('alice-id', snapshot('details'));
  assert.equal((await app.request('/api/public/users/alice')).status, 200);
  assert.deepEqual((await (await app.request('/api/public/leaderboard')).json()).users.map(user => user.handle), ['alice']);

  const selected = await app.request('/api/me/sharing', sharingPut('alice', {
    audience: 'selected', allowed_emails: ['bob@example.com'], leaderboard_opt_in: true,
  }));
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).leaderboard_opt_in, false);
  assert.equal((await app.request('/api/public/users/alice')).status, 404);
  assert.equal((await app.request('/api/public/users/alice', request('bob'))).status, 200);
  assert.deepEqual((await (await app.request('/api/public/leaderboard')).json()).users, []);

  const publicAgain = await app.request('/api/me/sharing', sharingPut('alice', {
    audience: 'public', leaderboard_opt_in: true,
  }));
  assert.equal(publicAgain.status, 200);
  assert.equal((await app.request('/api/public/users/alice')).status, 200);
  assert.deepEqual((await (await app.request('/api/public/leaderboard')).json()).users.map(user => user.handle), ['alice']);
});

test('selected audience validates recipients and newly added groups before saving', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store, { authGroupsProvider: async token => token === 'alice' ? [group(GROUP_ID, false)] : [] });
  const invalidBodies = [
    { audience: 'selected', visibility: 'details' },
    { audience: 'unknown' },
    { allowed_emails: 'bob@example.com' },
    { allowed_emails: ['not-an-email'] },
    { allowed_emails: [null] },
    { allowed_group_ids: 'bad' },
    { allowed_group_ids: ['not-a-uuid'] },
    { audience: 'selected', visibility: 'details', allowed_group_ids: [OTHER_GROUP_ID] },
  ];
  for (const body of invalidBodies) {
    const response = await app.request('/api/me/sharing', sharingPut('alice', body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const valid = await app.request('/api/me/sharing', sharingPut('alice', {
    audience: 'selected', visibility: 'details',
    allowed_emails: [' Bob@Example.com ', 'bob@example.com'], allowed_group_ids: [GROUP_ID],
  }));
  assert.equal(valid.status, 200);
  const profile = await valid.json();
  assert.deepEqual(profile.allowed_emails, ['bob@example.com']);
  assert.deepEqual(profile.allowed_group_ids, [GROUP_ID]);
  assert.equal(profile.audience, 'selected');

  const afterInvalid = await store.getSharing('alice-id');
  assert.deepEqual(afterInvalid.allowed_group_ids, [GROUP_ID]);
  assert.equal((await app.request('/api/me/sharing', sharingPut('alice', {
    allowed_group_ids: [GROUP_ID, OTHER_GROUP_ID],
  }))).status, 400);
  assert.deepEqual((await store.getSharing('alice-id')).allowed_group_ids, [GROUP_ID]);
});

test('group listing and new group selection fail closed when auth groups are unavailable', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store, { authGroupsProvider: async () => { throw new Error('auth outage details'); } });
  const groups = await app.request('/api/me/sharing/groups', request('alice'));
  assert.equal(groups.status, 503);
  assert.equal(JSON.stringify(await groups.json()).includes('auth outage details'), false);

  const update = await app.request('/api/me/sharing', sharingPut('alice', {
    visibility: 'details', audience: 'selected', allowed_group_ids: [GROUP_ID],
  }));
  assert.equal(update.status, 503);
  assert.equal((await store.getSharing('alice-id')).visibility, 'private');
  assert.deepEqual((await store.getSharing('alice-id')).allowed_group_ids, []);
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

test('public page preferences require booleans and are forced off outside details visibility', async () => {
  const app = appFor(new MemoryProfileStore());
  for (const [key, value] of [['share_sessions', 'yes'], ['share_projects', 1]]) {
    const response = await app.request('/api/me/sharing', request('alice', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }),
    }));
    assert.equal(response.status, 400);
  }

  const privateResponse = await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ share_sessions: true, share_projects: true }),
  }));
  assert.deepEqual(
    (({ share_sessions, share_projects }) => ({ share_sessions, share_projects }))(await privateResponse.json()),
    { share_sessions: false, share_projects: false },
  );

  const detailsResponse = await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility: 'details', share_sessions: true, share_projects: true }),
  }));
  assert.deepEqual(
    (({ share_sessions, share_projects }) => ({ share_sessions, share_projects }))(await detailsResponse.json()),
    { share_sessions: true, share_projects: true },
  );

  const downgraded = await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: 'totals' }),
  }));
  assert.deepEqual(
    (({ share_sessions, share_projects }) => ({ share_sessions, share_projects }))(await downgraded.json()),
    { share_sessions: false, share_projects: false },
  );
});

test('public sessions and projects use independent gates and never leak private analytics fields', async () => {
  const store = new MemoryProfileStore();
  const app = appFor(store);
  const { events: _events, ...baseSession } = sessions[0];
  const sensitiveSnapshot = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    history_included: true,
    device: {
      id: 'device_secret_01',
      name: 'Secret Fleet Server',
      platform: 'private-linux',
      architecture: 'secret-arm64',
    },
    sessions: [
      {
        ...baseSession,
        cwd: '/Users/alice/secret-project',
      },
      {
        ...baseSession,
        time: '11:45',
        cost: 1,
        cwd: 'C:\\fleet\\other-customer\\secret-project',
        file: 'C:\\private\\second-session.jsonl',
        title: 'Second private title',
        sessionId: 'internal-session-two',
        history: [{ role: 'ai', text: 'never publish this response' }],
      },
    ],
  };
  assert.equal((await app.request('/api/me/analytics', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sensitiveSnapshot),
  }))).status, 200);

  const closedSessions = await app.request('/api/public/users/alice/sessions');
  const closedProjects = await app.request('/api/public/users/alice/projects');
  assert.equal(closedSessions.status, 404);
  assert.equal(closedProjects.status, 404);
  assert.deepEqual(await closedSessions.json(), { error: 'Not found' });
  assert.deepEqual(await closedProjects.json(), { error: 'Not found' });

  await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility: 'details', share_sessions: true }),
  }));
  const publicProfile = await (await app.request('/api/public/users/alice')).json();
  assert.equal(publicProfile.share_sessions, true);
  assert.equal(publicProfile.share_projects, false);

  const sessionsResponse = await app.request('/api/public/users/alice/sessions?source=Codex&limit=1&offset=1');
  assert.equal(sessionsResponse.status, 200);
  assert.equal(sessionsResponse.headers.get('Cache-Control'), 'no-store');
  const publicSessions = await sessionsResponse.json();
  assert.equal(publicSessions.total, 2);
  assert.equal(publicSessions.sessions.length, 1);
  assert.deepEqual(Object.keys(publicSessions.sessions[0]).sort(), [
    'cache_read', 'cache_write', 'cost', 'date', 'input_tokens', 'model', 'output_tokens', 'source', 'time',
  ]);
  assert.equal((await app.request('/api/public/users/alice/projects')).status, 404);

  const sessionsJson = JSON.stringify(publicSessions);
  for (const secret of [
    '/Users/alice', 'secret-project', '/secret/session.jsonl', 'Secret product name', 'secret-session-id',
    'secret prompt', 'never publish this response', 'device_secret_01', 'Secret Fleet Server',
    'private-linux', 'secret-arm64', 'history', 'hours', 'sessionId', 'file', 'cwd',
  ]) {
    assert.equal(sessionsJson.includes(secret), false, `sessions leaked ${secret}`);
  }

  await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share_projects: true }),
  }));
  const projectsResponse = await app.request('/api/public/users/alice/projects');
  assert.equal(projectsResponse.status, 200);
  assert.equal(projectsResponse.headers.get('Cache-Control'), 'no-store');
  const projects = await projectsResponse.json();
  assert.equal(projects.length, 1, 'matching basenames must be aggregated without exposing distinct paths');
  assert.equal(projects[0].label, 'secret-project');
  assert.equal(Object.hasOwn(projects[0], 'cwd'), false);
  assert.equal(projects[0].sessions, 2);
  assert.equal(projects[0].cost, 3.5);
  const projectsJson = JSON.stringify(projects);
  for (const secret of [
    '/Users/alice', 'other-customer', '/secret/session.jsonl', 'Secret product name', 'secret-session-id',
    'secret prompt', 'never publish this response', 'device_secret_01', 'Secret Fleet Server',
    'private-linux', 'secret-arm64', 'history', 'hours', 'sessionId', 'file', 'cwd',
  ]) {
    assert.equal(projectsJson.includes(secret), false, `projects leaked ${secret}`);
  }

  await app.request('/api/me/sharing', request('alice', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: 'totals' }),
  }));
  assert.equal((await app.request('/api/public/users/alice/sessions')).status, 404);
  assert.equal((await app.request('/api/public/users/alice/projects')).status, 404);
});

test('public project aggregation safely handles object prototype key labels', async () => {
  const store = new MemoryProfileStore();
  await store.upsertSharing('hostile', {
    handle: 'hostile-user', visibility: 'details', share_sessions: true, share_projects: true,
  });
  await store.saveSnapshot('hostile', snapshot('details'));
  await store.savePrivateAnalytics('hostile', {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    history_included: false,
    sessions: [
      { ...sessions[0], source: 'constructor', model: '__proto__', cwd: '/private/toString' },
      { ...sessions[0], source: 'hasOwnProperty', model: 'valueOf', cwd: '/private/__defineGetter__' },
    ],
  });
  const app = appFor(store);

  const sessionsResponse = await app.request('/api/public/users/hostile-user/sessions');
  assert.equal(sessionsResponse.status, 200);
  const publicSessions = await sessionsResponse.json();
  assert.deepEqual(publicSessions.sessions.map(session => [session.source, session.model]), [
    ['Unknown', 'unknown'], ['Unknown', 'unknown'],
  ]);

  const projectsResponse = await app.request('/api/public/users/hostile-user/projects');
  assert.equal(projectsResponse.status, 200);
  const projects = await projectsResponse.json();
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0], {
    label: '(no project)',
    cost: 5,
    tokens: 700,
    sessions: 2,
    sources: ['Unknown'],
    models: ['unknown'],
    byModel: { unknown: { usd: 5, tokens: 700, sessions: 2 } },
    byHarness: { Unknown: { usd: 5, tokens: 700, sessions: 2 } },
  });
});

test('public projects cap unauthenticated responses at 2000 deterministic aggregates', async () => {
  const store = new MemoryProfileStore();
  await store.upsertSharing('large', {
    handle: 'large-user', visibility: 'details', share_projects: true,
  });
  await store.saveSnapshot('large', snapshot('details'));
  await store.savePrivateAnalytics('large', {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    history_included: false,
    sessions: Array.from({ length: 2_005 }, (_, index) => ({
      ...sessions[0],
      cwd: `/private/project-${String(index).padStart(4, '0')}`,
    })),
  });
  const response = await appFor(store).request('/api/public/users/large-user/projects');
  assert.equal(response.status, 200);
  const projects = await response.json();
  assert.equal(projects.length, 2_000);
  assert.equal(projects[0].label, 'project-0000');
  assert.equal(projects.at(-1).label, 'project-1999');
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
  assert.match(calls[0], /ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS audience/);
  assert.match(calls[0], /ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS allowed_emails/);
  assert.match(calls[0], /ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS allowed_group_ids/);
  assert.match(calls[0], /CREATE UNIQUE INDEX IF NOT EXISTS share_profiles_handle_lower_idx/);
  assert.match(calls[0], /ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS share_sessions/);
  assert.match(calls[0], /ALTER TABLE share_profiles ADD COLUMN IF NOT EXISTS share_projects/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS public_snapshots/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS private_analytics_device_snapshots/);
  assert.match(calls[0], /CREATE TABLE IF NOT EXISTS private_analytics_device_aliases/);
  assert.match(calls[0], /PRIMARY KEY \(subject, device_id\)/);
});

test('Postgres merges an aliased reinstall into one device and keeps old unique sessions', async () => {
  const currentDevice = { id: 'device_current', name: 'Current Mac', platform: 'darwin', architecture: 'arm64' };
  const oldDevice = { id: 'device_old', name: 'Old Mac', platform: 'darwin', architecture: 'arm64' };
  const current = buildPrivateAnalyticsSnapshot(sessions, false, currentDevice);
  current.generated_at = '2026-09-27T10:00:00.000Z';
  const old = buildPrivateAnalyticsSnapshot([
    { ...sessions[0], model: 'unknown', cost: 0 },
    { ...sessions[0], date: '2026-03-16', model: 'gpt-5.6-sol' },
  ], false, oldDevice);
  old.generated_at = '2026-09-18T10:00:00.000Z';
  const rows = [
    { device_id: oldDevice.id, device_name: oldDevice.name, platform: 'darwin', architecture: 'arm64',
      generated_at: old.generated_at, uploaded_at: old.generated_at, snapshot: old, canonical_device_id: currentDevice.id },
    { device_id: currentDevice.id, device_name: currentDevice.name, platform: 'darwin', architecture: 'arm64',
      generated_at: current.generated_at, uploaded_at: current.generated_at, snapshot: current, canonical_device_id: null },
  ];
  const store = new PostgresProfileStore({ query: async () => ({ rows, rowCount: rows.length }) });
  const devices = await store.getPrivateAnalyticsDevices('alice');
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].device, currentDevice);
  assert.deepEqual(devices[0].snapshot.sessions.map(session => [session.date, session.model]), [
    ['2026-07-31', 'gpt-5.6-sol'], ['2026-03-16', 'gpt-5.6-sol'],
  ]);
  assert.equal((await store.getPrivateAnalytics('alice')).sessions.length, 2);
  assert.equal((await store.getPublicAnalytics('alice-one', 'sessions')).sessions.length, 2);

  current.sessions.push({ ...current.sessions[0], date: '2026-09-27' });
  assert.equal((await store.getPrivateAnalytics('alice')).sessions.length, 3, 'new syncs retain old unique history');
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
      rows: [{ handle: 'alice-one', display_name: 'Alice', visibility: 'totals', audience: 'public', snapshot: structuredClone(stored) }],
      rowCount: 1,
    }),
  };
  const store = new PostgresProfileStore(pool);
  const result = await store.getPublicProfile('alice-one');
  assert.equal(result.snapshot.details, undefined);
  assert.ok(stored.details);
});

test('Postgres public analytics gates snapshot reads in each query', async () => {
  const calls = [];
  const store = new PostgresProfileStore({
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return { rows: [], rowCount: 0 };
    },
  });
  assert.equal(await store.getPublicAnalytics('alice-one', 'sessions'), null);
  assert.equal(calls.length, 2);
  for (const { sql, parameters } of calls) {
    assert.match(sql, /JOIN public_snapshots ps USING \(subject\)/);
    assert.match(sql, /p\.visibility = 'details'/);
    assert.match(sql, /p\.share_sessions = true/);
    assert.match(sql, /p\.audience = 'public'/);
    assert.match(sql, /p\.allowed_group_ids && \$4::text\[\]/);
    assert.deepEqual(parameters, ['alice-one', null, null, []]);
  }
  assert.match(calls[0].sql, /JOIN private_analytics_device_snapshots d USING \(subject\)/);
  assert.match(calls[1].sql, /JOIN private_analytics_snapshots a USING \(subject\)/);

  const deviceSnapshot = buildPrivateAnalyticsSnapshot(sessions, false, {
    id: 'device_alpha', name: 'Server Alpha', platform: 'linux', architecture: 'x64',
  });
  const deviceCalls = [];
  const deviceStore = new PostgresProfileStore({
    query: async (sql, parameters) => {
      deviceCalls.push({ sql, parameters });
      return { rows: [{
        device_id: 'device_alpha', device_name: 'Server Alpha', platform: 'linux', architecture: 'x64',
        generated_at: deviceSnapshot.generated_at, uploaded_at: deviceSnapshot.generated_at, snapshot: deviceSnapshot,
      }], rowCount: 1 };
    },
  });
  const aggregate = await deviceStore.getPublicAnalytics('alice-one', 'projects');
  assert.equal(aggregate.sessions.length, 1);
  assert.equal(deviceCalls.length, 1, 'gated device read must not be followed by an ungated analytics fetch');
  assert.match(deviceCalls[0].sql, /p\.visibility = 'details'/);
  assert.match(deviceCalls[0].sql, /p\.share_projects = true/);
  assert.match(deviceCalls[0].sql, /JOIN private_analytics_device_snapshots d USING \(subject\)/);

  calls.length = 0;
  await store.getPublicAnalytics('alice-one', 'projects', {
    subject: 'bob-id', email: ' BOB@Example.com ', group_ids: [GROUP_ID],
  });
  assert.equal(calls.length, 2);
  for (const { sql, parameters } of calls) {
    assert.match(sql, /p\.share_projects = true/);
    assert.match(sql, /p\.subject = \$2/);
    assert.deepEqual(parameters, ['alice-one', 'bob-id', 'bob@example.com', [GROUP_ID]]);
  }
});
