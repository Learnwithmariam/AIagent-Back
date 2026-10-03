import { sign, verify } from 'hono/jwt';
import type { Config } from './config';
import type { Role, UserAccount } from './types';

// ---------- helpers ----------

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Unbiased random integer in [0, max) */
function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- One-time sign-in codes ----------

/** 6-digit code, uniformly random (leading zeros allowed). */
export function generateOtp(): string {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

/**
 * HMAC-SHA256(secret, email:code). Only this hash is stored, so a database leak doesn't reveal
 * live codes, and the 10^6 code space can't be brute-forced offline without the server secret.
 */
export async function hashOtp(email: string, code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${email.trim().toLowerCase()}:${code}`));
  return toHex(new Uint8Array(mac));
}

export function otpMatches(storedHash: string, candidateHash: string): boolean {
  return timingSafeEqual(fromHex(storedHash), fromHex(candidateHash));
}

// ---------- Tokens ----------

export interface TokenPayload {
  sub: string; // user id
  email: string;
  role: Role;
  name: string;
}

/** Only the configured admin email is ever an admin, whatever a stored record or old token says. */
export const roleFor = (email: string, config: Config): Role =>
  email.trim().toLowerCase() === config.adminEmail ? 'admin' : 'student';

export async function signToken(user: UserAccount, config: Config): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: user.id, email: user.email, role: roleFor(user.email, config), name: user.name, iat: now, exp: now + config.jwtExpiresInSeconds },
    config.jwtSecret,
    'HS256'
  );
}

export async function verifyToken(token: string, config: Config): Promise<TokenPayload | null> {
  if (!token) return null;
  try {
    const p = await verify(token, config.jwtSecret, 'HS256');
    if (typeof p.sub !== 'string' || typeof p.email !== 'string') return null;
    return { sub: p.sub, email: p.email, role: roleFor(p.email, config), name: String(p.name || '') };
  } catch {
    return null;
  }
}

/** Strip every secret field (including legacy password hashes) before sending a user to the client. */
export function publicUser(user: UserAccount): Omit<UserAccount, 'passwordHash' | 'temporaryPassword'> {
  const { passwordHash, temporaryPassword, ...safe } = user;
  return safe;
}
