// Template for API tests. Copy into test/<feature>.test.mjs and adapt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/server.mjs';
import { resetInMemoryDb, setFirestoreDisabled } from '../src/server/db.mjs';

setFirestoreDisabled(true);

function createMockJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.mock-sig`;
}

async function startServer(t, options = {}) {
  resetInMemoryDb();
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return `http://127.0.0.1:${server.address().port}`;
}

async function signIn(baseUrl, email = 'user@example.com') {
  const idToken = createMockJwt({ sub: `google-${email}`, email, name: 'Test User', email_verified: true });
  const response = await fetch(`${baseUrl}/api/v1/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: idToken, nonce: 'test-nonce' })
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

test('widgets require sign-in', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/api/v1/widgets`);
  assert.equal(response.status, 401);
});

test('a signed-in user can create and list widgets', async (t) => {
  const baseUrl = await startServer(t);
  const token = await signIn(baseUrl);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const created = await fetch(`${baseUrl}/api/v1/widgets`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '<b>First</b>' })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).name, 'First');

  const list = await fetch(`${baseUrl}/api/v1/widgets`, { headers });
  assert.equal((await list.json()).total, 1);
});
