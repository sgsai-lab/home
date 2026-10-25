import { createPublicKey } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_KEYS_TTL_MS = 60 * 60 * 1000;

export class CredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function notConfigured(provider) {
  return new CredentialError('PROVIDER_NOT_CONFIGURED', `${provider} sign-in is not configured.`);
}

function invalid(provider) {
  return new CredentialError('INVALID_CREDENTIAL', `${provider} sign-in could not be verified. Please try again.`);
}

function requireNonce(payload, nonce, provider) {
  if (nonce !== undefined && payload.nonce !== nonce) throw invalid(provider);
}

function keyIdOf(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString('utf8')).kid;
  } catch {
    return undefined;
  }
}

/** Verifies Google Identity Services ID tokens (signature, issuer, audience, expiry, nonce). */
export function createGoogleVerifier({ clientId, client = new OAuth2Client() }) {
  return async (idToken, nonce) => {
    if (!clientId) throw notConfigured('Google');
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw invalid('Google');
    let payload;
    try {
      payload = (await client.verifyIdToken({ idToken, audience: clientId })).getPayload();
    } catch {
      throw invalid('Google');
    }
    if (!payload?.sub || !GOOGLE_ISSUERS.includes(payload.iss)) throw invalid('Google');
    requireNonce(payload, nonce, 'Google');
    return payload;
  };
}

async function fetchAppleKeys() {
  const response = await fetch(APPLE_KEYS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Apple keys request failed with ${response.status}.`);
  return (await response.json()).keys;
}

/** Verifies Sign in with Apple ID tokens against Apple's published JWKS. */
export function createAppleVerifier({ clientId, fetchKeys = fetchAppleKeys, client = new OAuth2Client() }) {
  let cache = { certs: {}, fetchedAt: 0 };

  async function certsFor(kid) {
    const stale = Date.now() - cache.fetchedAt > APPLE_KEYS_TTL_MS;
    if (stale || !Object.hasOwn(cache.certs, kid)) {
      const keys = await fetchKeys();
      cache = {
        fetchedAt: Date.now(),
        certs: Object.fromEntries(keys.map((key) => [key.kid, createPublicKey({ key, format: 'jwk' }).export({ type: 'spki', format: 'pem' })]))
      };
    }
    return cache.certs;
  }

  return async (idToken, nonce) => {
    if (!clientId) throw notConfigured('Apple');
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw invalid('Apple');
    let payload;
    try {
      const certs = await certsFor(keyIdOf(idToken));
      payload = (await client.verifySignedJwtWithCertsAsync(idToken, certs, clientId, [APPLE_ISSUER])).getPayload();
    } catch {
      throw invalid('Apple');
    }
    if (!payload?.sub) throw invalid('Apple');
    requireNonce(payload, nonce, 'Apple');
    return payload;
  };
}
