import { CredentialError } from '../identity.mjs';
import { escapeHtml, html, HttpError, readCookie, readForm, redirect, sanitizeText, unauthorized } from '../http.mjs';
import {
  consumeOneTimeToken,
  consumeRefreshToken,
  createOrUpdateUserFromProvider,
  createUserSession,
  deleteRefreshToken,
  deleteSession,
  deleteUserSessions,
  findUserByEmail,
  findUserByProvider,
  getSession,
  getUserById,
  getUserSession,
  listUserSessions,
  newUser,
  peekOneTimeToken,
  revokeUserSession,
  saveOneTimeToken,
  saveRefreshToken,
  saveSession,
  saveUser,
  touchUserSession,
  updateDoc,
  updateUser
} from '../db.mjs';
import {
  burnPasswordCheck,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  normalizeRecoveryCode,
  otpauthUri,
  passwordProblems,
  randomToken,
  sha256,
  signState,
  verifyPassword,
  verifyState,
  verifyTotp
} from '../security.mjs';
import { siteOrigin, templates } from '../mail.mjs';
import { Checker, EMAIL_PATTERN } from '../validation.mjs';
import { acceptInviteForUser, findInviteByToken } from './clients.mjs';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_COOKIE = 'sgsai_refresh';
const HOUR = 60 * 60 * 1000;
const VERIFY_TTL = 24 * HOUR;
const RESET_TTL = HOUR;
const MFA_CHALLENGE_TTL = 5 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOCK_MS = 15 * 60 * 1000;
const RECENT_SIGN_IN_MS = 15 * 60 * 1000;

