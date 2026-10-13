import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

const DEFAULT_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'home-509818';

let firestoreInstance = null;
let firestoreDisabled = false;

// In-memory fallback database for tests and offline/local execution.
const memoryStore = {
  users: new Map(),
  sessions: new Map()
};

export function resetInMemoryDb() {
  memoryStore.users.clear();
  memoryStore.sessions.clear();
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

export async function saveSession({ token, userId, expiresAt }) {
  const session = {
    token,
    user_id: userId,
    expires_at: expiresAt,
    created_at: new Date().toISOString()
  };

  memoryStore.sessions.set(token, session);

  const db = getFirestore();
  if (db) {
    try {
      await db.collection('sessions').doc(token).set(session);
    } catch (err) {
      console.error('Firestore saveSession failed:', err.message);
    }
  }

  return session;
}

export async function getSession(token) {
  if (!token) return null;
  let session = memoryStore.sessions.get(token);

  if (!session) {
    const db = getFirestore();
    if (db) {
      try {
        const doc = await db.collection('sessions').doc(token).get();
        if (doc.exists) {
          session = doc.data();
          memoryStore.sessions.set(token, session);
        }
      } catch (err) {
        console.error('Firestore getSession failed:', err.message);
      }
    }
  }

  if (session && session.expires_at > Date.now()) {
    return session;
  }
  return null;
}

export async function deleteSession(token) {
  memoryStore.sessions.delete(token);
  const db = getFirestore();
  if (db) {
    try {
      await db.collection('sessions').doc(token).delete();
    } catch (err) {
      console.error('Firestore deleteSession failed:', err.message);
    }
  }
}
