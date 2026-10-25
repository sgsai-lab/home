import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import {
  consumeRefreshToken,
  createOrUpdateUserFromProvider,
  deleteRefreshToken,
  deleteSession,
  deleteUserSessions,
  findUserByProvider,
  getSession,
  getUserById,
  saveRefreshToken,
  saveSession,
  updateUser
} from './db.mjs';
import { CredentialError, createAppleVerifier, createGoogleVerifier } from './identity.mjs';

const BODY_LIMIT = 12 * 1024;
const FIELD_LIMITS = { name: 100, email: 254, company: 120, message: 5000 };
const ANALYTICS_PATHS = new Set(['/', '/vision/', '/products/', '/roadmap/', '/about/', '/contact/', '/privacy/', '/terms/']);
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_COOKIE = 'sgsai_refresh';

function readCookie(request, name) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function refreshCookie(value, maxAge) {
  return `${REFRESH_COOKIE}=${value}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function clearRefreshCookie(response) {
  response.setHeader('Set-Cookie', refreshCookie('', 0));
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    avatar_url: user.avatar_url,
    role: user.role,
    email_verified: user.email_verified,
    created_at: user.created_at
  };
}

/** Issues a short-lived bearer token plus a rotating HttpOnly refresh cookie. */
async function issueSession(response, userId) {
  const accessToken = randomBytes(32).toString('base64url');
  const refreshToken = randomBytes(32).toString('base64url');
  await saveSession({ token: accessToken, userId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 });
  await saveRefreshToken({ token: refreshToken, userId, expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000 });
  response.setHeader('Set-Cookie', refreshCookie(refreshToken, REFRESH_TOKEN_TTL_SECONDS));
  return { access_token: accessToken, token_type: 'bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS };
}

function credentialFailure(response, error, provider) {
  if (error instanceof CredentialError && error.code === 'PROVIDER_NOT_CONFIGURED') {
    return respond(response, 503, { error: { code: error.code, message: `${provider} sign-in is not available right now.` } });
  }
  if (!(error instanceof CredentialError)) console.error(`${provider} credential verification error.`);
  return respond(response, 401, { error: { code: 'INVALID_CREDENTIAL', message: `${provider} sign-in could not be verified. Please try again.` } });
}

async function readCredential(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    return null;
  }
  let input;
  try {
    input = await readJson(request);
  } catch (err) {
    respond(response, err.statusCode ?? 400, { error: { code: 'BAD_REQUEST', message: err.message } });
    return null;
  }
  if (typeof input?.id_token !== 'string' || !input.id_token) {
    respond(response, 400, { error: { code: 'BAD_REQUEST', message: 'Missing id_token.' } });
    return null;
  }
  return { idToken: input.id_token, nonce: typeof input.nonce === 'string' ? input.nonce : undefined, input };
}

function getBearerToken(request) {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export function sanitizeText(value, maximumLength) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

export function validateSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid form submission.' };
  const submission = {
    name: sanitizeText(input.name, FIELD_LIMITS.name),
    email: sanitizeText(input.email, FIELD_LIMITS.email),
    company: sanitizeText(input.company, FIELD_LIMITS.company),
    message: sanitizeText(input.message, FIELD_LIMITS.message),
    source: input.source === 'product-updates' ? 'product-updates' : 'contact',
    website: sanitizeText(input.website, 200),
    consent: input.consent === true
  };

  if (!submission.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(submission.email)) {
    return { error: 'Enter a valid email address.' };
  }
  if (submission.source === 'contact' && !submission.name) return { error: 'Enter your name.' };
  if (!submission.message) return { error: 'Enter a message.' };
  if (!submission.consent) return { error: 'Consent is required to send this form.' };
  return { submission };
}

export function createRateLimiter({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const requests = new Map();
  return (key) => {
    const timestamp = now();
    const recent = (requests.get(key) ?? []).filter((time) => timestamp - time < windowMs);
    if (recent.length >= limit) {
      requests.set(key, recent);
      return false;
    }
    recent.push(timestamp);
    requests.set(key, recent);
    if (requests.size > 10000) {
      for (const [address, times] of requests) {
        if (times.every((time) => timestamp - time >= windowMs)) requests.delete(address);
      }
    }
    return true;
  };
}

function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    // Cloud Load Balancing appends the connecting client address to this header.
    return forwarded.split(',').at(-1).trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function respond(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { statusCode: 400 });
  }
}

function smtpIsConfigured(env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.CONTACT_FROM);
}

async function sendNotification(submission, env) {
  if (!smtpIsConfigured(env)) throw new Error('Email delivery is not configured.');
  const port = Number(env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE === 'true' || port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000
  });
  const lines = [
    `Source: ${submission.source}`,
    `Name: ${submission.name || '(not provided)'}`,
    `Email: ${submission.email}`,
    `Company: ${submission.company || '(not provided)'}`,
    '',
    submission.message
  ];
  await transporter.sendMail({
    from: env.CONTACT_FROM,
    to: env.CONTACT_TO || 'hello@sgsaitechnology.com',
    replyTo: submission.email,
    subject: submission.source === 'product-updates' ? 'Website product update request' : 'Website contact enquiry',
    text: lines.join('\n')
  });
}

export function createRequestHandler({
  env = process.env,
  allowRequest = createRateLimiter(),
  sendMail = sendNotification,
  recordPageView = (page) => console.log(JSON.stringify({ event: 'page_view', path: page, timestamp: new Date().toISOString() })),
  verifyGoogleIdToken = createGoogleVerifier({ clientId: env.GOOGLE_CLIENT_ID }),
  verifyAppleIdToken = createAppleVerifier({ clientId: env.APPLE_CLIENT_ID })
} = {}) {
  return async (request, response) => {
    const parsedUrl = new URL(request.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (pathname === '/api/config') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return respond(response, 405, { error: 'Method not allowed.' });
      }
      return respond(response, 200, { googleClientId: env.GOOGLE_CLIENT_ID || null, appleClientId: env.APPLE_CLIENT_ID || null });
    }

    if (pathname === '/api/analytics') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return respond(response, 405, { error: 'Method not allowed.' });
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return respond(response, 415, { error: 'Content-Type must be application/json.' });
      }
      let event;
      try {
        event = await readJson(request);
      } catch (error) {
        return respond(response, error.statusCode ?? 400, { error: error.message });
      }
      if (!event || !ANALYTICS_PATHS.has(event.path)) return respond(response, 400, { error: 'Invalid pageview.' });
      recordPageView(event.path);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }

    if (pathname === '/api/contact') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return respond(response, 405, { error: 'Method not allowed.' });
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return respond(response, 415, { error: 'Content-Type must be application/json.' });
      }
      if (!allowRequest(clientAddress(request))) return respond(response, 429, { error: 'Too many requests. Please try again later.' });

      let input;
      try {
        input = await readJson(request);
      } catch (error) {
        return respond(response, error.statusCode ?? 400, { error: error.message });
      }
      const result = validateSubmission(input);
      if (result.error) return respond(response, 400, { error: result.error });
      if (result.submission.website) return respond(response, 200, { ok: true });

      try {
        await sendMail(result.submission, env);
        return respond(response, 200, { ok: true });
      } catch {
        console.error('Contact notification delivery failed.');
        return respond(response, 503, { error: 'Email delivery is temporarily unavailable.' });
      }
    }

    // Google Identity Services sign-in (button, One Tap, and automatic sign-in all post here)
    if (pathname === '/api/v1/auth/google') {
      const credential = await readCredential(request, response);
      if (!credential) return undefined;
      let payload;
      try {
        payload = await verifyGoogleIdToken(credential.idToken, credential.nonce);
      } catch (error) {
        return credentialFailure(response, error, 'Google');
      }
      if (!payload.email) return credentialFailure(response, new CredentialError('INVALID_CREDENTIAL'), 'Google');
      // Accounts are matched by email, so only Google-verified addresses may sign in.
      if (payload.email_verified !== true && payload.email_verified !== 'true') {
        return respond(response, 403, { error: { code: 'EMAIL_NOT_VERIFIED', message: 'Verify your Google account email address, then try again.' } });
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
      return respond(response, 200, { ...(await issueSession(response, user.id)), user: publicUser(user) });
    }

    // Sign in with Apple
    if (pathname === '/api/v1/auth/apple') {
      const credential = await readCredential(request, response);
      if (!credential) return undefined;
      let payload;
      try {
        payload = await verifyAppleIdToken(credential.idToken, credential.nonce);
      } catch (error) {
        return credentialFailure(response, error, 'Apple');
      }
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
      return respond(response, 200, { ...(await issueSession(response, user.id)), user: publicUser(user) });
    }

    // Current user profile
    if (pathname === '/api/v1/users/me') {
      const token = getBearerToken(request);
      const session = await getSession(token);
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      const user = await getUserById(session.user_id);
      if (!user) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'User not found.' } });
      }

      if (request.method === 'GET') {
        return respond(response, 200, {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          avatar_url: user.avatar_url,
          role: user.role,
          email_verified: user.email_verified,
          created_at: user.created_at
        });
      }

      if (request.method === 'PATCH') {
        let input;
        try {
          input = await readJson(request);
        } catch (err) {
          return respond(response, err.statusCode ?? 400, { error: { code: 'BAD_REQUEST', message: err.message } });
        }
        const updates = {};
        if (input.full_name !== undefined) updates.full_name = sanitizeText(input.full_name, 120);
        if (input.avatar_url !== undefined) updates.avatar_url = sanitizeText(input.avatar_url, 500) || null;
        const updated = await updateUser(user.id, updates);
        return respond(response, 200, {
          id: updated.id,
          email: updated.email,
          full_name: updated.full_name,
          avatar_url: updated.avatar_url,
          role: updated.role,
          email_verified: updated.email_verified,
          created_at: updated.created_at
        });
      }

      response.setHeader('Allow', 'GET, PATCH');
      return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    }

    // Refresh: exchanges the single-use HttpOnly refresh cookie for a new access token and cookie
    if (pathname === '/api/v1/auth/token/refresh') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
      }
      const record = await consumeRefreshToken(readCookie(request, REFRESH_COOKIE));
      const user = record ? await getUserById(record.user_id) : null;
      if (!user) {
        clearRefreshCookie(response);
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Session expired. Sign in again.' } });
      }
      return respond(response, 200, await issueSession(response, user.id));
    }

    // Sign out
    if (pathname === '/api/v1/auth/logout') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
      }
      const token = getBearerToken(request);
      if (token) await deleteSession(token);
      const refreshToken = readCookie(request, REFRESH_COOKIE);
      if (refreshToken) await deleteRefreshToken(refreshToken);
      clearRefreshCookie(response);
      return respond(response, 200, { ok: true });
    }

    // Google account linking
    if (pathname === '/api/v1/auth/google/link') {
      const token = getBearerToken(request);
      const session = await getSession(token);
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      if (request.method === 'POST') {
        const credential = await readCredential(request, response);
        if (!credential) return undefined;
        let payload;
        try {
          payload = await verifyGoogleIdToken(credential.idToken, credential.nonce);
        } catch (error) {
          return credentialFailure(response, error, 'Google');
        }
        const owner = await findUserByProvider('google', String(payload.sub));
        if (owner && owner.id !== session.user_id) {
          return respond(response, 409, { error: { code: 'ALREADY_LINKED', message: 'This Google account is already linked to another user.' } });
        }
        await updateUser(session.user_id, { google_linked: true, google_sub: String(payload.sub) });
        return respond(response, 200, { ok: true });
      }
      if (request.method === 'DELETE') {
        await updateUser(session.user_id, { google_linked: false, google_sub: null });
        return respond(response, 200, { ok: true });
      }
      response.setHeader('Allow', 'POST, DELETE');
      return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    }

    // Sessions management
    if (pathname === '/api/v1/auth/sessions') {
      const token = getBearerToken(request);
      const session = await getSession(token);
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      return respond(response, 200, { items: [{ id: 'current', current: true, created_at: session.created_at, user_agent: request.headers['user-agent'] || 'Current Browser' }] });
    }

    if (pathname.startsWith('/api/v1/auth/sessions/')) {
      const token = getBearerToken(request);
      const session = await getSession(token);
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      return respond(response, 200, { ok: true });
    }

    if (pathname === '/api/v1/auth/logout-all') {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
      }
      const token = getBearerToken(request);
      const session = await getSession(token);
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      await deleteUserSessions(session.user_id);
      clearRefreshCookie(response);
      return respond(response, 200, { ok: true });
    }

    // MFA status
    if (pathname === '/api/v1/auth/mfa') {
      return respond(response, 200, { enabled: false, available: false });
    }

    // Projects list
    if (pathname === '/api/v1/projects') {
      const token = getBearerToken(request);
      const session = await getSession(token);
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      return respond(response, 200, { items: [], total: 0, page: 1, page_size: 10 });
    }

    return respond(response, 404, { error: 'Not found.' });
  };
}

export function createServer(options) {
  return createHttpServer(createRequestHandler(options));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT || 3000);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Contact API listening on 127.0.0.1:${port}`));
}