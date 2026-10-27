// Ctrl/⌘ + K: jump to any page, start a common task or open a patient without leaving the keyboard.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarPlus, CreditCard, Hourglass, Languages, Moon, Palette, Search, Sun, UserPlus, UserRound, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { resolvedTheme } from '@/lib/theme';
import { useActions } from './actions';
import type { Permission } from '@shared/permissions';
import type { TKey } from '@/i18n/en';

export interface PaletteNav {
  to: string;
  label: TKey;
  icon: LucideIcon;
  perms: Permission[];
}

interface Entry {
  id: string;
  group: 'actions' | 'pages' | 'patients';
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

export function CommandPalette({ open, onClose, nav, onAppearance }: { open: boolean; onClose: () => void; nav: PaletteNav[]; onAppearance: () => void }) {
  const { t, lang, setLang } = useI18n();
  const { can, canAny, preferences, savePreferences } = useSession();
  const actions = useActions();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dq = useDebounced(q, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  const patients = useQuery({
    queryKey: ['patient-search', dq],
    queryFn: () => api.get<{ items: { id: number; fullName: string; phone: string; code: string }[] }>('/patients/search', { q: dq }),
    enabled: open && can('patients.view') && dq.trim().length >= 2,
  });

  const entries = useMemo<Entry[]>(() => {
    const dark = resolvedTheme(preferences) === 'dark';
    const all: (Entry & { show: boolean })[] = [
      { id: 'book', group: 'actions', label: t('dash.book'), icon: CalendarPlus, show: can('appointments.manage'), run: () => actions.book() },
      { id: 'patient', group: 'actions', label: t('pat.new'), icon: UserPlus, show: can('patients.edit'), run: () => actions.newPatient((id) => navigate(`/patients/${id}`)) },
      { id: 'collect', group: 'actions', label: t('dash.collect'), icon: CreditCard, show: can('payments.record'), run: () => actions.collectPayment() },
      { id: 'waitlist', group: 'actions', label: t('wl.add'), icon: Hourglass, show: can('appointments.manage'), run: () => actions.addToWaitlist() },
      { id: 'theme', group: 'actions', label: dark ? t('cmd.lightMode') : t('cmd.darkMode'), icon: dark ? Sun : Moon, show: true, run: () => void savePreferences({ theme: dark ? 'light' : 'dark' }) },
      { id: 'appearance', group: 'actions', label: t('ap.title'), icon: Palette, show: true, run: onAppearance },
      { id: 'lang', group: 'actions', label: lang === 'en' ? 'التبديل إلى العربية' : 'Switch to English', icon: Languages, show: true, run: () => setLang(lang === 'en' ? 'ar' : 'en') },
      ...nav.map((n) => ({ id: `nav:${n.to}`, group: 'pages' as const, label: t(n.label), icon: n.icon, show: !n.perms.length || canAny(...n.perms), run: () => navigate(n.to) })),
    ];
    const needle = q.trim().toLowerCase();
    const matched = all.filter((e) => e.show && (!needle || e.label.toLowerCase().includes(needle)));
    const people: Entry[] =
      needle.length >= 2
        ? (patients.data?.items ?? []).map((p) => ({ id: `p:${p.id}`, group: 'patients', label: p.fullName, hint: `${p.code} · ${p.phone}`, icon: UserRound, run: () => navigate(`/patients/${p.id}`) }))
        : [];
    return [...people, ...matched];
  }, [q, patients.data, nav, can, canAny, actions, navigate, t, lang, setLang, preferences, savePreferences, onAppearance]);

  useEffect(() => setActive((a) => Math.min(a, Math.max(0, entries.length - 1))), [entries.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const run = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    e.run();
  };
  let lastGroup = '';
  return createPortal(
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('cmd.title')}>
        <div className="palette-input">
          <Search size={18} aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={entries[active] ? `pal-${entries[active].id}` : undefined}
            placeholder={t('cmd.placeholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, entries.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(entries[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {!entries.length && <div className="menu-item muted">{t('top.noResults')}</div>}
          {entries.map((e, i) => {
            const header = e.group !== lastGroup ? <div className="palette-group">{t(`cmd.group.${e.group}` as TKey)}</div> : null;
            lastGroup = e.group;
            return (
              <div key={e.id}>
                {header}
                <button id={`pal-${e.id}`} role="option" aria-selected={i === active} data-active={i === active} className="menu-item" onMouseEnter={() => setActive(i)} onClick={() => run(e)}>
                  <e.icon size={16} aria-hidden />
                  <span className="grow">{e.label}</span>
                  {e.hint && <span className="xs muted ltr">{e.hint}</span>}
                  {i === active && <ArrowRight size={14} className="flip-rtl muted" aria-hidden />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {t('cmd.move')}
          </span>
          <span>
            <kbd>Enter</kbd> {t('cmd.open')}
          </span>
          <span>
            <kbd>Esc</kbd> {t('common.close')}
          </span>
          <span className="grow" />
          <span>
            <kbd>/</kbd> {t('cmd.searchPatients')}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
