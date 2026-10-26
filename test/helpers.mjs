import assert from 'node:assert/strict';
import { createServer } from '../src/server/server.mjs';
import { newUser, resetInMemoryDb, saveUser, setFirestoreDisabled, setMemoryFallbackAllowed } from '../src/server/db.mjs';
import { hashPassword } from '../src/server/security.mjs';

setFirestoreDisabled(true);
setMemoryFallbackAllowed(true);

export const PASSWORD = 'correct horse battery';
export const MFA_KEY = Buffer.alloc(32, 7).toString('base64');

/** In-memory GCS stand-in recording what the API asked for. */
export function fakeStorage({ mediaBucket = 'media-test', publicBucket = 'public-test' } = {}) {
  const objects = new Map();
  const published = new Map();
  return {
    configured: true,
    mediaBucket,
    publicBucket,
    objects,
    published,
    async signedUploadUrl({ object, contentType, size }) {
      return { url: `https://storage.test/${mediaBucket}/${object}?sig=upload`, method: 'PUT', headers: { 'Content-Type': contentType, 'x-goog-content-length-range': `${size},${size}` }, expires_in: 900 };
    },
    async signedReadUrl({ object, downloadName }) {
      return `https://storage.test/${mediaBucket}/${object}?sig=read${downloadName ? '&download=1' : ''}`;
    },
    async head(object) {
      return objects.get(object) ?? null;
    },
    async promote(from, to) {
      objects.set(to, objects.get(from));
      objects.delete(from);
    },
    async remove(object) {
      objects.delete(object);
    },
    async publish(object, publicObject) {
      published.set(publicObject, object);
      return `https://storage.googleapis.com/${publicBucket}/${publicObject}`;
    },
    async unpublish(publicObject) {
      published.delete(publicObject);
    }
  };
}

const allowAll = Object.fromEntries(['auth', 'authEmail', 'mfa', 'mutations', 'invites', 'uploads', 'launch'].map((name) => [name, () => true]));

/** Starts an API server. Rate limits are off unless `realLimits: true` (tests about throttling). */
export async function start(t, options = {}) {
  resetInMemoryDb();
  const mail = [];
  const { env, storage, realLimits, ...rest } = options;
  const server = createServer({
    env: { SITE_ORIGIN: 'https://site.test', MFA_ENCRYPTION_KEY: MFA_KEY, ...env },
    sendEmail: async (message) => { mail.push(message); },
    storage: storage ?? fakeStorage(),
    limiters: realLimits ? undefined : allowAll,
    ...rest
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, mail };
}

export async function call(baseUrl, path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

export function tokenFrom(message, path) {
  const match = message.text.match(new RegExp(`${path}\\?token=([^\\s]+)`));
  assert.ok(match, `expected a ${path} link`);
  return decodeURIComponent(match[1]);
}

/** Creates a verified password account directly in the store and signs it in. */
export async function account(baseUrl, email, { role = 'user', name } = {}) {
  const user = { ...newUser({ email, name: name ?? email.split('@')[0], provider: 'password', emailVerified: true, role }), password_hash: await hashPassword(PASSWORD) };
  await saveUser(user);
  const login = await call(baseUrl, '/api/v1/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { user, token: login.data.access_token, cookie: login.headers.get('set-cookie') };
}
