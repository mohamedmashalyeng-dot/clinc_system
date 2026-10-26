import { useEffect, useId, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search, UserRound, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebounced, useOnClickOutside } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useI18n } from '@/i18n';
import { Button, Field, Segmented } from './ui';
import { ConfirmDialog } from './overlays';
import { addDays, startOfWeek } from '@shared/time';

export interface PatientRef {
  id: number;
  fullName: string;
  phone?: string;
  code?: string;
}

export function PatientPicker({ value, onChange, label, error, required, disabled }: { value: PatientRef | null; onChange: (p: PatientRef | null) => void; label?: string; error?: string; required?: boolean; disabled?: boolean }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q, 250);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  useOnClickOutside(wrap, () => setOpen(false), open);
  const { data, isFetching } = useQuery({
    queryKey: ['patient-search', dq],
    queryFn: () => api.get<{ items: PatientRef[] }>('/patients/search', { q: dq }),
    enabled: dq.trim().length >= 2,
  });
  const items = data?.items ?? [];
  if (value) {
    return (
      <Field label={label} required={required} error={error}>
        {(id) => (
          <div className="row subtle-box" id={id} style={{ padding: '6px 10px' }}>
            <UserRound size={16} aria-hidden />
            <div className="grow">
              <div className="strong">{value.fullName}</div>
              {(value.phone || value.code) && <div className="xs muted ltr">{[value.code, value.phone].filter(Boolean).join(' · ')}</div>}
            </div>
            {!disabled && <Button size="xs" variant="ghost" icon={<X size={14} />} aria-label={t('common.clear')} onClick={() => onChange(null)} />}
          </div>
        )}
      </Field>
    );
  }
  return (
    <Field label={label} required={required} error={error}>
      {(id, d) => (
        <div ref={wrap} style={{ position: 'relative' }}>
          <div className="input-group">
            <Search size={16} aria-hidden />
            <input
              id={id}
              className="input"
              role="combobox"
              aria-expanded={open && items.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-invalid={!!error}
              aria-describedby={d}
              placeholder={t('top.search')}
              value={q}
              disabled={disabled}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
                setActive(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, items.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter' && items[active]) {
                  e.preventDefault();
                  onChange(items[active]);
                  setQ('');
                  setOpen(false);
                }
              }}
            />
          </div>
          {open && dq.trim().length >= 2 && (
            <div className="popover combobox-list" style={{ top: 'calc(100% + 4px)', insetInlineStart: 0, width: '100%' }} id={listId} role="listbox">
              {isFetching && !items.length && <div className="menu-item muted">{t('common.loading')}</div>}
              {!isFetching && !items.length && <div className="menu-item muted">{t('top.noResults')}</div>}
              {items.map((p, i) => (
                <button
                  type="button"
                  key={p.id}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  className="menu-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    onChange(p);
                    setQ('');
                    setOpen(false);
                  }}
                >
                  <UserRound size={15} aria-hidden />
                  <span className="grow">{p.fullName}</span>
                  <span className="xs muted ltr">{p.phone}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

export type RangePreset = 'today' | 'week' | 'month' | 'last_month' | 'last30' | 'custom';

export function presetRange(p: RangePreset, today: string): { from: string; to: string } {
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'week': {
      const s = startOfWeek(today);
      return { from: s, to: addDays(s, 6) };
    }
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: addDays(`${nextMonth(today)}-01`, -1) };
    case 'last_month': {
      const first = `${prevMonth(today)}-01`;
      return { from: first, to: addDays(`${today.slice(0, 7)}-01`, -1) };
    }
    case 'last30':
      return { from: addDays(today, -29), to: today };
    default:
      return { from: today, to: today };
  }
}
function nextMonth(d: string) {
  const [y, m] = d.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function prevMonth(d: string) {
  const [y, m] = d.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function DateRangeControl({ from, to, onChange, presets = ['today', 'week', 'month', 'last_month', 'custom'] }: { from: string; to: string; onChange: (r: { from: string; to: string }) => void; presets?: RangePreset[] }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const today = fmt.today();
  const current = (presets.find((p) => p !== 'custom' && presetRange(p, today).from === from && presetRange(p, today).to === to) ?? 'custom') as RangePreset;
  const [showCustom, setShowCustom] = useState(current === 'custom');
  useEffect(() => {
    if (current !== 'custom') setShowCustom(false);
  }, [current]);
  const labels: Record<RangePreset, string> = {
    today: t('common.today'),
    week: t('common.thisWeek'),
    month: t('common.thisMonth'),
    last_month: t('common.lastMonth'),
    last30: t('common.last30'),
    custom: t('common.custom'),
  };
  return (
    <div className="row wrap">
      <Segmented
        label={t('common.range')}
        value={showCustom ? 'custom' : current}
        options={presets.map((p) => ({ id: p, label: labels[p] }))}
        onChange={(p) => {
          if (p === 'custom') setShowCustom(true);
          else onChange(presetRange(p, today));
        }}
      />
      {showCustom && (
        <div className="row">
          <input type="date" className="input input-sm" aria-label={t('common.from')} value={from} max={to} onChange={(e) => e.target.value && onChange({ from: e.target.value, to: e.target.value > to ? e.target.value : to })} />
          <span className="muted">–</span>
          <input type="date" className="input input-sm" aria-label={t('common.to')} value={to} min={from} onChange={(e) => e.target.value && onChange({ from, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}

/** Blocks in-app navigation and tab close while there are unsaved changes. */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const { t } = useI18n();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!when) return;
    const fn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, [when]);
  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title={t('common.unsavedTitle')}
      body={t('common.unsavedBody')}
      confirmLabel={t('common.discard')}
      cancelLabel={t('common.keepEditing')}
      danger
      onCancel={() => blocker.reset?.()}
      onConfirm={() => blocker.proceed?.()}
    />
  );
}
