import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { authenticate, requireAuth } from './auth.js';
import { ApiError, errorHandler } from './http.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { patientsRouter } from './routes/patients.js';
import { appointmentsRouter } from './routes/appointments.js';
import { clinicalRouter } from './routes/clinical.js';
import { packagesRouter } from './routes/packages.js';
import { billingRouter } from './routes/billing.js';
import { inventoryRouter } from './routes/inventory.js';
import { followupRouter } from './routes/followup.js';
import { reportsRouter } from './routes/reports.js';
import { timeOffRouter } from './routes/timeoff.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  app.use('/api', cookieParser(), express.json({ limit: '1mb' }), authenticate);

  // CSRF defence: state-changing API calls must carry a header that cross-site forms cannot set.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'LumaClinic') {
      throw new ApiError(403, 'CSRF_CHECK_FAILED', 'Request blocked by cross-site request protection.');
    }
    next();
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/auth', authRouter);
  // Everything below requires a signed-in user (the clinic logo is public for the sign-in page).
  app.use('/api', (req, res, next) => (req.method === 'GET' && req.path === '/settings/logo' ? next() : requireAuth(req, res, next)));
  app.use('/api', adminRouter);
  app.use('/api/patients', patientsRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/time-off', timeOffRouter);
  app.use('/api', clinicalRouter);
  app.use('/api/packages', packagesRouter);
  app.use('/api', billingRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/followup', followupRouter);
  app.use('/api', reportsRouter);
  app.use('/api', (_req, _res) => {
    throw new ApiError(404, 'NOT_FOUND', 'Unknown API endpoint.');
  });

  const dist = path.resolve('dist');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
