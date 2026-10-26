import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  BarChart3,
  CalendarDays,
  Camera,
  ChevronsLeft,
  ChevronsRight,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Package,
  Search,
  Settings,
  Sparkles,
  UserRound,
  Users,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';
import { initials, useDebounced, useOnClickOutside } from '@/lib/hooks';
import { Button } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { ActionsProvider } from './actions';
import type { Notification } from '@/lib/types';
import type { Permission } from '@shared/permissions';
import type { TKey } from '@/i18n/en';

interface NavItem {
  to: string;
  label: TKey;
  icon: typeof LayoutDashboard;
  perms: Permission[];
  section?: 'clinic' | 'business';
}

const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', icon: LayoutDashboard, perms: ['dashboard.view'], section: 'clinic' },
  { to: '/appointments', label: 'nav.appointments', icon: CalendarDays, perms: ['appointments.view'], section: 'clinic' },
  { to: '/patients', label: 'nav.patients', icon: Users, perms: ['patients.view'], section: 'clinic' },
  { to: '/photos', label: 'nav.photos', icon: Camera, perms: ['photos.view'], section: 'clinic' },
  { to: '/follow-up', label: 'nav.followup', icon: MessageCircle, perms: ['followup.view'], section: 'clinic' },
  { to: '/services', label: 'nav.services', icon: Sparkles, perms: ['packages.view', 'settings.manage'], section: 'business' },
  { to: '/billing', label: 'nav.billing', icon: CreditCard, perms: ['billing.view'], section: 'business' },
  { to: '/inventory', label: 'nav.inventory', icon: Package, perms: ['inventory.view'], section: 'business' },
  { to: '/reports', label: 'nav.reports', icon: BarChart3, perms: ['reports.financial', 'reports.operational'], section: 'business' },
  { to: '/settings', label: 'nav.settings', icon: Settings, perms: ['settings.manage', 'staff.manage', 'permissions.manage', 'audit.view'], section: 'business' },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('luma.sidebar') === 'collapsed';
  } catch {
    return false;
  }
}

export function AppShell() {
  const { me } = useSession();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('luma.sidebar', c ? 'open' : 'collapsed');
      } catch {
        /* preference not persisted */
      }
      return !c;
    });
  };
  return (
    <ActionsProvider>
      {me.demoMode && <DemoBanner />}
      <div className={`shell ${me.demoMode ? '' : 'no-banner'}`}>
        <a className="skip-link" href="#main">
          {t('app.skip')}
        </a>
        <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onToggle={toggle} />
        <div className={`backdrop ${mobileOpen ? 'open' : ''}`} onClick={() => setMobileOpen(false)} />
        <div className="main">
          <Topbar onMenu={() => setMobileOpen(true)} />
          <main id="main" className="content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </ActionsProvider>
  );
}

function DemoBanner() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="demo-banner" role="note">
        <span className="tag">{t('demo.tag')}</span>
        <span>{t('demo.banner')}</span>
        <span className="detail">· {t('demo.detail')}</span>
        <button onClick={() => setOpen(true)}>{t('demo.what')}</button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('demo.dialogTitle')} footer={<Button onClick={() => setOpen(false)}>{t('common.close')}</Button>}>
        <div className="stack">
          <p>{t('demo.dialogIntro')}</p>
          <ul className="stack tight" style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>{t('demo.i.messaging')}</li>
            <li>{t('demo.i.payments')}</li>
            <li>{t('demo.i.storage')}</li>
            <li>{t('demo.i.auth')}</li>
          </ul>
        </div>
      </Dialog>
    </>
  );
}

