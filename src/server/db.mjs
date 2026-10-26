import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { sha256 } from './security.mjs';
import { HttpError } from './http.mjs';

const DEFAULT_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'home-509818';
// Batches are capped at 500 writes; stay well below it.
const BATCH_SIZE = 400;

let firestoreInstance = null;
let firestoreDisabled = process.env.FIRESTORE_DISABLED === 'true';
let memoryFallbackAllowed = process.env.ALLOW_MEMORY_DB_FALLBACK !== 'false';

/** Thrown when Firestore fails and the in-memory fallback is disabled (production). */
export class DatabaseUnavailableError extends Error {
  constructor(cause) {
    super('The database is temporarily unavailable.');
    this.cause = cause;
  }
}

// In-memory database for tests and offline/local execution. One Map per collection.
const memoryStore = new Map();

function memory(collection) {
  if (!memoryStore.has(collection)) memoryStore.set(collection, new Map());
  return memoryStore.get(collection);
}

export function resetInMemoryDb() {
  memoryStore.clear();
}

export function setFirestoreDisabled(disabled) {
  firestoreDisabled = disabled;
}

export function setMemoryFallbackAllowed(allowed) {
  memoryFallbackAllowed = allowed;
}

export function setFirestoreInstance(instance) {
  firestoreInstance = instance;
  firestoreDisabled = false;
}

export function getFirestore(options = {}) {
  if (firestoreDisabled) return null;
  if (!firestoreInstance) {
    try {
      firestoreInstance = new Firestore({
        projectId: options.projectId || DEFAULT_PROJECT_ID,
        ...(process.env.FIRESTORE_DATABASE ? { databaseId: process.env.FIRESTORE_DATABASE } : {}),
        ignoreUndefinedProperties: true,
        ...options
      });
    } catch (err) {
      if (!memoryFallbackAllowed) throw new DatabaseUnavailableError(err);
      console.error('Firestore initialization warning (falling back to in-memory):', err.message);
      firestoreInstance = null;
    }
  }
  return firestoreInstance;
}

/** Reports which backend is active; throws DatabaseUnavailableError when Firestore is unreachable. */
export async function checkDatabase() {
  const db = getFirestore();
  if (!db) return 'memory';
  try {
    await db.collection('_health').limit(1).get();
    return 'firestore';
  } catch (err) {
    throw new DatabaseUnavailableError(err);
  }
}

async function run(operation, fallback) {
  const db = getFirestore();
  if (!db) return fallback();
  try {
    return await operation(db);
  } catch (err) {
    // Business-rule failures raised inside a transaction are not database outages.
    if (err instanceof HttpError) throw err;
    if (!memoryFallbackAllowed) {
      console.error(JSON.stringify({ severity: 'ERROR', message: 'Firestore operation failed', error: err.message }));
      throw new DatabaseUnavailableError(err);
    }
    console.error('Firestore operation failed, using memory store:', err.message);
    return fallback();
  }
}

// TTL fields are Firestore Timestamps used only by TTL policies; never expose them.
function clean(data) {
  if (!data) return null;
  const copy = { ...data };
  for (const key of Object.keys(copy)) if (key === 'expire_at' || key.endsWith('_expire_at')) delete copy[key];
  return copy;
}

function withTtl(data) {
  const copy = { ...data };
  if (typeof copy.expires_at === 'number') copy.expire_at = new Date(copy.expires_at);
  return copy;
}

function matches(doc, [field, op, value]) {
  const actual = doc[field];
  switch (op) {
    case '==': return actual === value;
    case '!=': return actual !== value;
    case 'in': return value.includes(actual);
    case 'array-contains': return Array.isArray(actual) && actual.includes(value);
    case '<': return actual < value;
    case '<=': return actual <= value;
    case '>': return actual > value;
    case '>=': return actual >= value;
    default: throw new Error(`Unsupported operator ${op}`);
  }
}

export async function getDoc(collection, id) {
  if (!id) return null;
  return run(async (db) => {
    const doc = await db.collection(collection).doc(String(id)).get();
    return doc.exists ? clean(doc.data()) : null;
  }, () => clean(memory(collection).get(String(id)) ?? null));
}

export async function setDoc(collection, id, data) {
  const stored = withTtl(data);
  await run(
    (db) => db.collection(collection).doc(String(id)).set(stored),
    () => memory(collection).set(String(id), stored)
  );
  return clean(stored);
}

export async function deleteDoc(collection, id) {
  await run(
    (db) => db.collection(collection).doc(String(id)).delete(),
    () => memory(collection).delete(String(id))
  );
}

/**
 * Read-modify-write in a transaction. `mutate(current)` returns the next document,
 * `null` to delete, or `undefined` to leave it unchanged. Resolves to { before, after }.
 */
