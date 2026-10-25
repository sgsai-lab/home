import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { createServer } from '../src/server/server.mjs';
import { resetInMemoryDb, setFirestoreDisabled } from '../src/server/db.mjs';
import { createAppleVerifier, createGoogleVerifier } from '../src/server/identity.mjs';

setFirestoreDisabled(true);

const GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com';
const APPLE_CLIENT_ID = 'com.sgsai.web';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: attackerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function signJwt(payload, { key = privateKey, kid = 'test-kid' } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(payload)}`;
  return `${signed}.${createSign('RSA-SHA256').update(signed).sign(key, 'base64url')}`;
}

function googleClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    sub: 'google-sub-ada',
    email: 'Ada@Example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/ada',
    nonce: 'nonce-1',
    iat: now,
    exp: now + 3600,
    ...overrides
  };
}

function googleVerifier() {
  const client = new OAuth2Client();
  // Offline stand-in for Google's published signing certificates.
  client.getFederatedSignonCertsAsync = async () => ({ certs: { 'test-kid': publicKey.export({ type: 'spki', format: 'pem' }) } });
  return createGoogleVerifier({ clientId: GOOGLE_CLIENT_ID, client });
}

async function start(t, options = {}) {
  resetInMemoryDb();
  const server = createServer({ env: {}, verifyGoogleIdToken: googleVerifier(), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return `http://127.0.0.1:${server.address().port}`;
}

function post(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function refreshCookieOf(response) {
  return (response.headers.get('set-cookie') ?? '').match(/sgsai_refresh=([^;]*)/)?.[1];
}

async function signInWithGoogle(baseUrl, claims = {}) {
  const response = await post(baseUrl, '/api/v1/auth/google', { id_token: signJwt(googleClaims(claims)), nonce: 'nonce-1' });
  assert.equal(response.status, 200);
  return { body: await response.json(), refresh: refreshCookieOf(response), response };
}

function me(baseUrl, accessToken) {
  return fetch(`${baseUrl}/api/v1/users/me`, { headers: { authorization: `Bearer ${accessToken}` } });
}

test('Google sign-in accepts a correctly signed token and reuses the stored user', async (t) => {
  const baseUrl = await start(t);
  const first = await signInWithGoogle(baseUrl);

  assert.equal(first.body.user.email, 'ada@example.com');
  assert.equal(first.body.user.full_name, 'Ada Lovelace');
  assert.equal(first.body.user.email_verified, true);
  assert.equal(first.body.token_type, 'bearer');
  assert.ok(first.body.expires_in > 0);
  const cookie = first.response.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/auth']) assert.match(cookie, new RegExp(attribute));

  const profile = await me(baseUrl, first.body.access_token);
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).id, first.body.user.id);

  const second = await signInWithGoogle(baseUrl);
  assert.equal(second.body.user.id, first.body.user.id);
});

test('Google sign-in rejects forged, mis-addressed, expired, and nonce-mismatched tokens', async (t) => {
  const baseUrl = await start(t);
  const past = Math.floor(Date.now() / 1000) - 7200;
  const unsigned = signJwt(googleClaims()).replace(/\.[^.]+$/, '.forged-signature');
  const cases = {
    unsigned: { id_token: unsigned, nonce: 'nonce-1' },
    'attacker key': { id_token: signJwt(googleClaims(), { key: attackerKey }), nonce: 'nonce-1' },
    'unknown key id': { id_token: signJwt(googleClaims(), { kid: 'other' }), nonce: 'nonce-1' },
    'other audience': { id_token: signJwt(googleClaims({ aud: 'other.apps.googleusercontent.com' })), nonce: 'nonce-1' },
    'other issuer': { id_token: signJwt(googleClaims({ iss: 'https://evil.example' })), nonce: 'nonce-1' },
    expired: { id_token: signJwt(googleClaims({ iat: past, exp: past + 600 })), nonce: 'nonce-1' },
    'nonce mismatch': { id_token: signJwt(googleClaims()), nonce: 'replayed' },
    'not a jwt': { id_token: 'not-a-jwt' }
  };

  for (const [name, body] of Object.entries(cases)) {
    const response = await post(baseUrl, '/api/v1/auth/google', body);
    assert.equal(response.status, 401, name);
    assert.equal((await response.json()).error.code, 'INVALID_CREDENTIAL', name);
    assert.equal(refreshCookieOf(response), undefined, name);
  }
});

