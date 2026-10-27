import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Me, Reference } from './types';
import type { Permission } from '@shared/permissions';
import { hasStoredLanguage, useI18n } from '@/i18n';
import { applyAppearance, watchSystemTheme } from './theme';
import type { Preferences } from '@shared/schemas';

interface Session {
  me: Me;
  can: (p: Permission) => boolean;
  canAll: (...p: Permission[]) => boolean;
  canAny: (...p: Permission[]) => boolean;
  logout: () => Promise<void>;
  preferences: Preferences;
  /** Saves to the user's account (follows them to other devices) and applies at once. */
  savePreferences: (patch: Partial<Preferences>) => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useMeQuery() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me'), retry: false, staleTime: 5 * 60_000 });
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const { setLang } = useI18n();
  const perms = useMemo(() => new Set(me.permissions), [me.permissions]);
  const [preferences, setPreferences] = useState<Preferences>(me.preferences);
  useEffect(() => setPreferences(me.preferences), [me.preferences]);
  const brand = me.settings.brandColor ?? null;
  useEffect(() => {
    const apply = () => applyAppearance(preferences, brand);
    apply();
    return preferences.theme === 'system' ? watchSystemTheme(apply) : undefined;
  }, [preferences, brand]);
  const savePreferences = useCallback(
    async (patch: Partial<Preferences>) => {
      setPreferences((p) => ({ ...p, ...patch }));
      const r = await api.put<{ preferences: Preferences }>('/auth/preferences', patch);
      qc.setQueryData<Me | null>(['me'], (m) => (m ? { ...m, preferences: r.preferences } : m));
    },
    [qc],
  );

  useEffect(() => {
    if (!hasStoredLanguage()) setLang(me.settings.defaultLanguage);
  }, [me.settings.defaultLanguage, setLang]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      qc.clear();
      qc.setQueryData(['me'], null);
      window.location.assign('/');
    }
  }, [qc]);

  const value = useMemo<Session>(
    () => ({
      me,
      can: (p) => perms.has(p),
      canAll: (...p) => p.every((x) => perms.has(x)),
      canAny: (...p) => p.some((x) => perms.has(x)),
      logout,
      preferences,
      savePreferences,
    }),
    [me, perms, logout, preferences, savePreferences],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside provider');
  return c;
}

export function useReference() {
  return useQuery({ queryKey: ['reference'], queryFn: () => api.get<Reference>('/reference'), staleTime: 5 * 60_000 });
}

/** Lookup helpers over reference data with localized names. */
export function useRef_() {
  const { data } = useReference();
  const { pick } = useI18n();
  return useMemo(() => {
    const services = new Map(data?.services.map((s) => [s.id, s]) ?? []);
    const practitioners = new Map(data?.practitioners.map((p) => [p.id, p]) ?? []);
    const rooms = new Map(data?.rooms.map((r) => [r.id, r]) ?? []);
    const devices = new Map(data?.devices.map((d) => [d.id, d]) ?? []);
    const categories = new Map(data?.categories.map((c) => [c.id, c]) ?? []);
    const qualifications = new Map(data?.qualifications.map((q) => [q.code, q]) ?? []);
    return {
      data,
      ready: !!data,
      services,
      practitioners,
      rooms,
      devices,
      categories,
      qualifications,
      serviceName: (id: number | null | undefined) => {
        const s = id ? services.get(id) : undefined;
        return s ? pick(s.nameEn, s.nameAr) : '—';
      },
      practitionerName: (id: number | null | undefined) => {
        const p = id ? practitioners.get(id) : undefined;
        return p ? pick(p.displayName, p.displayNameAr) : '—';
      },
      practitionerColor: (id: number | null | undefined) => (id ? practitioners.get(id)?.color : undefined) ?? '#8a8294',
      roomName: (id: number | null | undefined) => {
        const r = id ? rooms.get(id) : undefined;
        return r ? pick(r.name, r.nameAr) : '—';
      },
      deviceName: (id: number | null | undefined) => {
        const d = id ? devices.get(id) : undefined;
        return d ? pick(d.name, d.nameAr) : '—';
      },
      categoryName: (id: number | null | undefined) => {
        const c = id ? categories.get(id) : undefined;
        return c ? pick(c.nameEn, c.nameAr) : '—';
      },
      qualificationName: (code: string | null | undefined) => {
        const q = code ? qualifications.get(code) : undefined;
        return q ? pick(q.nameEn, q.nameAr) : code ?? '—';
      },
      userName: (id: number | null | undefined) => data?.users.find((u) => u.id === id)?.name ?? '—',
    };
  }, [data, pick]);
}
