import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const forbidden = (message = 'You do not have permission for this action.', code = 'FORBIDDEN', details?: unknown) =>
  new ApiError(403, code, message, details);
export const notFound = (what = 'Record') => new ApiError(404, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);

export function validate<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw zodToApiError(r.error);
  return r.data;
}

function zodToApiError(err: ZodError): ApiError {
  const issues = err.issues.map((i) => ({
    path: i.path.join('.'),
    code: i.code,
    message: i.message,
    ...('minimum' in i ? { minimum: Number(i.minimum) } : {}),
    ...('maximum' in i ? { maximum: Number(i.maximum) } : {}),
    ...('type' in i ? { type: i.type } : {}),
    ...('received' in i ? { received: i.received } : {}),
    ...('validation' in i && typeof i.validation === 'string' ? { validation: i.validation } : {}),
  }));
  return new ApiError(422, 'VALIDATION_FAILED', 'Some fields need attention.', { issues });
}

export function intParam(value: unknown, name = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('INVALID_PARAM', `Invalid ${name}.`);
  return n;
}

export function optInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function optStr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function pageParams(q: Request['query'], defaultSize = 20): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(q.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    const e = zodToApiError(err);
    res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('SCHEDULING_CONFLICT')) {
    res.status(409).json({
      error: { code: 'SCHEDULING_CONFLICT', message: 'Another booking took this time while you were editing. Check availability again.' },
    });
    return;
  }
  if (msg.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'This record already exists.' } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'The file is larger than the 12 MB limit.' } });
    return;
  }
  // Log the technical error without request bodies, which may contain clinical data.
  console.error(`[api] ${req.method} ${req.path} failed:`, msg);
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server. Please try again.' } });
}