export async function updateDoc(collection, id, mutate) {
  return run(async (db) => {
    const ref = db.collection(collection).doc(String(id));
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const before = snapshot.exists ? clean(snapshot.data()) : null;
      const after = await mutate(before);
      if (after === null) transaction.delete(ref);
      else if (after !== undefined) transaction.set(ref, withTtl(after));
      return { before, after: after === undefined ? before : clean(after) };
    });
  }, async () => {
    const store = memory(collection);
    const before = clean(store.get(String(id)) ?? null);
    const after = await mutate(before);
    if (after === null) store.delete(String(id));
    else if (after !== undefined) store.set(String(id), withTtl(after));
    return { before, after: after === undefined ? before : clean(after) };
  });
}

/** Equality/range filters only; callers sort and page in process (see docs/data-model.md). */
export async function queryDocs(collection, { where = [], limit = 1000 } = {}) {
  return run(async (db) => {
    let query = db.collection(collection);
    for (const [field, op, value] of where) query = query.where(field, op, value);
    const snapshot = await query.limit(limit).get();
    return snapshot.docs.map((doc) => clean(doc.data()));
  }, () => [...memory(collection).values()].filter((doc) => where.every((clause) => matches(doc, clause))).slice(0, limit).map(clean));
}

export async function deleteWhere(collection, where) {
  return run(async (db) => {
    let query = db.collection(collection);
    for (const [field, op, value] of where) query = query.where(field, op, value);
    const snapshot = await query.get();
    for (let index = 0; index < snapshot.docs.length; index += BATCH_SIZE) {
      const batch = db.batch();
      snapshot.docs.slice(index, index + BATCH_SIZE).forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
    return snapshot.size;
  }, () => {
    const store = memory(collection);
    let removed = 0;
    for (const [id, doc] of store) {
      if (where.every((clause) => matches(doc, clause))) {
        store.delete(id);
        removed += 1;
      }
    }
    return removed;
  });
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

// --- Users -----------------------------------------------------------------------

export async function getUserById(id) {
  return getDoc('users', id);
}

export async function findUserByEmail(email) {
  const normalized = String(email).toLowerCase().trim();
  const [user] = await queryDocs('users', { where: [['email', '==', normalized]], limit: 1 });
  return user ?? null;
}

export async function findUserByProvider(provider, providerId) {
  const id = String(providerId);
  const [linked] = await queryDocs('users', { where: [[`${provider}_sub`, '==', id]], limit: 1 });
  if (linked) return linked;
  const [legacy] = await queryDocs('users', { where: [['provider', '==', provider], ['provider_id', '==', id]], limit: 1 });
  return legacy ?? null;
}

export async function saveUser(user) {
  return setDoc('users', user.id, user);
}

export function newUser({ email, name, provider, providerId = null, emailVerified, avatarUrl = null, role = 'user' }) {
  const now = new Date().toISOString();
  const normalizedEmail = email.toLowerCase().trim();
  return {
    id: newId('usr'),
    email: normalizedEmail,
    full_name: name || normalizedEmail.split('@')[0],
    avatar_url: avatarUrl,
    role,
    status: 'active',
    provider,
    provider_id: providerId,
    ...(providerId && provider !== 'password' ? { [`${provider}_sub`]: String(providerId) } : {}),
    email_verified: Boolean(emailVerified),
    created_at: now,
    last_login_at: null,
    updated_at: now
  };
}

export async function createOrUpdateUserFromProvider({ provider, providerId, email, name, avatarUrl = null, emailVerified = true }) {
  const normalizedEmail = email.toLowerCase().trim();
  const linked = await findUserByProvider(provider, providerId);
  let existing = linked || (await findUserByEmail(normalizedEmail));
  // An unverified account matched only by email may have been registered by someone else.
  // The provider has proven ownership of the address, so that account's credentials are discarded.
  if (existing && !linked && !existing.email_verified && emailVerified) {
    await deleteUserSessions(existing.id);
    existing = { ...existing, password_hash: null, mfa: null, mfa_pending: null };
  }
  const now = new Date().toISOString();
  const user = existing
    ? {
      ...existing,
      full_name: existing.full_name || name || normalizedEmail.split('@')[0],
      avatar_url: existing.avatar_url || avatarUrl || null,
      email_verified: existing.email_verified || Boolean(emailVerified),
      provider: existing.provider || provider,
      provider_id: existing.provider_id || String(providerId),
      [`${provider}_sub`]: String(providerId),
      last_login_at: now,
      updated_at: now
    }
    : { ...newUser({ email: normalizedEmail, name, provider, providerId, emailVerified, avatarUrl }), last_login_at: now };
  return saveUser(user);
}

export async function updateUser(id, updates) {
  const { after } = await updateDoc('users', id, (user) => (user ? { ...user, ...updates, updated_at: new Date().toISOString() } : undefined));
  return after;
}

// --- Sessions ----------------------------------------------------------------------
// Each sign-in creates a session family (user_sessions/{session_id}). Access tokens and
// rotating refresh tokens are stored by SHA-256 digest and carry the family id, so a
// family can be listed and revoked as one "device".

export async function createUserSession({ userId, client = 'web', userAgent = '', ip = '', amr = [] }) {
  const now = Date.now();
  const record = {
    id: newId('ses'),
    user_id: userId,
    client,
    user_agent: String(userAgent).slice(0, 200),
    ip_hash: ip ? sha256(`ip:${ip}`).slice(0, 16) : null,
    amr,
    created_at: new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString(),
    // Absolute lifetime of a family: 90 days.
    expires_at: now + 90 * 24 * 60 * 60 * 1000
  };
  return setDoc('user_sessions', record.id, record);
}

export async function getUserSession(sessionId) {
  const record = await getDoc('user_sessions', sessionId);
  return record && record.expires_at > Date.now() ? record : null;
}

export async function listUserSessions(userId) {
  const records = await queryDocs('user_sessions', { where: [['user_id', '==', userId]] });
  return records.filter((record) => record.expires_at > Date.now());
}

export async function touchUserSession(sessionId) {
  await updateDoc('user_sessions', sessionId, (record) => (record ? { ...record, last_seen_at: new Date().toISOString() } : undefined));
}

export function saveSession({ token, userId, expiresAt, sessionId = null, client = 'web' }) {
  return setDoc('sessions', sha256(token), {
    user_id: userId, session_id: sessionId, client, expires_at: expiresAt, created_at: new Date().toISOString()
  });
}

export async function getSession(token) {
  if (!token) return null;
  const session = await getDoc('sessions', sha256(token));
  return session && session.expires_at > Date.now() ? session : null;
}

export function deleteSession(token) {
  return deleteDoc('sessions', sha256(token));
}

export function saveRefreshToken({ token, userId, expiresAt, sessionId = null, client = 'web' }) {
  return setDoc('refresh_tokens', sha256(token), {
    user_id: userId, session_id: sessionId, client, expires_at: expiresAt, used_at: null, created_at: new Date().toISOString()
  });
}

export function deleteRefreshToken(token) {
  return deleteDoc('refresh_tokens', sha256(token));
}

/**
 * Marks a refresh token as used and returns its record. A token presented a second time
 * is treated as stolen: the whole session family is revoked and `{ reused: true }` returned.
 */
export async function consumeRefreshToken(token) {
  if (!token) return null;
  const { before } = await updateDoc('refresh_tokens', sha256(token), (record) => {
    if (!record || record.used_at) return undefined;
    // Keep the used marker until the original expiry so reuse can be detected.
    return { ...record, used_at: new Date().toISOString() };
  });
  if (!before || before.expires_at <= Date.now()) return null;
  if (before.used_at) {
    if (before.session_id) await revokeUserSession(before.session_id);
    else await deleteUserSessions(before.user_id);
    return { reused: true, user_id: before.user_id };
  }
  return before;
}

export async function revokeUserSession(sessionId) {
  await Promise.all([
    deleteWhere('sessions', [['session_id', '==', sessionId]]),
    deleteWhere('refresh_tokens', [['session_id', '==', sessionId]]),
    deleteDoc('user_sessions', sessionId)
  ]);
}

/** Revokes every session family of the user, optionally keeping one. */
export async function deleteUserSessions(userId, { except = null } = {}) {
  const families = await queryDocs('user_sessions', { where: [['user_id', '==', userId]] });
  for (const family of families) if (family.id !== except) await revokeUserSession(family.id);
  if (!except) {
    // Tokens issued before session families existed have no session_id.
    await deleteWhere('sessions', [['user_id', '==', userId]]);
    await deleteWhere('refresh_tokens', [['user_id', '==', userId]]);
  }
}

// --- Single-use tokens (email verification, password reset, invites, launch, MFA) ---

export async function saveOneTimeToken(collection, token, record, ttlMs) {
  return setDoc(collection, sha256(token), { ...record, expires_at: Date.now() + ttlMs, created_at: new Date().toISOString() });
}

/** Atomically consumes a single-use token. Returns its record, or null if unknown/expired/used. */
export async function consumeOneTimeToken(collection, token) {
  if (!token || typeof token !== 'string') return null;
  const { before } = await updateDoc(collection, sha256(token), (record) => (record ? null : undefined));
  return before && before.expires_at > Date.now() ? before : null;
}

export async function peekOneTimeToken(collection, token) {
  if (!token || typeof token !== 'string') return null;
  const record = await getDoc(collection, sha256(token));
  return record && record.expires_at > Date.now() ? record : null;
}
