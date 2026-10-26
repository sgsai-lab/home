import { createServer as createHttpServer } from 'node:http';
import {
  createRateLimiter,
  createRouter,
  clientAddress,
  clientKind,
  getBearerToken,
  HttpError,
  log,
  newRequestId,
  readJson,
  readJsonBody,
  respond,
  respondError,
  sanitizeText,
  unauthorized
} from './http.mjs';
import { checkDatabase, DatabaseUnavailableError, getSession, getUserById } from './db.mjs';
import { createAppleVerifier, createGoogleVerifier } from './identity.mjs';
import { sendNotification, sendTransactionalEmail } from './mail.mjs';
import { createGcsStorage } from './storage.mjs';
import { writeAudit } from './audit.mjs';
import { authRoutes } from './routes/auth.mjs';
import { userRoutes } from './routes/users.mjs';
import { clientRoutes } from './routes/clients.mjs';
import { projectRoutes } from './routes/projects.mjs';
import { productRoutes, goRoutes } from './routes/products.mjs';
import { assetRoutes } from './routes/assets.mjs';
import { auditRoutes } from './routes/audit.mjs';

export { createRateLimiter, sanitizeText };

const FIELD_LIMITS = { name: 100, email: 254, company: 120, message: 5000 };
// Must stay in sync with analyticsPaths in public/assets/js/script.js (test/build.test.mjs enforces it).
export const ANALYTICS_PATHS = new Set(['/', '/vision/', '/services/', '/products/', '/roadmap/', '/about/', '/contact/', '/privacy/', '/terms/']);

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

/** Comma-separated audiences plus the single legacy variable. */
export function audiences(...values) {
  return [...new Set(values.flatMap((value) => String(value ?? '').split(',')).map((value) => value.trim()).filter(Boolean))];
}

function listOf(value, fallback = '') {
  return String(value || fallback).split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Android App Links / iOS Universal Links for /go/* (ADR-002 §7). Generated from configuration
 * so signing fingerprints and the Apple team id are never hard-coded; 404 until configured.
 */
export function appLinks(env, pathname) {
  if (pathname.endsWith('assetlinks.json')) {
    const fingerprints = listOf(env.ANDROID_CERT_SHA256).map((value) => value.toUpperCase());
    if (!fingerprints.length) return null;
    return listOf(env.ANDROID_APP_PACKAGES, 'com.sgsaitechnology.app').map((packageName) => ({
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: fingerprints }
    }));
  }
  const teamId = String(env.APPLE_TEAM_ID ?? '').trim();
  if (!/^[A-Z0-9]{10}$/.test(teamId)) return null;
  const appIDs = listOf(env.IOS_BUNDLE_IDS, 'com.sgsaitechnology.app').map((bundle) => `${teamId}.${bundle}`);
  return { applinks: { details: [{ appIDs, components: [{ '/': '/go/*', comment: 'SGS AI launch links' }] }] } };
}

function createLimiters(overrides = {}) {
  const minute = 60 * 1000;
  return {
    auth: createRateLimiter({ limit: 10, windowMs: 15 * minute }),
    authEmail: createRateLimiter({ limit: 10, windowMs: 15 * minute }),
    mfa: createRateLimiter({ limit: 10, windowMs: 15 * minute }),
    mutations: createRateLimiter({ limit: 60, windowMs: 10 * minute }),
    invites: createRateLimiter({ limit: 10, windowMs: 60 * minute }),
    uploads: createRateLimiter({ limit: 20, windowMs: 60 * minute }),
    launch: createRateLimiter({ limit: 120, windowMs: minute }),
    ...overrides
  };
}

const router = createRouter([...authRoutes, ...userRoutes, ...clientRoutes, ...projectRoutes, ...productRoutes, ...assetRoutes, ...auditRoutes, ...goRoutes]);

