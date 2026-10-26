import { newId, setDoc } from './db.mjs';
import { sha256 } from './security.mjs';

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const SECRET_KEYS = /token|password|secret|code|hash|credential/i;

function scrub(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)));
}

/** Records who changed what. Never pass secrets; keys that look secret are dropped anyway. */
export async function writeAudit({ actorId, action, target, clientId = null, ip = '', userAgent = '', requestId = '', diff = null }) {
  const id = newId('aud');
  const now = Date.now();
  try {
    await setDoc('audit_log', id, {
      id,
      actor_id: actorId,
      action,
      target_type: target?.type ?? null,
      target_id: target?.id ?? null,
      client_id: clientId,
      ip_hash: ip ? sha256(`ip:${ip}`).slice(0, 16) : null,
      user_agent: String(userAgent).slice(0, 200),
      request_id: requestId,
      diff: scrub(diff),
      ts: new Date(now).toISOString(),
      expires_at: now + RETENTION_MS
    });
  } catch (err) {
    // Auditing must not break the user's action; the failure itself is logged.
    console.error(JSON.stringify({ severity: 'ERROR', message: 'Audit write failed', action, request_id: requestId, error: err.message }));
  }
}
