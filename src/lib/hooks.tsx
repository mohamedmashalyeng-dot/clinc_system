import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ZodTypeAny, z } from 'zod';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { ApiError, type ApiIssue } from './api';
import { useI18n } from '@/i18n';
import type { TKey } from '@/i18n/en';

// ---------------------------------------------------------------- toasts
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<{ push: (kind: Toast['kind'], text: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current;
    setItems((l) => [...l, { id, kind, text }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span className="grow">{t.text}</span>
            <button aria-label="Dismiss" onClick={() => setItems((l) => l.filter((x) => x.id !== t.id))}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast outside provider');
  return useMemo(() => ({ success: (s: string) => c.push('success', s), error: (s: string) => c.push('error', s), info: (s: string) => c.push('info', s) }), [c]);
}

// ---------------------------------------------------------------- errors
export function useErrorText() {
  const { tx, t } = useI18n();
  return useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.code === 'NETWORK') return t('err.network');
        return tx(`err.${err.code}`, undefined, err.message);
      }
      return err instanceof Error ? err.message : t('common.error');
    },
    [tx, t],
  );
}

export function useIssueText() {
  const { t } = useI18n();
  return useCallback(
    (i: Pick<ApiIssue, 'code' | 'message' | 'minimum' | 'maximum'> & { type?: string; received?: string; validation?: string }): string => {
      const custom: Record<string, TKey> = {
        invalid_date: 'v.date',
        invalid_time: 'v.time',
        invalid_phone: 'v.phone',
        positive: 'v.positive',
        non_zero: 'v.nonZero',
        hours_order: 'v.hoursOrder',
        time_order: 'v.timeOrder',
        end_before_start: 'v.endBeforeStart',
        range_too_long: 'v.rangeTooLong',
        single_day: 'v.singleDay',
        required: 'v.required',
      };
      if (custom[i.message]) return t(custom[i.message]);
      switch (i.code) {
        case 'too_small':
          if (i.type === 'array') return t('v.atLeastOne');
          if (i.type === 'string' || i.type === undefined) return i.minimum === 1 ? t('v.required') : t('v.tooShort', { n: i.minimum ?? '' });
          return t('v.min', { n: i.minimum ?? '' });
        case 'too_big':
          return i.type === 'string' ? t('v.tooLong', { n: i.maximum ?? '' }) : t('v.max', { n: i.maximum ?? '' });
        case 'invalid_string':
          return i.validation === 'email' || /email/i.test(i.message) ? t('v.email') : t('v.invalid');
        case 'invalid_type':
          return i.received === 'undefined' || i.received === 'null' || /required/i.test(i.message) ? t('v.required') : t('v.invalid');
        default:
          return t('v.invalid');
      }
    },
    [t],
  );
}

// ---------------------------------------------------------------- forms
export type FieldErrors = Record<string, string>;

export function useForm<T extends Record<string, any>>(initial: T, schema?: ZodTypeAny) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const issueText = useIssueText();
  const dirty = JSON.stringify(values) !== baseline;

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key as string]) return e;
      const n = { ...e };
      delete n[key as string];
      return n;
    });
  }, []);

  const mapIssues = useCallback(
    (issues: { path: string | (string | number)[]; code: string; message: string; minimum?: number | bigint; maximum?: number | bigint; type?: string }[]) => {
      const out: FieldErrors = {};
      for (const i of issues) {
        const p = Array.isArray(i.path) ? i.path.join('.') : i.path;
        if (!out[p]) out[p] = issueText({ ...i, minimum: i.minimum === undefined ? undefined : Number(i.minimum), maximum: i.maximum === undefined ? undefined : Number(i.maximum) });
      }
      return out;
    },
    [issueText],
  );

  const validate = useCallback((): z.output<ZodTypeAny> | null => {
    if (!schema) return values;
    const r = schema.safeParse(values);
    if (r.success) {
      setErrors({});
      return r.data;
    }
    setErrors(mapIssues(r.error.issues as never));
    return null;
  }, [schema, values, mapIssues]);

  const applyServerError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED' && err.issues.length) {
        setErrors(mapIssues(err.issues));
        return true;
      }
      return false;
    },
    [mapIssues],
  );

  const reset = useCallback((next: T) => {
    setValues(next);
    setErrors({});
    setBaseline(JSON.stringify(next));
  }, []);

  const markClean = useCallback(() => setBaseline(JSON.stringify(values)), [values]);

  return { values, setValues, set, errors, setErrors, validate, applyServerError, dirty, reset, markClean };
}

// ---------------------------------------------------------------- mutations
export function useAction<V, R = unknown>(
  fn: (vars: V) => Promise<R>,
  opts: { success?: string | ((r: R) => string | null); onSuccess?: (r: R, v: V) => void; onError?: (e: unknown) => boolean | void; invalidate?: boolean } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  const errorText = useErrorText();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.invalidate !== false) qc.invalidateQueries();
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      const handled = opts.onError?.(e);
      if (!handled) toast.error(errorText(e));
    },
  });
}

// ---------------------------------------------------------------- misc
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Read/write filters in the URL so dashboard links and the back button work. */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => {
    const out = { ...defaults } as T;
    for (const k of Object.keys(defaults)) {
      const v = params.get(k);
      if (v !== null) (out as Record<string, string>)[k] = v;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const update = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '' || v === (defaults as Record<string, string>)[k]) next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams],
  );
  return [state, update] as const;
}

export function useOnClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [ref, handler, active]);
}

export function initials(name: string): string {
  return name
    .replace(/^Dr\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
