import { createServer as createHttpServer } from 'node:http';
import nodemailer from 'nodemailer';

const BODY_LIMIT = 12 * 1024;
const FIELD_LIMITS = { name: 100, email: 254, company: 120, message: 5000 };
const ANALYTICS_PATHS = new Set(['/', '/vision/', '/products/', '/roadmap/', '/about/', '/contact/', '/privacy/', '/terms/']);

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
  recordPageView = (page) => console.log(JSON.stringify({ event: 'page_view', path: page, timestamp: new Date().toISOString() }))
} = {}) {
  return async (request, response) => {
    if (request.url === '/api/config') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return respond(response, 405, { error: 'Method not allowed.' });
      }
      return respond(response, 200, { googleClientId: env.GOOGLE_CLIENT_ID || null, appleClientId: env.APPLE_CLIENT_ID || null });
    }
    if (request.url === '/api/analytics') {
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
    if (request.url !== '/api/contact') return respond(response, 404, { error: 'Not found.' });
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