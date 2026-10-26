import { randomUUID } from 'node:crypto';

export const BODY_LIMIT = 12 * 1024;

/** An error that maps directly onto the `/api/v1` error envelope. */
export class HttpError extends Error {
  constructor(status, code, message, details = [], headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this resource.') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'NOT_FOUND', message);
export const validationError = (details, message = 'Check the highlighted fields.') => new HttpError(400, 'VALIDATION_ERROR', message, details);

export function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(body));
}

export function respondError(response, error, requestId) {
  respond(response, error.status, {
    error: { code: error.code, message: error.message, details: error.details, request_id: requestId }
  }, error.headers);
}

export function redirect(response, location, status = 302) {
  response.writeHead(status, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  response.end();
}

export function html(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(request, limit = BODY_LIMIT) {
  const text = await readBody(request, limit);
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { statusCode: 400 });
  }
}

export async function readForm(request, limit = BODY_LIMIT) {
  return Object.fromEntries(new URLSearchParams(await readBody(request, limit)));
}

/** Reads a JSON object body for /api/v1 routes, mapping parse failures onto HttpError. */
export async function readJsonBody(request, { optional = false } = {}) {
  const length = Number(request.headers['content-length'] ?? 0);
  if (optional && !length && !request.headers['transfer-encoding']) return {};
  let input;
  try {
    input = await readJson(request);
  } catch (error) {
    throw new HttpError(error.statusCode ?? 400, error.statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', error.message);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'BAD_REQUEST', 'Expected a JSON object.');
  return input;
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

export function readCookie(request, name) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export function getBearerToken(request) {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return null;
}

export function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    // Cloud Load Balancing appends the connecting client address to this header.
    return forwarded.split(',').at(-1).trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** web, android or ios; anything else is treated as web. */
export function clientKind(request) {
  const value = String(request.headers['x-client'] ?? '').toLowerCase();
  if (value === 'mobile' || value === 'android' || value === 'ios') {
    const platform = String(request.headers['x-client-platform'] ?? value).toLowerCase();
    return platform === 'ios' ? 'ios' : 'android';
  }
  return 'web';
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

export function newRequestId(request) {
  const incoming = String(request.headers['x-cloud-trace-context'] ?? '').split('/')[0];
  return /^[a-f0-9]{16,32}$/i.test(incoming) ? incoming : randomUUID();
}

/** Structured JSON log line understood by Cloud Logging. Never pass secrets or tokens. */
export function log(severity, message, fields = {}) {
  const line = JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields });
  if (severity === 'ERROR' || severity === 'WARNING') console.error(line);
  else console.log(line);
}

/**
 * Minimal router: patterns like `/api/v1/projects/:id`. Returns the handler and params,
 * or the allowed methods when the path matches but the method does not.
 */
export function createRouter(routes) {
  const compiled = routes.map(([method, pattern, handler]) => {
    const names = [];
    const source = pattern.replace(/:([a-z_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    return { method, regex: new RegExp(`^${source}/?$`), names, handler };
  });
  return (method, pathname) => {
    const allowed = [];
    for (const route of compiled) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) {
        allowed.push(route.method);
        continue;
      }
      let params;
      try {
        params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
      } catch {
        return { error: new HttpError(400, 'BAD_REQUEST', 'Malformed path.') };
      }
      return { handler: route.handler, params };
    }
    return allowed.length ? { allowed: [...new Set(allowed)] } : null;
  };
}