function createContext({ request, response, url, params, deps, requestId }) {
  let authenticated;
  const ip = clientAddress(request);
  const ctx = {
    request,
    response,
    params,
    deps,
    env: deps.env,
    requestId,
    ip,
    url,
    query: url.searchParams,
    client: clientKind(request),
    userAgent: String(request.headers['user-agent'] ?? ''),
    body: (options) => readJsonBody(request, options),
    send: (status, body, headers) => respond(response, status, body, { 'X-Request-Id': requestId, ...headers }),
    /** Resolves { session, user } or throws 401. Disabled and deleted accounts are rejected. */
    auth() {
      authenticated ??= (async () => {
        const session = await getSession(getBearerToken(request));
        if (!session) throw unauthorized();
        const user = await getUserById(session.user_id);
        if (!user || user.status !== 'active') throw unauthorized(user ? 'This account is not active.' : 'User not found.');
        return { session, user };
      })();
      return authenticated;
    },
    async optionalAuth() {
      if (!getBearerToken(request)) return null;
      try {
        return await ctx.auth();
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) return null;
        throw error;
      }
    },
    async admin() {
      const result = await ctx.auth();
      if (result.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Administrator access is required.');
      return result;
    },
    limit(name, key) {
      if (!deps.limiters[name](`${name}:${key}`)) {
        throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.', [], { 'Retry-After': '60' });
      }
    },
    audit(action, target, { clientId = null, diff = null, actorId } = {}) {
      return writeAudit({ actorId, action, target, clientId, ip, userAgent: ctx.userAgent, requestId, diff });
    }
  };
  return ctx;
}

export function createRequestHandler({
  env = process.env,
  allowRequest = createRateLimiter(),
  sendMail = sendNotification,
  sendEmail = sendTransactionalEmail,
  recordPageView = (page) => console.log(JSON.stringify({ event: 'page_view', path: page, timestamp: new Date().toISOString() })),
  verifyGoogleIdToken = createGoogleVerifier({ clientId: audiences(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_IDS) }),
  verifyAppleIdToken = createAppleVerifier({ clientId: audiences(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_IDS) }),
  storage = createGcsStorage(env),
  limiters
} = {}) {
  const deps = { env, sendEmail, verifyGoogleIdToken, verifyAppleIdToken, storage, limiters: createLimiters(limiters) };

  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    const requestId = newRequestId(request);

    if (pathname === '/api/config') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return respond(response, 405, { error: 'Method not allowed.' });
      }
      return respond(response, 200, { googleClientId: env.GOOGLE_CLIENT_ID || null, appleClientId: env.APPLE_CLIENT_ID || null });
    }

    if (pathname === '/.well-known/assetlinks.json' || pathname === '/.well-known/apple-app-site-association') {
      const body = appLinks(env, pathname);
      if (!body) return respond(response, 404, { error: 'Not found.' });
      return respond(response, 200, body, { 'Cache-Control': 'public, max-age=3600' });
    }

    if (pathname === '/api/readyz') {
      try {
        return respond(response, 200, { status: 'ok', database: await checkDatabase() });
      } catch {
        return respond(response, 503, { status: 'unavailable', database: 'firestore' });
      }
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

    const isApi = pathname.startsWith('/api/v1/');
    if (!isApi && !pathname.startsWith('/go/')) return respond(response, 404, { error: 'Not found.' });

    const started = Date.now();
    let status = 500;
    try {
      const match = router(request.method, pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      if (match.error) throw match.error;
      if (match.allowed) {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', [], { Allow: match.allowed.join(', ') });
      }
      const ctx = createContext({ request, response, url, params: match.params, deps, requestId });
      await match.handler(ctx);
      status = response.statusCode;
    } catch (error) {
      if (response.headersSent) {
        log('ERROR', 'Handler failed after responding', { request_id: requestId, path: pathname, error: error.message });
        return undefined;
      }
      let failure = error;
      if (error instanceof DatabaseUnavailableError) {
        failure = new HttpError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Please try again shortly.', [], { 'Retry-After': '30' });
      } else if (!(error instanceof HttpError)) {
        log('ERROR', 'Unhandled API error', { request_id: requestId, path: pathname, method: request.method, error: error.message, stack: error.stack });
        failure = new HttpError(500, 'INTERNAL', 'Something went wrong. Please try again.');
      }
      status = failure.status;
      respondError(response, failure, requestId);
    } finally {
      if (status >= 500) log('WARNING', 'API request failed', { request_id: requestId, method: request.method, path: pathname, status, ms: Date.now() - started });
    }
    return undefined;
  };
}

export function createServer(options) {
  return createHttpServer(createRequestHandler(options));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT || 3000);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => log('INFO', `API listening on 127.0.0.1:${port}`));
}