function refreshCookie(value, maxAge) {
  return `${REFRESH_COOKIE}=${value}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function clearRefreshCookie(ctx) {
  ctx.response.setHeader('Set-Cookie', refreshCookie('', 0));
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url ?? null,
    role: user.role,
    status: user.status ?? 'active',
    email_verified: Boolean(user.email_verified),
    has_password: Boolean(user.password_hash),
    mfa_enabled: Boolean(user.mfa?.enabled),
    google_linked: Boolean(user.google_sub),
    apple_linked: Boolean(user.apple_sub),
    default_client_id: user.default_client_id ?? null,
    created_at: user.created_at,
    last_login_at: user.last_login_at ?? null
  };
}

function adminEmails(env) {
  return new Set(String(env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export async function sendMailSafely(ctx, to, message) {
  try {
    await ctx.deps.sendEmail({ to, ...message }, ctx.env);
    return true;
  } catch {
    // Never log the message body: it contains single-use links.
    console.error(JSON.stringify({ severity: 'ERROR', message: 'Transactional email failed', subject: message.subject, request_id: ctx.requestId }));
    return false;
  }
}

/** Creates a session family and returns access + refresh tokens (cookie for web, body for mobile). */
async function issueSession(ctx, user, amr) {
  if (user.email_verified && user.role !== 'admin' && adminEmails(ctx.env).has(user.email)) {
    user = await updateUser(user.id, { role: 'admin' });
  }
  const family = await createUserSession({ userId: user.id, client: ctx.client, userAgent: ctx.userAgent, ip: ctx.ip, amr });
  const tokens = await rotateTokens(ctx, user.id, family.id);
  const updated = await updateUser(user.id, { last_login_at: new Date().toISOString() });
  return { ...tokens, user: publicUser(updated ?? user) };
}

async function rotateTokens(ctx, userId, sessionId) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const now = Date.now();
  await saveSession({ token: accessToken, userId, sessionId, client: ctx.client, expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000 });
  await saveRefreshToken({ token: refreshToken, userId, sessionId, client: ctx.client, expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000 });
  const body = { access_token: accessToken, token_type: 'bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS };
  if (ctx.client === 'web') ctx.response.setHeader('Set-Cookie', refreshCookie(refreshToken, REFRESH_TOKEN_TTL_SECONDS));
  else Object.assign(body, { refresh_token: refreshToken, refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS });
  return body;
}

/** Either completes sign-in or, with MFA enabled, returns a short-lived challenge. */
async function completeSignIn(ctx, user, method) {
  if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact SGS AI Technology for help.');
  if (user.mfa?.enabled) {
    const mfaToken = randomToken();
    await saveOneTimeToken('mfa_challenges', mfaToken, { user_id: user.id, method }, MFA_CHALLENGE_TTL);
    return ctx.send(200, { mfa_required: true, mfa_token: mfaToken, expires_in: MFA_CHALLENGE_TTL / 1000 });
  }
  return ctx.send(200, await issueSession(ctx, user, [method]));
}

async function sendVerification(ctx, user) {
  const token = randomToken();
  await saveOneTimeToken('email_verifications', token, { user_id: user.id, email: user.email }, VERIFY_TTL);
  return sendMailSafely(ctx, user.email, templates.verifyEmail(siteOrigin(ctx.env), token, user.full_name));
}

function mfaKey(ctx) {
  return ctx.env.MFA_ENCRYPTION_KEY || null;
}

/** Verifies a TOTP code or consumes a recovery code. Returns the updated user or null. */
async function checkSecondFactor(ctx, user, { code, recoveryCode }) {
  if (!user.mfa?.enabled) return null;
  if (user.mfa.locked_until && Date.parse(user.mfa.locked_until) > Date.now()) {
    throw new HttpError(429, 'MFA_LOCKED', 'Too many incorrect codes. Try again in 15 minutes.', [], { 'Retry-After': '900' });
  }
  if (code) {
    const secret = decryptSecret(user.mfa.secret_enc, mfaKey(ctx));
    const step = verifyTotp(secret, String(code));
    // Each 30-second code is accepted once.
    if (step < 0 || step <= (user.mfa.last_step ?? -1)) return null;
    return updateUser(user.id, { mfa: { ...user.mfa, last_step: step, failures: 0 } });
  }
  if (recoveryCode) {
    const digest = sha256(`rc:${normalizeRecoveryCode(recoveryCode)}`);
    const { before, after } = await updateDoc('users', user.id, (current) => {
      if (!current?.mfa?.recovery_hashes?.includes(digest)) return undefined;
      return { ...current, mfa: { ...current.mfa, recovery_hashes: current.mfa.recovery_hashes.filter((hash) => hash !== digest), failures: 0 } };
    });
    // Judge by the transaction's own snapshot so a concurrently used code is not accepted twice.
    return before?.mfa?.recovery_hashes?.includes(digest) ? after : null;
  }
  return null;
}

async function recordMfaFailure(user) {
  const failures = (user.mfa.failures ?? 0) + 1;
  const locked = failures >= MFA_MAX_ATTEMPTS;
  await updateUser(user.id, {
    mfa: { ...user.mfa, failures: locked ? 0 : failures, locked_until: locked ? new Date(Date.now() + MFA_LOCK_MS).toISOString() : user.mfa.locked_until ?? null }
  });
  return locked;
}

/** Re-authentication for destructive actions: password, TOTP code, or a sign-in in the last 15 minutes. */
export async function requireReauth(ctx, user, session, input) {
  if (typeof input.password === 'string' && input.password) {
    if (user.password_hash && await verifyPassword(input.password, user.password_hash)) return;
    throw new HttpError(403, 'REAUTH_FAILED', 'That password is not correct.');
  }
  if (typeof input.code === 'string' && input.code) {
    if (user.mfa?.enabled) {
      if (await checkSecondFactor(ctx, user, { code: input.code })) return;
      await recordMfaFailure(user);
    }
    throw new HttpError(403, 'REAUTH_FAILED', 'That code is not correct.');
  }
  if (!user.password_hash && !user.mfa?.enabled && session.session_id) {
    const family = await getUserSession(session.session_id);
    if (family && Date.now() - Date.parse(family.created_at) < RECENT_SIGN_IN_MS) return;
  }
  throw new HttpError(403, 'REAUTH_REQUIRED', 'Confirm with your password or authenticator code. If you sign in only with Google or Apple, sign in again and retry within 15 minutes.');
}

// --- Provider sign-in -------------------------------------------------------------

async function readCredential(ctx) {
  const input = await ctx.body();
  if (typeof input.id_token !== 'string' || !input.id_token) throw new HttpError(400, 'BAD_REQUEST', 'Missing id_token.');
  return { idToken: input.id_token, nonce: typeof input.nonce === 'string' ? input.nonce : undefined, input };
}

function credentialFailure(error, provider) {
  if (error instanceof CredentialError && error.code === 'PROVIDER_NOT_CONFIGURED') {
    return new HttpError(503, error.code, `${provider} sign-in is not available right now.`);
  }
  if (!(error instanceof CredentialError)) console.error(`${provider} credential verification error.`);
  return new HttpError(401, 'INVALID_CREDENTIAL', `${provider} sign-in could not be verified. Please try again.`);
}

async function verifyWith(verifier, provider, credential) {
  try {
    return await verifier(credential.idToken, credential.nonce);
  } catch (error) {
    throw credentialFailure(error, provider);
  }
}

async function googleSignIn(ctx) {
  ctx.limit('auth', ctx.ip);
  const credential = await readCredential(ctx);
  const payload = await verifyWith(ctx.deps.verifyGoogleIdToken, 'Google', credential);
  if (!payload.email) throw credentialFailure(new CredentialError('INVALID_CREDENTIAL'), 'Google');
  // Accounts are matched by email, so only Google-verified addresses may sign in.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your Google account email address, then try again.');
  }
  const email = sanitizeText(payload.email, 254).toLowerCase();
  const user = await createOrUpdateUserFromProvider({
    provider: 'google',
    providerId: String(payload.sub),
    email,
    name: sanitizeText(payload.name || payload.given_name, 120) || email.split('@')[0],
    avatarUrl: typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture.slice(0, 500) : null,
    emailVerified: true
  });
  return completeSignIn(ctx, user, 'google');
}

async function appleSignIn(ctx) {
  ctx.limit('auth', ctx.ip);
  const credential = await readCredential(ctx);
  const payload = await verifyWith(ctx.deps.verifyAppleIdToken, 'Apple', credential);
  // Apple includes the email only on the first authorization; later sign-ins match by subject.
  const email = sanitizeText(payload.email, 254).toLowerCase() || `${payload.sub}@privaterelay.appleid.com`;
  const user = await createOrUpdateUserFromProvider({
    provider: 'apple',
    providerId: String(payload.sub),
    email,
    name: sanitizeText(credential.input.full_name, 120) || email.split('@')[0],
    avatarUrl: null,
    emailVerified: Boolean(payload.email)
  });
  return completeSignIn(ctx, user, 'apple');
}

function appleAndroidPackages(env) {
  return new Set(String(env.APPLE_ANDROID_PACKAGES ?? '').split(',').map((value) => value.trim()).filter(Boolean));
}

/** Issues the signed state an Android app passes to Apple's web flow. */
async function appleAndroidState(ctx) {
  ctx.limit('auth', ctx.ip);
  const input = await ctx.body();
  const secret = ctx.env.APPLE_STATE_SECRET;
  const packageName = sanitizeText(input.package, 120);
  if (!secret || !appleAndroidPackages(ctx.env).has(packageName)) {
    throw new HttpError(503, 'PROVIDER_NOT_CONFIGURED', 'Sign in with Apple is not available for this app.');
  }
  return ctx.send(200, { state: signState({ pkg: packageName, n: randomToken(12) }, secret), expires_in: 600 });
}

function appleCallbackError(ctx, status, message) {
  return html(ctx.response, status, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in with Apple</title><link rel="stylesheet" href="/assets/css/global.css"></head><body><main id="main" class="section-wrap"><h1>Sign in with Apple</h1><p>${escapeHtml(message)}</p><p><a href="/login/">Back to sign in</a></p></main></body></html>`);
}

