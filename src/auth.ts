import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';
import type { Role, UserAccount } from './types';

// ---------- Password hashing (scrypt, built into Node — no native deps) ----------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Readable random password for first login, e.g. "Kx7p-Q2mv-9Tzd" */
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `${block()}-${block()}-${block()}`;
}

// ---------- Tokens ----------

export interface TokenPayload {
  sub: string; // user id
  email: string;
  role: Role;
  name: string;
}

export function signToken(user: UserAccount): string {
  const payload: TokenPayload = { sub: user.id, email: user.email, role: user.role, name: user.name };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}

/** Strip every secret field before sending a user to the client. */
export function publicUser(user: UserAccount): Omit<UserAccount, 'passwordHash' | 'temporaryPassword'> {
  const { passwordHash, temporaryPassword, ...safe } = user;
  return safe;
}

// ---------- Express middleware ----------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = payload;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}
