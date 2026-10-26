import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Inbox, Lock, RefreshCw } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { TKey } from '@/i18n/en';
import type { AppointmentStatus } from '@shared/domain';
import { toMajor, toMinor } from '@shared/money';

// ---------------------------------------------------------------- buttons
type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'soft';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: 'md' | 'sm' | 'xs';
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, loading, block, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', !children && 'btn-icon', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------- fields
interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}
export function Field({ label, hint, error, required, children, className = '' }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${className}`}>
      {label && (
        <label className="field-label" htmlFor={id}>
          {label}
          {required && (
            <span className="req" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children(id, describedBy)}
      {hint && !error && (
        <span className="field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={errId} role="alert">
          <AlertCircle size={12} aria-hidden /> {error}
        </span>
      )}
    </div>
  );
}

type Common = { label?: ReactNode; hint?: ReactNode; error?: string; required?: boolean; className?: string };

export function TextField({ label, hint, error, required, className, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id, d) => <input id={id} className="input" aria-invalid={!!error} aria-describedby={d} aria-required={required} {...rest} />}
    </Field>
  );
}

export function TextArea({ label, hint, error, required, className, ...rest }: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id, d) => <textarea id={id} className="textarea" aria-invalid={!!error} aria-describedby={d} aria-required={required} {...rest} />}
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  className,
  children,
  placeholder,
  ...rest
}: Common & SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string }) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id, d) => (
        <select id={id} className="select" aria-invalid={!!error} aria-describedby={d} aria-required={required} {...rest}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {children}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  return (
    <div className="stack tight" style={{ gap: 2 }}>
      <label className="check">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <span className="field-hint" style={{ paddingInlineStart: 24 }}>{hint}</span>}
    </div>
  );
}

/** Money input in major units (e.g. EGP) while the value stays in minor units. */
export function MoneyField({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  currency,
  disabled,
  allowNegative,
  className,
}: Common & { value: number | null; onChange: (minor: number | null) => void; currency: string; disabled?: boolean; allowNegative?: boolean }) {
  const [text, setText] = useState(value === null || Number.isNaN(value) ? '' : String(toMajor(value)));
  useEffect(() => {
    // Follow external changes (e.g. "pay full balance") without fighting the user's typing.
    const parsed = text.trim() ? toMinor(text) : null;
    if (value === null ? parsed !== null : !Number.isNaN(value) && parsed !== value) setText(value === null ? '' : String(toMajor(value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(id, d) => (
        <div className="input-group">
          <input
            id={id}
            className="input num"
            style={{ paddingInlineEnd: 48 }}
            inputMode="decimal"
            aria-invalid={!!error}
            aria-describedby={d}
            aria-required={required}
            disabled={disabled}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const raw = e.target.value.trim();
              if (!raw) return onChange(null);
              const n = toMinor(raw);
              onChange(Number.isFinite(n) && (allowNegative || n >= 0) ? n : NaN);
            }}
          />
          <span className="input-addon">{currency}</span>
        </div>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------- display
export function Badge({ tone = 'neutral', children, dot, title }: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'outline'; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`badge ${tone !== 'neutral' ? `badge-${tone}` : ''} ${dot ? 'badge-dot' : ''}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  booked: 'neutral',
  confirmed: 'accent',
  arrived: 'warning',
  in_treatment: 'info',
  completed: 'success',
  cancelled: 'danger',
  no_show: 'danger',
};
export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const { t } = useI18n();
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {t(`status.${status}` as TKey)}
    </Badge>
  );
}

const PAY_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'> = {
  package: 'accent',
  paid: 'success',
  deposit_paid: 'info',
  partially_paid: 'warning',
  unpaid: 'neutral',
  deposit_due: 'warning',
  void: 'neutral',
};
export function PayBadge({ state }: { state: string }) {
  const { tx } = useI18n();
  return <Badge tone={PAY_TONE[state] ?? 'neutral'}>{tx(`pay.${state}`)}</Badge>;
}

export function Panel({ title, actions, children, flush, className = '', footer, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; footer?: ReactNode; id?: string }) {
  return (
    <section className={`panel ${className}`} aria-labelledby={id && title ? `${id}-title` : undefined}>
      {(title || actions) && (
        <div className="panel-head">
          {typeof title === 'string' ? <h2 id={id ? `${id}-title` : undefined}>{title}</h2> : title}
          {actions && <div className="toolbar">{actions}</div>}
        </div>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
      {footer && <div className="panel-foot">{footer}</div>}
    </section>
  );
}

export function Callout({ tone = 'info', children, title }: { tone?: 'info' | 'warning' | 'danger' | 'success' | 'neutral'; children: ReactNode; title?: ReactNode }) {
  const Icon = tone === 'danger' ? AlertCircle : tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`callout callout-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={16} aria-hidden />
      <div className="grow">
        {title && <div className="strong">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, icon, action }: { title: ReactNode; hint?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={32} aria-hidden />}
      <h3>{title}</h3>
      {hint && <p className="small">{hint}</p>}
      {action}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="loading-block" role="status">
      <span className="spinner" aria-hidden /> {label ?? t('common.loading')}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  const { t, tx } = useI18n();
  const code = (error as { code?: string })?.code;
  const message = code ? tx(`err.${code}`, undefined, (error as Error).message) : t('common.errorBody');
  return (
    <div className="empty" role="alert">
      <AlertCircle size={32} aria-hidden style={{ color: 'var(--danger)' }} />
      <h3>{t('common.error')}</h3>
      <p className="small">{message}</p>
      {onRetry && (
        <Button size="sm" icon={<RefreshCw size={14} />} onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export function Restricted({ perm, clinical }: { perm?: string; clinical?: boolean }) {
  const { t, tx } = useI18n();
  return (
    <div className="restricted">
      <Lock size={20} aria-hidden />
      <div className="stack tight">
        <strong>{t('common.restricted')}</strong>
        <span className="small">{t('common.restrictedBody', { perm: perm ? tx(`perm.${perm}`, undefined, perm) : '—' })}</span>
        {clinical && <span className="small muted">{t('common.restrictedClinical')}</span>}
      </div>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>{t('common.showing', { from, to, total })}</span>
      <div className="row">
        <Button size="sm" variant="ghost" icon={<ChevronLeft size={16} className="flip-rtl" />} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.prev')} />
        <span>{t('common.page', { page, pages })}</span>
        <Button size="sm" variant="ghost" icon={<ChevronRight size={16} className="flip-rtl" />} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('common.next')} />
      </div>
    </nav>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode; locked?: boolean; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={value === tab.id}
          aria-controls={`panel-${tab.id}`}
          className="tab"
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.id === tab.id);
            const rtl = document.documentElement.dir === 'rtl';
            if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) onChange(tabs[(i + 1) % tabs.length].id);
            if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) onChange(tabs[(i - 1 + tabs.length) % tabs.length].id);
          }}
        >
          {tab.label}
          {tab.locked && <Lock size={12} className="lock" aria-label="restricted" />}
          {tab.count !== undefined && <span className="chip-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ items, stacked }: { items: [ReactNode, ReactNode][]; stacked?: boolean }) {
  return (
    <dl className={`kv ${stacked ? 'kv-stacked' : ''}`}>
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Progress({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Phone({ value }: { value: string | null | undefined }) {
  if (!value) return <>—</>;
  return (
    <a href={`tel:${value.replace(/\s/g, '')}`} className="ltr nowrap">
      {value}
    </a>
  );
}
