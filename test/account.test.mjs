import test from 'node:test';
import assert from 'node:assert/strict';
import { account, call, PASSWORD, start, tokenFrom } from './helpers.mjs';
import { hashPassword, totpCode, verifyPassword } from '../src/server/security.mjs';
import { findUserByEmail, setMemoryFallbackAllowed, setFirestoreInstance, setFirestoreDisabled } from '../src/server/db.mjs';

const signup = (baseUrl, body = {}) => call(baseUrl, '/api/v1/auth/signup', {
  method: 'POST',
  body: { full_name: 'Grace Hopper', email: 'grace@example.com', password: PASSWORD, accept_terms: true, ...body }
});
const login = (baseUrl, email = 'grace@example.com', password = PASSWORD, headers = {}) => call(baseUrl, '/api/v1/auth/login', { method: 'POST', body: { email, password }, headers });

test('email sign-up, verification, sign-in and password reset work end to end', async (t) => {
  const { baseUrl, mail } = await start(t);

  const created = await signup(baseUrl, { full_name: '<b>Grace</b> Hopper' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data, { email: 'grace@example.com', verification_required: true });
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'grace@example.com');

  const unverified = await login(baseUrl);
  assert.equal(unverified.status, 403);
  assert.equal(unverified.data.error.code, 'EMAIL_NOT_VERIFIED');

  assert.equal((await call(baseUrl, '/api/v1/auth/verify-email', { method: 'POST', body: { token: 'bogus' } })).status, 400);
  const verified = await call(baseUrl, '/api/v1/auth/verify-email', { method: 'POST', body: { token: tokenFrom(mail[0], '/verify-email/') } });
  assert.equal(verified.status, 200);
  assert.equal((await call(baseUrl, '/api/v1/auth/verify-email', { method: 'POST', body: { token: tokenFrom(mail[0], '/verify-email/') } })).status, 400, 'verification links are single-use');

  const wrong = await login(baseUrl, 'grace@example.com', 'not the password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, 'INVALID_CREDENTIALS');
  const unknown = await login(baseUrl, 'nobody@example.com');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.data.error.message, wrong.data.error.message, 'unknown and wrong-password answers are identical');

  const signedIn = await login(baseUrl);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.user.full_name, 'Grace Hopper');
  assert.equal(signedIn.data.user.has_password, true);
  assert.match(signedIn.headers.get('set-cookie'), /sgsai_refresh=.+HttpOnly/);
  assert.equal(signedIn.data.refresh_token, undefined, 'web clients never see the refresh token');

  // Forgot password never reveals whether the address exists.
  const forgotUnknown = await call(baseUrl, '/api/v1/auth/password/forgot', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(forgotUnknown.status, 200);
  assert.equal(mail.length, 1);
  assert.equal((await call(baseUrl, '/api/v1/auth/password/forgot', { method: 'POST', body: { email: 'GRACE@example.com' } })).status, 200);
  const resetToken = tokenFrom(mail[1], '/reset-password/');

  const weak = await call(baseUrl, '/api/v1/auth/password/reset', { method: 'POST', body: { token: resetToken, new_password: 'short' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.data.error.details[0].field, 'new_password');
  const reset = await call(baseUrl, '/api/v1/auth/password/reset', { method: 'POST', body: { token: resetToken, new_password: 'a brand new passphrase' } });
  assert.equal(reset.status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: signedIn.data.access_token })).status, 401, 'reset signs out every session');
  assert.equal((await call(baseUrl, '/api/v1/auth/password/reset', { method: 'POST', body: { token: resetToken, new_password: 'another passphrase!' } })).status, 400, 'reset links are single-use');
  assert.equal((await login(baseUrl)).status, 401);
  assert.equal((await login(baseUrl, 'grace@example.com', 'a brand new passphrase')).status, 200);
});

test('signing up with an existing email does not reveal the account', async (t) => {
  const { baseUrl, mail } = await start(t);
  await account(baseUrl, 'grace@example.com');
  const again = await signup(baseUrl);
  assert.equal(again.status, 201);
  assert.deepEqual(again.data, { email: 'grace@example.com', verification_required: true });
  assert.match(mail.at(-1).subject, /already have/);
});

