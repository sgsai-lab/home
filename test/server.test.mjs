import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createRateLimiter, sanitizeText, validateSubmission } from '../server.mjs';

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

test('config exposes only the public Google client ID', async (t) => {
  const server = createServer({ env: { GOOGLE_CLIENT_ID: 'web-client.apps.googleusercontent.com', SMTP_PASS: 'secret' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/config`;

  const response = await fetch(url);
  const post = await fetch(url, { method: 'POST' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { googleClientId: 'web-client.apps.googleusercontent.com' });
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