/** Apple form_post return URL for Android: relays the result into the app via an intent URL. */
async function appleCallback(ctx) {
  ctx.limit('auth', ctx.ip);
  let form;
  try {
    form = await readForm(ctx.request);
  } catch {
    return appleCallbackError(ctx, 400, 'The sign-in response could not be read. Please try again from the app.');
  }
  const state = verifyState(form.state, ctx.env.APPLE_STATE_SECRET);
  if (!state || !appleAndroidPackages(ctx.env).has(state.pkg)) {
    return appleCallbackError(ctx, 400, 'This sign-in link has expired. Please start again from the app.');
  }
  const params = new URLSearchParams();
  for (const key of ['code', 'id_token', 'state', 'user', 'error']) if (typeof form[key] === 'string' && form[key]) params.set(key, form[key]);
  return redirect(ctx.response, `intent://callback?${params}#Intent;package=${state.pkg};scheme=signinwithapple;end`, 303);
}

// --- Email and password -------------------------------------------------------------

async function signup(ctx) {
  ctx.limit('auth', ctx.ip);
  const input = await ctx.body();
  const check = new Checker(input);
  const fullName = check.text('full_name', { required: true, max: 120 });
  const email = check.email('email');
  check.details.push(...passwordProblems(input.password));
  if (input.accept_terms !== true) check.fail('accept_terms', 'Accept the terms to continue.');
  check.done();
  ctx.limit('authEmail', email);

  const invite = typeof input.invite_token === 'string' ? await findInviteByToken(input.invite_token) : null;
  const inviteMatches = invite && invite.email === email;

  const existing = await findUserByEmail(email);
  if (existing) {
    // Same response either way, so sign-up cannot be used to discover registered emails.
    if (!existing.email_verified && existing.password_hash) await sendVerification(ctx, existing);
    else await sendMailSafely(ctx, email, {
      subject: 'You already have an SGS AI Technology account',
      text: `Someone tried to create an account with this address. You already have one.\n\nSign in: ${siteOrigin(ctx.env)}/login/\nForgot your password? ${siteOrigin(ctx.env)}/forgot-password/\n\nIf this wasn't you, you can ignore this email.`
    });
    return ctx.send(201, { email, verification_required: true });
  }

  const user = { ...newUser({ email, name: fullName, provider: 'password', emailVerified: Boolean(inviteMatches) }), password_hash: await hashPassword(input.password), terms_accepted_at: new Date().toISOString() };
  await saveUser(user);
  if (inviteMatches) {
    // The invitation link was delivered to this address, which proves ownership.
    await acceptInviteForUser(invite, user);
    return ctx.send(201, { email, verification_required: false });
  }
  await sendVerification(ctx, user);
  return ctx.send(201, { email, verification_required: true });
}