test('sign-up validation reports every invalid field', async (t) => {
  const { baseUrl } = await start(t);
  const response = await signup(baseUrl, { email: 'nope', password: 'short', accept_terms: false, full_name: '' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.data.error.details.map((detail) => detail.field).sort(), ['accept_terms', 'email', 'full_name', 'password']);
});

test('the 11th rapid sign-in attempt from one address is throttled', async (t) => {
  const { baseUrl } = await start(t, { realLimits: true });
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await login(baseUrl, 'x@example.com', 'wrong-password')).status, 401);
  const throttled = await login(baseUrl, 'x@example.com', 'wrong-password');
  assert.equal(throttled.status, 429);
  assert.equal(throttled.data.error.code, 'RATE_LIMITED');
  assert.ok(throttled.headers.get('retry-after'));
});

test('mobile clients get the refresh token in the body and rotate it with JSON', async (t) => {
  const { baseUrl } = await start(t);
  await account(baseUrl, 'grace@example.com');
  const mobile = { 'x-client': 'mobile', 'x-client-platform': 'ios' };
  const signedIn = await login(baseUrl, 'grace@example.com', PASSWORD, mobile);
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.data.refresh_token);
  assert.equal(signedIn.headers.get('set-cookie'), null);

  const refreshed = await call(baseUrl, '/api/v1/auth/token/refresh', { method: 'POST', body: { refresh_token: signedIn.data.refresh_token }, headers: mobile });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.data.refresh_token, signedIn.data.refresh_token);

  const sessions = await call(baseUrl, '/api/v1/auth/sessions', { token: refreshed.data.access_token });
  assert.equal(sessions.data.items.find((session) => session.current).device, 'iOS app');

  const reused = await call(baseUrl, '/api/v1/auth/token/refresh', { method: 'POST', body: { refresh_token: signedIn.data.refresh_token }, headers: mobile });
  assert.equal(reused.status, 401);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: refreshed.data.access_token })).status, 401, 'reuse revokes the family');
});

test('sessions are listed per device and revoking one really signs it out', async (t) => {
  const { baseUrl } = await start(t);
  const laptop = await account(baseUrl, 'grace@example.com');
  const phone = await login(baseUrl, 'grace@example.com', PASSWORD, { 'x-client': 'mobile' });

  const listed = await call(baseUrl, '/api/v1/auth/sessions', { token: laptop.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items.length, 2);
  const other = listed.data.items.find((session) => !session.current);
  assert.equal(other.device, 'Android app');

  assert.equal((await call(baseUrl, `/api/v1/auth/sessions/${other.id}`, { method: 'DELETE', token: laptop.token })).status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: phone.data.access_token })).status, 401);
  assert.equal((await call(baseUrl, '/api/v1/auth/token/refresh', { method: 'POST', body: { refresh_token: phone.data.refresh_token }, headers: { 'x-client': 'mobile' } })).status, 401);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: laptop.token })).status, 200);

  const stranger = await account(baseUrl, 'mallory@example.com');
  const mine = (await call(baseUrl, '/api/v1/auth/sessions', { token: laptop.token })).data.items[0];
  assert.equal((await call(baseUrl, `/api/v1/auth/sessions/${mine.id}`, { method: 'DELETE', token: stranger.token })).status, 404);
});

test('changing the password keeps this session and signs out the others', async (t) => {
  const { baseUrl } = await start(t);
  const first = await account(baseUrl, 'grace@example.com');
  const second = await login(baseUrl);
  const wrong = await call(baseUrl, '/api/v1/auth/password/change', { method: 'POST', token: first.token, body: { current_password: 'nope', new_password: 'next passphrase 1' } });
  assert.equal(wrong.status, 403);
  const changed = await call(baseUrl, '/api/v1/auth/password/change', { method: 'POST', token: first.token, body: { current_password: PASSWORD, new_password: 'next passphrase 1' } });
  assert.equal(changed.status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: first.token })).status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: second.data.access_token })).status, 401);
});

