import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createRateLimiter, sanitizeText, validateSubmission } from '../server.mjs';
import { setFirestoreDisabled } from '../db.mjs';

setFirestoreDisabled(true);

test('sanitizeText removes markup and control characters', () => {
  assert.equal(sanitizeText('  A<em> B</em>\n\u0000 ', 20), 'A B');
});

test('contact submissions require a valid email, name, message, and consent', () => {
  assert.match(validateSubmission({}).error, /email/i);
  assert.match(validateSubmission({ email: 'bad', name: 'A', message: 'Hi', consent: true }).error, /email/i);
  assert.match(validateSubmission({ email: 'a@example.com', name: 'A', message: 'Hi' }).error, /consent/i);
});

test('valid contact submissions are passed to the notification transport after sanitization', async (t) => {
  let received;
  const server = createServer({
    env: {},
    allowRequest: createRateLimiter(),
    sendMail: async (submission) => { received = submission; }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '<b>Sam</b>', email: 'sam@example.com', message: 'Hello', consent: true })
  });

  assert.equal(response.status, 200);
  assert.equal(received.name, 'Sam');
  assert.equal(received.email, 'sam@example.com');
});

test('the 11th rapid request from one address is throttled', async (t) => {
  const server = createServer({
    env: {},
    allowRequest: createRateLimiter({ limit: 10, windowMs: 60_000 }),
    sendMail: async () => {}
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/contact`;
  const request = () => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'A', email: 'a@example.com', message: 'Hello', consent: true })
  });

  const statuses = [];
  for (let index = 0; index < 11; index += 1) statuses.push((await request()).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
});

test('config exposes only the public Google and Apple client IDs', async (t) => {
  const server = createServer({ env: { GOOGLE_CLIENT_ID: 'web-client.apps.googleusercontent.com', APPLE_CLIENT_ID: 'com.sgsai.web', SMTP_PASS: 'secret' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/config`;

  const response = await fetch(url);
  const post = await fetch(url, { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { googleClientId: 'web-client.apps.googleusercontent.com', appleClientId: 'com.sgsai.web' });
  assert.equal(post.status, 405);
});

test('analytics records an approved page path without visitor identifiers', async (t) => {
  const pageViews = [];
  const server = createServer({ recordPageView: (page) => pageViews.push(page) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/analytics`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/vision/' })
  });
  const invalid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/vision/?email=visitor@example.com' })
  });

  assert.equal(response.status, 204);
  assert.equal(invalid.status, 400);
  assert.deepEqual(pageViews, ['/vision/']);
});

function createMockJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.mock-sig`;
}

test('initial Google login stores user in Firebase DB and returns session', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const idToken = createMockJwt({
    sub: 'google-sub-12345',
    email: 'new.google.user@example.com',
    name: 'Google User',
    picture: 'https://example.com/avatar.png',
    email_verified: true
  });

  const loginRes = await fetch(`${baseUrl}/api/v1/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: idToken, nonce: 'test-nonce' })
  });

  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(loginData.access_token);
  assert.equal(loginData.user.email, 'new.google.user@example.com');
  assert.equal(loginData.user.full_name, 'Google User');
  assert.equal(loginData.user.role, 'user');

  // Verify /api/v1/users/me retrieves the stored user
  const meRes = await fetch(`${baseUrl}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${loginData.access_token}` }
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.id, loginData.user.id);
  assert.equal(meData.email, 'new.google.user@example.com');
  assert.equal(meData.full_name, 'Google User');

  // Verify subsequent login returns same user ID
  const loginRes2 = await fetch(`${baseUrl}/api/v1/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: idToken, nonce: 'test-nonce' })
  });
  assert.equal(loginRes2.status, 200);
  const loginData2 = await loginRes2.json();
  assert.equal(loginData2.user.id, loginData.user.id);
});

test('initial Apple login stores user in Firebase DB and returns session', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const idToken = createMockJwt({
    sub: 'apple-sub-67890',
    email: 'apple.user@example.com'
  });

  const loginRes = await fetch(`${baseUrl}/api/v1/auth/apple`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: idToken, nonce: 'test-nonce', full_name: 'Apple User' })
  });

  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(loginData.access_token);
  assert.equal(loginData.user.email, 'apple.user@example.com');
  assert.equal(loginData.user.full_name, 'Apple User');

  // Sign out
  const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${loginData.access_token}` }
  });
  assert.equal(logoutRes.status, 200);

  // Subsequent /users/me fails after logout
  const meRes = await fetch(`${baseUrl}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${loginData.access_token}` }
  });
  assert.equal(meRes.status, 401);
});

test('Google login rejects invalid tokens', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${baseUrl}/api/v1/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id_token: 'not-a-jwt' })
  });
  assert.equal(res.status, 400);
});