async function login(ctx) {
  ctx.limit('auth', ctx.ip);
  const input = await ctx.body();
  const email = sanitizeText(input.email, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email) || typeof input.password !== 'string' || !input.password) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Enter your email address and password.');
  }
  ctx.limit('authEmail', email);
  const user = await findUserByEmail(email);
  if (!user?.password_hash) {
    await burnPasswordCheck(input.password);
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'That email and password combination is not correct.');
  }
  if (!await verifyPassword(input.password, user.password_hash)) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'That email and password combination is not correct.');
  }
  if (!user.email_verified) {
    throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address first. We can send you a new link.');
  }
  return completeSignIn(ctx, user, 'pwd');
}

async function verifyEmail(ctx) {
  ctx.limit('auth', ctx.ip);
  const { token } = await ctx.body();
  const record = await consumeOneTimeToken('email_verifications', token);
  const user = record ? await getUserById(record.user_id) : null;
  if (!user || user.email !== record.email) throw new HttpError(400, 'INVALID_TOKEN', 'This verification link is invalid or has expired. Request a new one below.');
  await updateUser(user.id, { email_verified: true });
  return ctx.send(200, { ok: true, email: user.email });
}

async function resendVerification(ctx) {
  ctx.limit('auth', ctx.ip);
  const input = await ctx.body();
  const email = sanitizeText(input.email, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a valid email address.');
  ctx.limit('authEmail', email);
  const user = await findUserByEmail(email);
  if (user && !user.email_verified && user.status === 'active') await sendVerification(ctx, user);
  return ctx.send(200, { ok: true });
}

async function forgotPassword(ctx) {
  ctx.limit('auth', ctx.ip);
  const input = await ctx.body();
  const email = sanitizeText(input.email, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'VALIDATION_ERROR', 'Enter a valid email address.');
  ctx.limit('authEmail', email);
  const user = await findUserByEmail(email);
  if (user && user.status === 'active') {
    const token = randomToken();
    await saveOneTimeToken('password_resets', token, { user_id: user.id }, RESET_TTL);
    await sendMailSafely(ctx, user.email, templates.resetPassword(siteOrigin(ctx.env), token, user.full_name));
  }
  return ctx.send(200, { ok: true });
}

async function resetPassword(ctx) {
  ctx.limit('auth', ctx.ip);
  const input = await ctx.body();
  const problems = passwordProblems(input.new_password, 'new_password');
  if (problems.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a stronger password.', problems);
  const pending = await peekOneTimeToken('password_resets', input.token);
  const user = pending ? await getUserById(pending.user_id) : null;
  if (!user || user.status !== 'active') throw new HttpError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired. Request a new one.');
  if (user.mfa?.enabled) {
    if (!input.mfa_code && !input.recovery_code) throw new HttpError(400, 'MFA_REQUIRED', 'Enter a code from your authenticator app or a recovery code.');
    ctx.limit('mfa', user.id);
    if (!await checkSecondFactor(ctx, user, { code: input.mfa_code, recoveryCode: input.recovery_code })) {
      await recordMfaFailure(user);
      throw new HttpError(400, 'INVALID_CODE', 'That code is not correct.');
    }
  }
  if (!await consumeOneTimeToken('password_resets', input.token)) throw new HttpError(400, 'INVALID_TOKEN', 'This reset link has already been used.');
  // Reset links are delivered by email, so completing one also proves the address.
  await updateUser(user.id, { password_hash: await hashPassword(input.new_password), email_verified: true });
  await deleteUserSessions(user.id);
  return ctx.send(200, { ok: true });
}

async function changePassword(ctx) {
  const { session, user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const input = await ctx.body();
  if (!user.password_hash) throw new HttpError(409, 'PASSWORD_NOT_SET', 'You sign in with Google or Apple. Set a password instead.');
  if (!await verifyPassword(String(input.current_password ?? ''), user.password_hash)) {
    throw new HttpError(403, 'REAUTH_FAILED', 'Your current password is not correct.', [{ field: 'current_password', message: 'Not correct.' }]);
  }
  const problems = passwordProblems(input.new_password, 'new_password');
  if (problems.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a stronger password.', problems);
  await updateUser(user.id, { password_hash: await hashPassword(input.new_password) });
  await deleteUserSessions(user.id, { except: session.session_id });
  await ctx.audit('user.password_changed', { type: 'user', id: user.id }, { actorId: user.id });
  return ctx.send(200, { ok: true });
}

async function setPassword(ctx) {
  const { session, user } = await ctx.auth();
  ctx.limit('mutations', user.id);
  const input = await ctx.body();
  if (user.password_hash) throw new HttpError(409, 'PASSWORD_ALREADY_SET', 'You already have a password. Use change password.');
  const problems = passwordProblems(input.new_password, 'new_password');
  if (problems.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a stronger password.', problems);
  await updateUser(user.id, { password_hash: await hashPassword(input.new_password) });
  await deleteUserSessions(user.id, { except: session.session_id });
  return ctx.send(200, { ok: true });
}

// --- Tokens and sessions -------------------------------------------------------------

async function refresh(ctx) {
  let token = readCookie(ctx.request, REFRESH_COOKIE);
  if (ctx.client !== 'web') token = (await ctx.body({ optional: true })).refresh_token ?? null;
  const record = await consumeRefreshToken(token);
  const user = record && !record.reused ? await getUserById(record.user_id) : null;
  if (!user || user.status !== 'active') {
    if (ctx.client === 'web') clearRefreshCookie(ctx);
    if (record?.reused) console.error(JSON.stringify({ severity: 'WARNING', message: 'Refresh token reuse detected; session revoked', request_id: ctx.requestId }));
    throw unauthorized('Session expired. Sign in again.');
  }
  if (record.session_id) {
    if (!await getUserSession(record.session_id)) throw unauthorized('Session expired. Sign in again.');
    await touchUserSession(record.session_id);
  }
  return ctx.send(200, await rotateTokens(ctx, user.id, record.session_id));
}

async function logout(ctx) {
  const header = ctx.request.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const session = token ? await getSession(token) : null;
  if (session?.session_id) await revokeUserSession(session.session_id);
  else if (token) await deleteSession(token);
  const input = ctx.client === 'web' ? {} : await ctx.body({ optional: true });
  const refreshToken = ctx.client === 'web' ? readCookie(ctx.request, REFRESH_COOKIE) : input.refresh_token;
  if (refreshToken) await deleteRefreshToken(refreshToken);
  if (ctx.client === 'web') clearRefreshCookie(ctx);
  return ctx.send(200, { ok: true });
}

async function logoutAll(ctx) {
  const { user } = await ctx.auth();
  await deleteUserSessions(user.id);
  if (ctx.client === 'web') clearRefreshCookie(ctx);
  return ctx.send(200, { ok: true });
}

const DEVICE = { web: 'Browser', android: 'Android app', ios: 'iOS app' };

async function listSessions(ctx) {
  const { session, user } = await ctx.auth();
  const families = await listUserSessions(user.id);
  const items = families
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
    .map((family) => ({
      id: family.id,
      current: family.id === session.session_id,
      client: family.client,
      device: DEVICE[family.client] ?? 'Browser',
      user_agent: family.user_agent,
      started_at: family.created_at,
      last_used_at: family.last_seen_at
    }));
  return ctx.send(200, { items });
}

async function revokeSession(ctx) {
  const { user } = await ctx.auth();
  const family = await getUserSession(ctx.params.id);
  if (!family || family.user_id !== user.id) throw new HttpError(404, 'NOT_FOUND', 'Session not found.');
  await revokeUserSession(family.id);
  return ctx.send(200, { ok: true });
}

// --- Google account linking ------------------------------------------------------------

async function linkGoogle(ctx) {
  const { user } = await ctx.auth();
  const credential = await readCredential(ctx);
  const payload = await verifyWith(ctx.deps.verifyGoogleIdToken, 'Google', credential);
  const owner = await findUserByProvider('google', String(payload.sub));
  if (owner && owner.id !== user.id) throw new HttpError(409, 'ALREADY_LINKED', 'This Google account is already linked to another user.');
  await updateUser(user.id, { google_linked: true, google_sub: String(payload.sub) });
  return ctx.send(200, { ok: true });
}

async function unlinkGoogle(ctx) {
  const { user } = await ctx.auth();
  if (!user.password_hash && !user.apple_sub) throw new HttpError(409, 'LAST_SIGN_IN_METHOD', 'Set a password before unlinking Google, or you will not be able to sign in.');
  await updateUser(user.id, { google_linked: false, google_sub: null, ...(user.provider === 'google' ? { provider_id: null } : {}) });
  return ctx.send(200, { ok: true });
}

// --- Two-factor authentication -----------------------------------------------------------

async function mfaStatus(ctx) {
  const { user } = await ctx.auth();
  return ctx.send(200, {
    enabled: Boolean(user.mfa?.enabled),
    available: Boolean(mfaKey(ctx)),
    recovery_codes_remaining: user.mfa?.enabled ? user.mfa.recovery_hashes?.length ?? 0 : 0
  });
}

async function mfaSetup(ctx) {
  const { user } = await ctx.auth();
  if (!mfaKey(ctx)) throw new HttpError(503, 'MFA_UNAVAILABLE', 'Two-factor authentication is not available on this server.');
  if (user.mfa?.enabled) throw new HttpError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
  const secret = generateTotpSecret();
  await updateUser(user.id, { mfa_pending: { secret_enc: encryptSecret(secret, mfaKey(ctx)), created_at: new Date().toISOString() } });
  return ctx.send(200, { secret, otpauth_uri: otpauthUri(secret, user.email) });
}

async function storeRecoveryCodes(user, mfa) {
  const codes = generateRecoveryCodes();
  await updateUser(user.id, { mfa: { ...mfa, recovery_hashes: codes.map((code) => sha256(`rc:${normalizeRecoveryCode(code)}`)) }, mfa_pending: null });
  return codes;
}

async function mfaConfirm(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mfa', user.id);
  const { code } = await ctx.body();
  if (!user.mfa_pending?.secret_enc) throw new HttpError(409, 'MFA_SETUP_REQUIRED', 'Start the setup again.');
  const secret = decryptSecret(user.mfa_pending.secret_enc, mfaKey(ctx));
  const step = verifyTotp(secret, String(code ?? ''));
  if (step < 0) throw new HttpError(400, 'INVALID_CODE', 'That code is not correct. Check the time on your device and try again.');
  const codes = await storeRecoveryCodes(user, { enabled: true, secret_enc: user.mfa_pending.secret_enc, last_step: step, failures: 0, enabled_at: new Date().toISOString() });
  await ctx.audit('user.mfa_enabled', { type: 'user', id: user.id }, { actorId: user.id });
  return ctx.send(200, { recovery_codes: codes });
}

async function mfaRegenerate(ctx) {
  const { user } = await ctx.auth();
  ctx.limit('mfa', user.id);
  const { code } = await ctx.body();
  const verified = await checkSecondFactor(ctx, user, { code: String(code ?? '') });
  if (!verified) {
    if (user.mfa?.enabled) await recordMfaFailure(user);
    throw new HttpError(400, 'INVALID_CODE', 'That code is not correct.');
  }
  return ctx.send(200, { recovery_codes: await storeRecoveryCodes(verified, verified.mfa) });
}

async function mfaDisable(ctx) {
  const { session, user } = await ctx.auth();
  ctx.limit('mfa', user.id);
  if (!user.mfa?.enabled) throw new HttpError(409, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled.');
  await requireReauth(ctx, user, session, await ctx.body());
  await updateUser(user.id, { mfa: null, mfa_pending: null });
  await deleteUserSessions(user.id, { except: session.session_id });
  await ctx.audit('user.mfa_disabled', { type: 'user', id: user.id }, { actorId: user.id });
  return ctx.send(200, { ok: true });
}

async function mfaVerify(ctx) {
  ctx.limit('mfa', ctx.ip);
  const input = await ctx.body();
  const challenge = await peekOneTimeToken('mfa_challenges', input.mfa_token);
  const user = challenge ? await getUserById(challenge.user_id) : null;
  if (!user?.mfa?.enabled) throw new HttpError(401, 'MFA_EXPIRED', 'Your sign-in expired. Start again.');
  const verified = await checkSecondFactor(ctx, user, { code: input.code, recoveryCode: input.recovery_code });
  if (!verified) {
    const locked = await recordMfaFailure(user);
    if (locked) await consumeOneTimeToken('mfa_challenges', input.mfa_token);
    throw new HttpError(locked ? 429 : 401, locked ? 'MFA_LOCKED' : 'INVALID_CODE', locked ? 'Too many incorrect codes. Try again in 15 minutes.' : 'That code is not correct.');
  }
  if (!await consumeOneTimeToken('mfa_challenges', input.mfa_token)) throw new HttpError(401, 'MFA_EXPIRED', 'Your sign-in expired. Start again.');
  return ctx.send(200, await issueSession(ctx, verified, [challenge.method, 'mfa']));
}

export const authRoutes = [
  ['POST', '/api/v1/auth/signup', signup],
  ['POST', '/api/v1/auth/login', login],
  ['POST', '/api/v1/auth/verify-email', verifyEmail],
  ['POST', '/api/v1/auth/verify-email/resend', resendVerification],
  ['POST', '/api/v1/auth/password/forgot', forgotPassword],
  ['POST', '/api/v1/auth/password/reset', resetPassword],
  ['POST', '/api/v1/auth/password/change', changePassword],
  ['POST', '/api/v1/auth/password/set', setPassword],
  ['POST', '/api/v1/auth/google', googleSignIn],
  ['POST', '/api/v1/auth/apple', appleSignIn],
  ['POST', '/api/v1/auth/apple/android-state', appleAndroidState],
  ['POST', '/api/v1/auth/apple/callback', appleCallback],
  ['POST', '/api/v1/auth/token/refresh', refresh],
  ['POST', '/api/v1/auth/logout', logout],
  ['POST', '/api/v1/auth/logout-all', logoutAll],
  ['POST', '/api/v1/auth/google/link', linkGoogle],
  ['DELETE', '/api/v1/auth/google/link', unlinkGoogle],
  ['GET', '/api/v1/auth/sessions', listSessions],
  ['DELETE', '/api/v1/auth/sessions/:id', revokeSession],
  ['GET', '/api/v1/auth/mfa', mfaStatus],
  ['POST', '/api/v1/auth/mfa/totp/setup', mfaSetup],
  ['POST', '/api/v1/auth/mfa/totp/confirm', mfaConfirm],
  ['DELETE', '/api/v1/auth/mfa/totp', mfaDisable],
  ['POST', '/api/v1/auth/mfa/verify', mfaVerify],
  ['POST', '/api/v1/auth/mfa/recovery-codes', mfaRegenerate]
];
