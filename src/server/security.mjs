import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Returns validation details for a candidate password (empty when acceptable). */
export function passwordProblems(password, field = 'password') {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return [{ field, message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }];
  }
  if (password.length > MAX_PASSWORD_LENGTH) return [{ field, message: `Use at most ${MAX_PASSWORD_LENGTH} characters.` }];
  if (/^(.)\1+$/.test(password)) return [{ field, message: 'Choose a less predictable password.' }];
  return [];
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  // Stored parameters are not trusted: a foreign or corrupted hash must not choose the work factor.
  if (Number(n) !== SCRYPT.N || Number(r) !== SCRYPT.r || Number(p) !== SCRYPT.p) return false;
  let key;
  try {
    key = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), KEY_LENGTH, SCRYPT);
  } catch {
    return false;
  }
  const wanted = Buffer.from(expected, 'base64url');
  return wanted.length === key.length && timingSafeEqual(wanted, key);
}

// Used for unknown accounts so sign-in timing does not reveal whether an email exists.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(String(password ?? ''), dummyHash);
}

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------------------------------------

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of clean) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret, timeMs = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Accepts the current, previous and next 30-second window. Returns the matched step or -1. */
export function verifyTotp(secret, code, timeMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return -1;
  for (const drift of [0, -1, 1]) {
    const at = timeMs + drift * 30_000;
    if (safeEqual(totpCode(secret, at), code)) return Math.floor(at / 30_000);
  }
  return -1;
}

export function otpauthUri(secret, email, issuer = 'SGS AI Technology') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function normalizeRecoveryCode(code) {
  return String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- Encryption at rest (AES-256-GCM) ---------------------------------------------

function keyFrom(secret) {
  if (!secret) return null;
  const decoded = Buffer.from(secret, 'base64');
  return decoded.length === 32 ? decoded : createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext, secret) {
  const key = keyFrom(secret);
  if (!key) throw new Error('Encryption key is not configured.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function decryptSecret(payload, secret) {
  const key = keyFrom(secret);
  if (!key) throw new Error('Encryption key is not configured.');
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// --- Signed, expiring state (HMAC-SHA256) -----------------------------------------

export function signState(payload, secret, ttlMs = 10 * 60 * 1000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyState(state, secret) {
  if (!secret || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  if (!safeEqual(createHmac('sha256', secret).update(body).digest('base64url'), signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