test('TOTP two-factor: setup, sign-in challenge, replay protection, recovery codes and lockout', async (t) => {
  const { baseUrl } = await start(t);
  assert.equal((await call(baseUrl, '/api/v1/auth/mfa')).status, 401, 'MFA status requires sign-in');
  const { token } = await account(baseUrl, 'grace@example.com');

  assert.deepEqual((await call(baseUrl, '/api/v1/auth/mfa', { token })).data, { enabled: false, available: true, recovery_codes_remaining: 0 });
  const setup = await call(baseUrl, '/api/v1/auth/mfa/totp/setup', { method: 'POST', token });
  assert.equal(setup.status, 200);
  assert.match(setup.data.otpauth_uri, /^otpauth:\/\/totp\/.+secret=/);
  const { secret } = setup.data;
  assert.equal((await call(baseUrl, '/api/v1/auth/mfa/totp/confirm', { method: 'POST', token, body: { code: '000000' } })).status, 400);
  const confirmed = await call(baseUrl, '/api/v1/auth/mfa/totp/confirm', { method: 'POST', token, body: { code: totpCode(secret) } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.recovery_codes.length, 10);
  const user = await findUserByEmail('grace@example.com');
  assert.ok(!JSON.stringify(user).includes(secret), 'the TOTP secret is encrypted at rest');

  const challenge = await login(baseUrl);
  assert.equal(challenge.data.mfa_required, true);
  assert.equal(challenge.data.access_token, undefined);
  const replay = await call(baseUrl, '/api/v1/auth/mfa/verify', { method: 'POST', body: { mfa_token: challenge.data.mfa_token, code: totpCode(secret) } });
  assert.equal(replay.status, 401, 'a code already used in this window is rejected');
  const passed = await call(baseUrl, '/api/v1/auth/mfa/verify', { method: 'POST', body: { mfa_token: challenge.data.mfa_token, code: totpCode(secret, Date.now() + 30_000) } });
  assert.equal(passed.status, 200);
  assert.ok(passed.data.access_token);

  const viaRecovery = await login(baseUrl);
  const recovered = await call(baseUrl, '/api/v1/auth/mfa/verify', { method: 'POST', body: { mfa_token: viaRecovery.data.mfa_token, recovery_code: confirmed.data.recovery_codes[0].toUpperCase() } });
  assert.equal(recovered.status, 200);
  assert.equal((await call(baseUrl, '/api/v1/auth/mfa', { token: recovered.data.access_token })).data.recovery_codes_remaining, 9);
  const usedTwice = await login(baseUrl);
  assert.equal((await call(baseUrl, '/api/v1/auth/mfa/verify', { method: 'POST', body: { mfa_token: usedTwice.data.mfa_token, recovery_code: confirmed.data.recovery_codes[0] } })).status, 401);

  // Five consecutive wrong codes (counting the failed recovery attempt above) lock the second factor.
  const locking = await login(baseUrl);
  const codes = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    codes.push((await call(baseUrl, '/api/v1/auth/mfa/verify', { method: 'POST', body: { mfa_token: locking.data.mfa_token, code: '123456' } })).data.error.code);
  }
  assert.deepEqual(codes.slice(0, 4), ['INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE', 'MFA_LOCKED']);
  const afterLock = await login(baseUrl);
  const blocked = await call(baseUrl, '/api/v1/auth/mfa/verify', { method: 'POST', body: { mfa_token: afterLock.data.mfa_token, code: totpCode(secret, Date.now() + 60_000) } });
  assert.equal(blocked.status, 429, 'the correct code is refused while locked');
});

