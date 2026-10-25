import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

const DEFAULT_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'home-509818';

let firestoreInstance = null;
let firestoreDisabled = false;

// In-memory fallback database for tests and offline/local execution.
const memoryStore = {
  users: new Map(),
  sessions: new Map(),
  refreshTokens: new Map()
};

export function resetInMemoryDb() {
  memoryStore.users.clear();
  memoryStore.sessions.clear();
  memoryStore.refreshTokens.clear();
}

// Tokens are stored only as SHA-256 digests so a database read does not yield usable credentials.
function tokenId(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function setFirestoreDisabled(disabled) {
  firestoreDisabled = disabled;
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
        ...options
      });
    } catch (err) {
      console.error('Firestore initialization warning (falling back to in-memory):', err.message);
      firestoreInstance = null;
    }
  }
  return firestoreInstance;
}

export async function findUserByProvider(provider, providerId) {
  const db = getFirestore();
  if (db) {
    try {
      const snapshot = await db.collection('users')
        .where('provider', '==', provider)
        .where('provider_id', '==', String(providerId))
        .limit(1)
        .get();
      if (!snapshot.empty) {
        return snapshot.docs[0].data();
      }
    } catch (err) {
      console.error('Firestore query failed, using memory store:', err.message);
    }
  }

  for (const user of memoryStore.users.values()) {
    if (user.provider === provider && user.provider_id === String(providerId)) {
      return user;
    }
  }
  return null;
}

export async function findUserByEmail(email) {
  const normalized = email.toLowerCase().trim();
  const db = getFirestore();
  if (db) {
    try {
      const snapshot = await db.collection('users')
        .where('email', '==', normalized)
        .limit(1)
        .get();
      if (!snapshot.empty) {
        return snapshot.docs[0].data();
      }
    } catch (err) {
      console.error('Firestore query failed, using memory store:', err.message);
    }
  }

  for (const user of memoryStore.users.values()) {
    if (user.email === normalized) {
      return user;
    }
  }
  return null;
}

export async function getUserById(id) {
  const db = getFirestore();
  if (db) {
    try {
      const doc = await db.collection('users').doc(id).get();
      if (doc.exists) {
        return doc.data();
      }
    } catch (err) {
      console.error('Firestore get failed, using memory store:', err.message);
    }
  }
  return memoryStore.users.get(id) || null;
}

export async function createOrUpdateUserFromProvider({
  provider,
  providerId,
  email,
  name,
  avatarUrl = null,
  emailVerified = true
}) {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = (await findUserByProvider(provider, providerId)) || (await findUserByEmail(normalizedEmail));
  const now = new Date().toISOString();

  let user;
  if (existing) {
    user = {
      ...existing,
      full_name: name || existing.full_name || normalizedEmail.split('@')[0],
      avatar_url: avatarUrl || existing.avatar_url || null,
      email_verified: existing.email_verified || Boolean(emailVerified),
      provider: existing.provider || provider,
      provider_id: existing.provider_id || String(providerId),
      last_login_at: now,
      updated_at: now
    };
  } else {
    user = {
      id: `usr_${randomUUID()}`,
      email: normalizedEmail,
      full_name: name || normalizedEmail.split('@')[0],
      avatar_url: avatarUrl,
      role: 'user',
      provider,
      provider_id: String(providerId),
      email_verified: Boolean(emailVerified),
      created_at: now,
      last_login_at: now,
      updated_at: now
    };
  }

  // Persist to memory store
  memoryStore.users.set(user.id, user);

  // Persist to Firestore
  const db = getFirestore();
  if (db) {
    try {
      await db.collection('users').doc(user.id).set(user, { merge: true });
    } catch (err) {
      console.error('Firestore set failed, stored in memory only:', err.message);
    }
  }

  return user;
}

export async function updateUser(id, updates) {
  const user = await getUserById(id);
  if (!user) return null;

  const updated = {
    ...user,
    ...updates,
    updated_at: new Date().toISOString()
  };

  memoryStore.users.set(id, updated);

  const db = getFirestore();
  if (db) {
    try {
      await db.collection('users').doc(id).set(updated, { merge: true });
    } catch (err) {
      console.error('Firestore update failed:', err.message);
    }
  }

  return updated;
}

function tokenRecord(userId, expiresAt) {
  return {
    user_id: userId,
    expires_at: expiresAt,
    // Timestamp field for the Firestore TTL policy; expires_at stays numeric for comparisons.
    expire_at: new Date(expiresAt),
    created_at: new Date().toISOString()
  };
}

async function saveToken(collection, store, token, record) {
  const id = tokenId(token);
  store.set(id, record);
  const db = getFirestore();
  if (db) {
    try {
      await db.collection(collection).doc(id).set(record);
    } catch (err) {
      console.error(`Firestore ${collection} save failed:`, err.message);
    }
  }
  return record;
}

async function deleteToken(collection, store, token) {
  const id = tokenId(token);
  store.delete(id);
  const db = getFirestore();
  if (db) {
    try {
      await db.collection(collection).doc(id).delete();
    } catch (err) {
      console.error(`Firestore ${collection} delete failed:`, err.message);
    }
  }
}

export function saveSession({ token, userId, expiresAt }) {
  return saveToken('sessions', memoryStore.sessions, token, tokenRecord(userId, expiresAt));
}

export async function getSession(token) {
  if (!token) return null;
  const id = tokenId(token);
  let session = null;
  const db = getFirestore();
  if (db) {
    try {
      // Firestore is authoritative so revocations from other instances take effect immediately.
      const doc = await db.collection('sessions').doc(id).get();
      session = doc.exists ? doc.data() : null;
    } catch (err) {
      console.error('Firestore getSession failed, using memory store:', err.message);
      session = memoryStore.sessions.get(id) ?? null;
    }
  } else {
    session = memoryStore.sessions.get(id) ?? null;
  }
  return session && session.expires_at > Date.now() ? session : null;
}

export function deleteSession(token) {
  return deleteToken('sessions', memoryStore.sessions, token);
}

export function saveRefreshToken({ token, userId, expiresAt }) {
  return saveToken('refresh_tokens', memoryStore.refreshTokens, token, tokenRecord(userId, expiresAt));
}

export function deleteRefreshToken(token) {
  return deleteToken('refresh_tokens', memoryStore.refreshTokens, token);
}

/** Returns the refresh token's record and deletes it, so each refresh token is usable once. */
export async function consumeRefreshToken(token) {
  if (!token) return null;
  const id = tokenId(token);
  let record = memoryStore.refreshTokens.get(id) ?? null;
  memoryStore.refreshTokens.delete(id);
  const db = getFirestore();
  if (db) {
    try {
      const ref = db.collection('refresh_tokens').doc(id);
      record = await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(ref);
        if (!doc.exists) return null;
        transaction.delete(ref);
        return doc.data();
      });
    } catch (err) {
      console.error('Firestore consumeRefreshToken failed, using memory store:', err.message);
    }
  }
  return record && record.expires_at > Date.now() ? record : null;
}

/** Revokes every access and refresh token belonging to the user. */
export async function deleteUserSessions(userId) {
  for (const store of [memoryStore.sessions, memoryStore.refreshTokens]) {
    for (const [id, record] of store) {
      if (record.user_id === userId) store.delete(id);
    }
  }
  const db = getFirestore();
  if (!db) return;
  for (const collection of ['sessions', 'refresh_tokens']) {
    try {
      const snapshot = await db.collection(collection).where('user_id', '==', userId).get();
      const batch = db.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    } catch (err) {
      console.error(`Firestore ${collection} revocation failed:`, err.message);
    }
  }
}