function Sidebar({ collapsed, mobileOpen, onToggle }: { collapsed: boolean; mobileOpen: boolean; onToggle: () => void }) {
  const { t, pick } = useI18n();
  const { canAny, me } = useSession();
  const items = NAV.filter((n) => canAny(...n.perms));
  const sections: ('clinic' | 'business')[] = ['clinic', 'business'];
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`} aria-label={t('nav.main')}>
      <div className="brand">
        <span className={`brand-mark ${me.settings.hasLogo ? 'has-logo' : ''}`} aria-hidden>
          {me.settings.hasLogo && <img src="/api/settings/logo" alt="" />}
        </span>
        <span className="brand-name">{pick(me.settings.clinicName, me.settings.clinicNameAr)}</span>
      </div>
      <nav className="nav">
        {sections.map((s) => {
          const list = items.filter((i) => i.section === s);
          if (!list.length) return null;
          return (
            <div key={s} className="stack tight" style={{ gap: 2 }}>
              <div className="nav-section">{t(s === 'clinic' ? 'nav.sectionClinic' : 'nav.sectionBusiness')}</div>
              {list.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'} title={collapsed ? t(n.label) : undefined}>
                  <n.icon size={18} aria-hidden />
                  <span className="nav-label">{t(n.label)}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-foot collapse-toggle">
        <Button variant="ghost" size="sm" block onClick={onToggle} aria-label={collapsed ? t('nav.expand') : t('nav.collapse')} icon={collapsed ? <ChevronsRight size={16} className="flip-rtl" /> : <ChevronsLeft size={16} className="flip-rtl" />} />
      </div>
    </aside>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const { t, lang, setLang } = useI18n();
  return (
    <header className="topbar">
      <Button variant="ghost" className="mobile-only" icon={<Menu size={20} />} aria-label={t('nav.openMenu')} onClick={onMenu} />
      <GlobalSearch />
      <div className="topbar-actions">
        <Notifications />
        <Button variant="ghost" className="lang-switch" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} aria-label={t('top.languageLabel')} lang={lang === 'en' ? 'ar' : 'en'}>
          {lang === 'en' ? 'ع' : 'EN'}
        </Button>
        <UserMenu />
      </div>
    </header>
  );
}

function GlobalSearch() {
  const { t } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q, 200);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useOnClickOutside(ref, () => setOpen(false), open);
  const { data } = useQuery({
    queryKey: ['patient-search', dq],
    queryFn: () => api.get<{ items: { id: number; fullName: string; phone: string; code: string }[] }>('/patients/search', { q: dq }),
    enabled: can('patients.view') && dq.trim().length >= 2,
  });
  const items = data?.items ?? [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const go = useCallback(
    (id: number) => {
      setOpen(false);
      setQ('');
      navigate(`/patients/${id}`);
    },
    [navigate],
  );
  if (!can('patients.view')) return <div className="grow" />;
  return (
    <div className="global-search" ref={ref}>
      <div className="input-group">
        <Search size={16} aria-hidden />
        <input
          ref={inputRef}
          className="input"
          type="search"
          role="combobox"
          aria-expanded={open && items.length > 0}
          aria-controls="global-search-list"
          aria-label={t('top.searchShort')}
          placeholder={t('top.search')}
          value={q}
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
              go(items[active].id);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
        <span className="input-addon hide-mobile">
          <kbd>/</kbd>
        </span>
      </div>
      {open && dq.trim().length >= 2 && (
        <div className="popover combobox-list" id="global-search-list" role="listbox">
          {!items.length && <div className="menu-item muted">{t('top.noResults')}</div>}
          {items.map((p, i) => (
            <button key={p.id} className="menu-item" role="option" aria-selected={i === active} data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(p.id)}>
              <UserRound size={16} aria-hidden />
              <span className="grow">
                {p.fullName} <span className="xs muted">{p.code}</span>
              </span>
              <span className="xs muted ltr">{p.phone}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { t, tx } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useOnClickOutside(ref, () => setOpen(false), open);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ items: Notification[] }>('/notifications'), refetchInterval: 60_000 });
  const items = data?.items ?? [];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button variant="ghost" icon={<Bell size={19} />} aria-label={`${t('top.notifications')} (${items.length})`} aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {items.length > 0 && (
        <span className="icon-badge" aria-hidden>
          {items.length}
        </span>
      )}
      {open && (
        <div className="popover" style={{ insetInlineEnd: 0, top: 'calc(100% + 6px)', width: 340 }} role="dialog" aria-label={t('top.notifications')}>
          <div className="panel-head" style={{ minHeight: 44 }}>
            <h3 style={{ fontSize: 'var(--fs-md)' }}>{t('top.notifications')}</h3>
          </div>
          {!items.length && <div className="empty small">{t('top.noNotifications')}</div>}
          {items.map((n) => (
            <button
              key={n.key}
              className="menu-item"
              onClick={() => {
                setOpen(false);
                navigate(n.link);
              }}
            >
              <span className="color-dot" style={{ background: n.severity === 'high' ? 'var(--danger)' : n.severity === 'medium' ? 'var(--warning)' : 'var(--info)' }} aria-hidden />
              <span className="grow">{tx(`notif.${n.kind}`, n.params)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useSession();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setOpen(false), open);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>
          {initials(me.user.name)}
        </span>
        <span className="user-meta">
          <span className="strong small">{me.user.name}</span>
          <span className="xs muted">{t(`role.${me.user.role}` as TKey)}</span>
        </span>
      </button>
      {open && (
        <div className="popover" role="menu" style={{ insetInlineEnd: 0, top: 'calc(100% + 6px)' }}>
          <div style={{ padding: '10px 14px' }} className="small">
            <div className="muted xs">{t('top.signedInAs')}</div>
            <div className="strong">{me.user.name}</div>
            <div className="muted xs ltr">{me.user.email}</div>
          </div>
          <hr className="divider" style={{ margin: 0 }} />
          <button className="menu-item" role="menuitem" onClick={() => logout()}>
            <LogOut size={16} aria-hidden /> {t('top.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
