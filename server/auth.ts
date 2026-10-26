import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { all, get, nowIso, parseJson, run, scalar } from './db/db.js';
import { ApiError, forbidden, notFound } from './http.js';
import { isPermission, type Permission, type Role } from '../shared/permissions.js';

export const SESSION_COOKIE = 'luma_session';
const SESSION_TTL_HOURS = 12;

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  permissions: Set<Permission>;
  practitionerId: number | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(userId: number): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000).toISOString();
  run('INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)', [
    tokenHash(token),
    userId,
    now.toISOString(),
    expiresAt,
    now.toISOString(),
  ]);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', [now.toISOString(), userId]);
  return { token, expiresAt };
}

export function destroySession(token: string | undefined): void {
  if (token) run('DELETE FROM auth_sessions WHERE token_hash = ?', [tokenHash(token)]);
}

export function effectivePermissions(role: Role, extraJson: string): Set<Permission> {
  const perms = new Set<Permission>();
  for (const r of all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ?', [role])) {
    if (isPermission(r.permission)) perms.add(r.permission);
  }
  for (const p of parseJson<string[]>(extraJson, [])) if (isPermission(p)) perms.add(p);
  return perms;
}

export function loadUser(userId: number): AuthUser | null {
  const u = get<{ id: number; name: string; email: string; role: Role; extra_permissions: string; active: number }>(
    'SELECT id, name, email, role, extra_permissions, active FROM users WHERE id = ?',
    [userId],
  );
  if (!u || !u.active) return null;
  const practitionerId = scalar<number | null>('SELECT id FROM practitioners WHERE user_id = ? AND active = 1', [u.id]);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    permissions: effectivePermissions(u.role, u.extra_permissions),
    practitionerId: practitionerId ?? null,
  };
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    const s = get<{ user_id: number; expires_at: string }>('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?', [
      tokenHash(token),
    ]);
    if (s && s.expires_at > nowIso()) {
      const user = loadUser(s.user_id);
      if (user) req.user = user;
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  next();
}

/** Route guard: the user must hold every listed permission. */
export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    assertPerm(req, ...perms);
    next();
  };
}

export function assertPerm(req: Request, ...perms: Permission[]): AuthUser {
  const user = req.user;
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  const missing = perms.filter((p) => !user.permissions.has(p));
  if (missing.length) throw forbidden(`This action requires the "${missing.join('", "')}" permission.`, 'FORBIDDEN', { missing });
  return user;
}

export function can(req: Request, perm: Permission): boolean {
  return !!req.user?.permissions.has(perm);
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  return req.user;
}

/**
 * SQL fragment restricting patients to those the user may see. Practitioners without
 * `patients.view_all` see patients assigned to them or booked with them.
 */
export function patientScopeSql(user: AuthUser, alias = 'p'): { sql: string; params: unknown[] } {
  if (user.permissions.has('patients.view_all')) return { sql: '1=1', params: [] };
  if (user.permissions.has('patients.view') && user.practitionerId) {
    return {
      sql: `(${alias}.primary_practitioner_id = ? OR EXISTS (SELECT 1 FROM appointments sa WHERE sa.patient_id = ${alias}.id AND sa.practitioner_id = ?))`,
      params: [user.practitionerId, user.practitionerId],
    };
  }
  return { sql: '1=0', params: [] };
}

export function assertPatientAccess(req: Request, patientId: number): AuthUser {
  const user = assertPerm(req, 'patients.view');
  const scope = patientScopeSql(user);
  const ok = scalar<number>(`SELECT COUNT(*) FROM patients p WHERE p.id = ? AND ${scope.sql}`, [patientId, ...scope.params]);
  if (!ok) {
    const exists = scalar<number>('SELECT COUNT(*) FROM patients WHERE id = ?', [patientId]);
    if (!exists) throw notFound('Patient');
    throw forbidden('This patient is not assigned to you.', 'PATIENT_NOT_ASSIGNED');
  }
  return user;
}

// Simple in-memory throttle for sign-in attempts.
const attempts = new Map<string, { count: number; until: number }>();
export function checkLoginThrottle(key: string): void {
  const a = attempts.get(key);
  if (a && a.count >= 5 && a.until > Date.now()) {
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again in a few minutes.');
  }
}
export function recordLoginFailure(key: string): void {
  const a = attempts.get(key);
  const count = a && a.until > Date.now() ? a.count + 1 : 1;
  attempts.set(key, { count, until: Date.now() + 5 * 60_000 });
}
export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}
