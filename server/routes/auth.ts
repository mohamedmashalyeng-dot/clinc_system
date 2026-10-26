import { Router } from 'express';
import { get } from '../db/db.js';
import {
  SESSION_COOKIE,
  checkLoginThrottle,
  clearLoginFailures,
  createSession,
  currentUser,
  destroySession,
  recordLoginFailure,
  verifyPassword,
} from '../auth.js';
import { audit } from '../audit.js';
import { ApiError, validate } from '../http.js';
import { loginSchema } from '../../shared/schemas.js';
import { DEMO_MODE, getSettings } from '../settings.js';

export const authRouter = Router();

const isProd = process.env.NODE_ENV === 'production';

authRouter.post('/login', (req, res) => {
  const body = validate(loginSchema, req.body);
  const key = `${body.email}|${req.ip}`;
  checkLoginThrottle(key);
  const user = get<{ id: number; password_hash: string; active: number; name: string }>(
    'SELECT id, password_hash, active, name FROM users WHERE email = ?',
    [body.email],
  );
  if (!user || !user.active || !verifyPassword(body.password, user.password_hash)) {
    recordLoginFailure(key);
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
  }
  clearLoginFailures(key);
  const { token, expiresAt } = createSession(user.id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd && process.env.LUMA_INSECURE_COOKIES !== 'true',
    expires: new Date(expiresAt),
    path: '/',
  });
  audit({ id: user.id } as never, 'auth.login', { entityType: 'user', entityId: user.id, summary: `${user.name} signed in` });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  if (req.user) audit(req.user, 'auth.logout', { entityType: 'user', entityId: req.user.id });
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const user = currentUser(req);
  const s = getSettings();
  const logo = get<{ logo_file: string | null }>('SELECT logo_file FROM settings WHERE id = 1');
  res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, practitionerId: user.practitionerId },
    permissions: [...user.permissions],
    demoMode: DEMO_MODE,
    settings: { ...s, hasLogo: !!logo?.logo_file },
  });
});

/** Public, non-sensitive bits for the sign-in page. */
authRouter.get('/public', (_req, res) => {
  const s = getSettings();
  const logo = get<{ logo_file: string | null }>('SELECT logo_file FROM settings WHERE id = 1');
  res.json({
    clinicName: s.clinicName,
    clinicNameAr: s.clinicNameAr,
    defaultLanguage: s.defaultLanguage,
    hasLogo: !!logo?.logo_file,
    demoMode: DEMO_MODE,
    demoAccounts: DEMO_MODE
      ? [
          { role: 'owner', email: 'owner@luma.demo' },
          { role: 'receptionist', email: 'reception@luma.demo' },
          { role: 'practitioner', email: 'dr.nour@luma.demo' },
          { role: 'accountant', email: 'accounts@luma.demo' },
        ]
      : [],
    demoPassword: DEMO_MODE ? 'demo1234' : null,
  });
});