test('disabling MFA and deleting the account require re-authentication', async (t) => {
  const { baseUrl } = await start(t);
  const { token } = await account(baseUrl, 'grace@example.com');
  const { secret } = (await call(baseUrl, '/api/v1/auth/mfa/totp/setup', { method: 'POST', token })).data;
  await call(baseUrl, '/api/v1/auth/mfa/totp/confirm', { method: 'POST', token, body: { code: totpCode(secret) } });

  assert.equal((await call(baseUrl, '/api/v1/auth/mfa/totp', { method: 'DELETE', token, body: {} })).status, 403);
  assert.equal((await call(baseUrl, '/api/v1/auth/mfa/totp', { method: 'DELETE', token, body: { password: 'wrong' } })).status, 403);
  assert.equal((await call(baseUrl, '/api/v1/auth/mfa/totp', { method: 'DELETE', token, body: { password: PASSWORD } })).status, 200);

  assert.equal((await call(baseUrl, '/api/v1/users/me', { method: 'DELETE', token, body: { password: 'wrong' } })).status, 403);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { method: 'DELETE', token, body: { password: PASSWORD } })).status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token })).status, 401);
  assert.equal((await login(baseUrl)).status, 401);
  assert.equal(await findUserByEmail('grace@example.com'), null, 'personal data is removed');
});

test('admins manage users; users cannot; admins cannot demote themselves; disabling signs out', async (t) => {
  const { baseUrl, mail } = await start(t);
  const admin = await account(baseUrl, 'admin@sgs.test', { role: 'admin' });
  const member = await account(baseUrl, 'member@example.com');

  assert.equal((await call(baseUrl, '/api/v1/users', { token: member.token })).status, 403);
  const listed = await call(baseUrl, '/api/v1/users?q=member&page_size=5', { token: admin.token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.items.map((user) => user.email), ['member@example.com']);
  assert.equal(listed.data.page_size, 5);

  const invited = await call(baseUrl, '/api/v1/users', { method: 'POST', token: admin.token, body: { full_name: 'New Person', email: 'new@example.com', role: 'user' } });
  assert.equal(invited.status, 201);
  assert.match(mail.at(-1).text, /\/reset-password\/\?token=/);
  assert.equal((await call(baseUrl, '/api/v1/users', { method: 'POST', token: admin.token, body: { full_name: 'Dup', email: 'new@example.com' } })).status, 409);

  const self = await call(baseUrl, `/api/v1/users/${admin.user.id}`, { method: 'PATCH', token: admin.token, body: { role: 'user' } });
  assert.equal(self.status, 400);
  assert.equal(self.data.error.code, 'SELF_MODIFICATION');

  const disabled = await call(baseUrl, `/api/v1/users/${member.user.id}`, { method: 'PATCH', token: admin.token, body: { status: 'disabled' } });
  assert.equal(disabled.status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: member.token })).status, 401);
  assert.equal((await login(baseUrl, 'member@example.com')).data.error.code, 'ACCOUNT_DISABLED');

  assert.equal((await call(baseUrl, `/api/v1/users/${member.user.id}`, { method: 'DELETE', token: admin.token })).status, 200);
  assert.equal((await call(baseUrl, '/api/v1/users?q=member', { token: admin.token })).data.total, 0);
});

test('ADMIN_EMAILS bootstraps the first administrator on a verified sign-in', async (t) => {
  const { baseUrl } = await start(t, { env: { ADMIN_EMAILS: 'Founder@SGS.test' } });
  const founder = await account(baseUrl, 'founder@sgs.test');
  assert.equal((await call(baseUrl, '/api/v1/users/me', { token: founder.token })).data.role, 'admin');
});

test('Apple on Android: signed state and callback relay into the app', async (t) => {
  const env = { APPLE_STATE_SECRET: 'state-secret', APPLE_ANDROID_PACKAGES: 'com.sgsaitechnology.dev' };
  const { baseUrl } = await start(t, { env });
  assert.equal((await call(baseUrl, '/api/v1/auth/apple/android-state', { method: 'POST', body: { package: 'com.evil' } })).status, 503);
  const { state } = (await call(baseUrl, '/api/v1/auth/apple/android-state', { method: 'POST', body: { package: 'com.sgsaitechnology.dev' } })).data;

  const post = (form) => fetch(`${baseUrl}/api/v1/auth/apple/callback`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form)
  });
  const relayed = await post({ state, id_token: 'header.payload.sig', code: 'abc' });
  assert.equal(relayed.status, 303);
  const location = relayed.headers.get('location');
  assert.match(location, /^intent:\/\/callback\?/);
  assert.match(location, /id_token=header\.payload\.sig/);
  assert.match(location, /#Intent;package=com\.sgsaitechnology\.dev;scheme=signinwithapple;end$/);

  const tampered = await post({ state: `${state.slice(0, -2)}xx`, id_token: 'a.b.c' });
  assert.equal(tampered.status, 400);
  assert.match(await tampered.text(), /expired/);
});

