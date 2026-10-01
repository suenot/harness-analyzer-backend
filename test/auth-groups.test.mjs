import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createAuthGroupsProvider } from '../dist/auth-groups.js';

const GROUP_ID = 'bd92d55c-24a5-41bc-9e78-40b9c515462c';

test('auth groups provider sends the bearer token only to the configured groups endpoint', async () => {
  let forwarded = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/groups') {
      assert.equal(request.headers.authorization, 'Bearer secret-token');
      response.writeHead(302, { Location: '/untrusted' }).end();
    } else {
      forwarded += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"groups":[]}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const provider = createAuthGroupsProvider(`http://127.0.0.1:${address.port}/api/v1`);
    await assert.rejects(() => provider('secret-token'));
    assert.equal(forwarded, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('auth groups provider normalizes valid IDs and rejects malformed responses', async () => {
  const fetcher = async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer valid-token');
    assert.equal(init.redirect, 'error');
    return { ok: true, json: async () => ({
      groups: [{ id: GROUP_ID.toUpperCase(), name: 'Friends', member_count: 2, is_owner: false }],
    }) };
  };
  const provider = createAuthGroupsProvider('https://example.test/api/v1/', fetcher);
  assert.deepEqual(await provider('valid-token'), [
    { id: GROUP_ID, name: 'Friends', member_count: 2, is_owner: false },
  ]);
  for (const payload of [
    {}, { groups: {} }, { groups: [{ id: 'bad', name: 'Friends', member_count: 2, is_owner: true }] },
    { groups: [{ id: GROUP_ID, name: 'Friends', member_count: 2 }] },
  ]) {
    const malformed = createAuthGroupsProvider('https://example.test/api/v1', async () => ({
      ok: true, json: async () => payload,
    }));
    await assert.rejects(() => malformed('valid-token'));
  }
});
