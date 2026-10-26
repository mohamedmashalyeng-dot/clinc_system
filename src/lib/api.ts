// Thin fetch wrapper. Every state-changing call carries the CSRF header the server requires.

export interface ApiIssue {
  path: string;
  code: string;
  message: string;
  minimum?: number;
  maximum?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
  get issues(): ApiIssue[] {
    return (this.details?.issues as ApiIssue[]) ?? [];
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; file?: Blob } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'LumaClinic',
        ...(opts.file ? { 'Content-Type': opts.file.type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.file ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    const err = new ApiError(res.status, e.code ?? 'HTTP_' + res.status, e.message ?? res.statusText, e.details);
    if (res.status === 401 && !path.includes('/auth/login')) window.dispatchEvent(new CustomEvent('luma:unauthenticated'));
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, file: Blob, query?: Query) => request<T>('POST', path, undefined, { file, query }),
};

export function newKey(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