test('v1 errors use the object envelope, unknown routes 404, wrong methods 405 with Allow', async (t) => {
  const { baseUrl } = await start(t);
  const missing = await call(baseUrl, '/api/v1/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'NOT_FOUND');
  assert.ok(missing.data.error.request_id);
  const wrongMethod = await call(baseUrl, '/api/v1/auth/login');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
});

test('readiness reports the backend and Firestore outages surface as 503 when fallback is off', async (t) => {
  const { baseUrl } = await start(t);
  assert.deepEqual((await call(baseUrl, '/api/readyz')).data, { status: 'ok', database: 'memory' });

  const failing = { collection: () => { throw new Error('offline'); } };
  setFirestoreInstance(failing);
  setMemoryFallbackAllowed(false);
  t.after(() => {
    setFirestoreDisabled(true);
    setMemoryFallbackAllowed(true);
  });
  assert.equal((await call(baseUrl, '/api/readyz')).status, 503);
  const unavailable = await login(baseUrl);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.error.code, 'SERVICE_UNAVAILABLE');
});

test('app-link association files are generated from configuration and 404 until configured', async (t) => {
  const { baseUrl } = await start(t, { env: { ANDROID_CERT_SHA256: 'aa:bb', ANDROID_APP_PACKAGES: 'com.sgsaitechnology.app,com.sgsaitechnology.app.dev', APPLE_TEAM_ID: 'ABCDE12345' } });
  const android = await call(baseUrl, '/.well-known/assetlinks.json');
  assert.equal(android.status, 200);
  assert.match(android.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(android.data.map((entry) => entry.target.package_name), ['com.sgsaitechnology.app', 'com.sgsaitechnology.app.dev']);
  assert.deepEqual(android.data[0].target.sha256_cert_fingerprints, ['AA:BB']);
  const ios = await call(baseUrl, '/.well-known/apple-app-site-association');
  assert.deepEqual(ios.data.applinks.details[0], { appIDs: ['ABCDE12345.com.sgsaitechnology.app'], components: [{ '/': '/go/*', comment: 'SGS AI launch links' }] });

  const { baseUrl: unconfigured } = await start(t);
  assert.equal((await call(unconfigured, '/.well-known/assetlinks.json')).status, 404);
  assert.equal((await call(unconfigured, '/.well-known/apple-app-site-association')).status, 404);
});

test('wrong codes during re-authentication count towards the MFA lockout', async (t) => {
  const { baseUrl } = await start(t);
  const { token } = await account(baseUrl, 'grace@example.com');
  const { secret } = (await call(baseUrl, '/api/v1/auth/mfa/totp/setup', { method: 'POST', token })).data;
  await call(baseUrl, '/api/v1/auth/mfa/totp/confirm', { method: 'POST', token, body: { code: totpCode(secret) } });

  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await call(baseUrl, '/api/v1/users/me', { method: 'DELETE', token, body: { code: '000000' } })).data.error.code, 'REAUTH_FAILED');
  }
  const locked = await call(baseUrl, '/api/v1/users/me', { method: 'DELETE', token, body: { code: totpCode(secret, Date.now() + 30_000) } });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error.code, 'MFA_LOCKED');
  assert.ok(await findUserByEmail('grace@example.com'), 'the account was not deleted');
});

test('password hashes with foreign or malformed parameters fail closed instead of erroring', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  const [, , , , salt, key] = stored.split('$');
  assert.equal(await verifyPassword(PASSWORD, `scrypt$1048576$8$1$${salt}$${key}`), false, 'expensive parameters are refused');
  assert.equal(await verifyPassword(PASSWORD, `scrypt$3$8$1$${salt}$${key}`), false, 'invalid parameters are refused');
  assert.equal(await verifyPassword(PASSWORD, 'scrypt$garbage'), false);
});