test('Google sign-in requires a Google-verified email address', async (t) => {
  const baseUrl = await start(t);
  const response = await post(baseUrl, '/api/v1/auth/google', { id_token: signJwt(googleClaims({ email_verified: false })), nonce: 'nonce-1' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'EMAIL_NOT_VERIFIED');
});

test('without GOOGLE_CLIENT_ID, Google sign-in is unavailable instead of trusting unverified tokens', async (t) => {
  resetInMemoryDb();
  const server = createServer({ env: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const forged = signJwt(googleClaims(), { key: attackerKey });
  const response = await post(baseUrl, '/api/v1/auth/google', { id_token: forged, nonce: 'nonce-1' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PROVIDER_NOT_CONFIGURED');
});

test('the refresh cookie restores the session for "Continue as" and rotates on every use', async (t) => {
  const baseUrl = await start(t);
  const { refresh: original } = await signInWithGoogle(baseUrl);
  assert.ok(original);

  // A new tab has no access token, only the HttpOnly refresh cookie.
  const restored = await post(baseUrl, '/api/v1/auth/token/refresh', undefined, { cookie: `sgsai_refresh=${original}` });
  assert.equal(restored.status, 200);
  const rotated = refreshCookieOf(restored);
  assert.ok(rotated && rotated !== original);
  const { access_token: accessToken } = await restored.json();
  assert.equal((await (await me(baseUrl, accessToken)).json()).full_name, 'Ada Lovelace');

  const reused = await post(baseUrl, '/api/v1/auth/token/refresh', undefined, { cookie: `sgsai_refresh=${original}` });
  assert.equal(reused.status, 401);
  assert.match(reused.headers.get('set-cookie'), /Max-Age=0/);

  const missing = await post(baseUrl, '/api/v1/auth/token/refresh');
  assert.equal(missing.status, 401);

  const next = await post(baseUrl, '/api/v1/auth/token/refresh', undefined, { cookie: `sgsai_refresh=${rotated}` });
  assert.equal(next.status, 200);
});

test('sign-out revokes the access token and the refresh cookie', async (t) => {
  const baseUrl = await start(t);
  const { body, refresh } = await signInWithGoogle(baseUrl);

  const signOut = await post(baseUrl, '/api/v1/auth/logout', undefined, {
    authorization: `Bearer ${body.access_token}`,
    cookie: `sgsai_refresh=${refresh}`
  });
  assert.equal(signOut.status, 200);
  assert.match(signOut.headers.get('set-cookie'), /sgsai_refresh=;.*Max-Age=0/);
  assert.equal((await me(baseUrl, body.access_token)).status, 401);
  assert.equal((await post(baseUrl, '/api/v1/auth/token/refresh', undefined, { cookie: `sgsai_refresh=${refresh}` })).status, 401);
});

test('sign-out everywhere revokes every session of the user', async (t) => {
  const baseUrl = await start(t);
  const laptop = await signInWithGoogle(baseUrl);
  const phone = await signInWithGoogle(baseUrl);

  const response = await post(baseUrl, '/api/v1/auth/logout-all', undefined, { authorization: `Bearer ${laptop.body.access_token}` });
  assert.equal(response.status, 200);
  assert.equal((await me(baseUrl, phone.body.access_token)).status, 401);
  assert.equal((await post(baseUrl, '/api/v1/auth/token/refresh', undefined, { cookie: `sgsai_refresh=${phone.refresh}` })).status, 401);
});

test('Apple sign-in verifies tokens against Apple signing keys', async (t) => {
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  const verifyAppleIdToken = createAppleVerifier({ clientId: APPLE_CLIENT_ID, fetchKeys: async () => [jwk] });
  const baseUrl = await start(t, { verifyAppleIdToken });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://appleid.apple.com', aud: APPLE_CLIENT_ID, sub: 'apple-sub-1', email: 'apple.user@example.com', nonce: 'n', iat: now, exp: now + 600 };

  const response = await post(baseUrl, '/api/v1/auth/apple', { id_token: signJwt(claims), nonce: 'n', full_name: '<b>Apple</b> User' });
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.equal(user.email, 'apple.user@example.com');
  assert.equal(user.full_name, 'Apple User');

  const wrongAudience = await post(baseUrl, '/api/v1/auth/apple', { id_token: signJwt({ ...claims, aud: 'other' }), nonce: 'n' });
  assert.equal(wrongAudience.status, 401);
  const forged = await post(baseUrl, '/api/v1/auth/apple', { id_token: signJwt(claims, { key: attackerKey }), nonce: 'n' });
  assert.equal(forged.status, 401);
});

test('Google account linking requires a verified token not owned by another user', async (t) => {
  const baseUrl = await start(t);
  await signInWithGoogle(baseUrl, { sub: 'google-sub-other', email: 'other@example.com' });
  const { body } = await signInWithGoogle(baseUrl);
  const auth = { authorization: `Bearer ${body.access_token}` };

  const forged = await post(baseUrl, '/api/v1/auth/google/link', { id_token: signJwt(googleClaims({ sub: 'new-sub' }), { key: attackerKey }), nonce: 'nonce-1' }, auth);
  assert.equal(forged.status, 401);

  const taken = await post(baseUrl, '/api/v1/auth/google/link', { id_token: signJwt(googleClaims({ sub: 'google-sub-other' })), nonce: 'nonce-1' }, auth);
  assert.equal(taken.status, 409);

  const linked = await post(baseUrl, '/api/v1/auth/google/link', { id_token: signJwt(googleClaims({ sub: 'google-sub-ada' })), nonce: 'nonce-1' }, auth);
  assert.equal(linked.status, 200);

  const unlinked = await fetch(`${baseUrl}/api/v1/auth/google/link`, { method: 'DELETE', headers: auth });
  assert.equal(unlinked.status, 200);

  const sessions = await fetch(`${baseUrl}/api/v1/auth/sessions`, { headers: auth });
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json()).items.length, 1);
});
