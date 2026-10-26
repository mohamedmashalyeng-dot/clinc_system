import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type TKey } from './en';
import { ar } from './ar';

export type Lang = 'en' | 'ar';
type Params = Record<string, string | number | null | undefined>;

interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  locale: string;
  setLang: (l: Lang) => void;
  t: (key: TKey, params?: Params) => string;
  /** Translate a dynamic key, falling back to `fallback` when it is not in the dictionary. */
  tx: (key: string, params?: Params, fallback?: string) => string;
  /** Pick the localized field of a record with nameEn/nameAr style pairs. */
  pick: (en: string | null | undefined, ar: string | null | undefined) => string;
}

const dicts = { en, ar } as const;
const STORAGE_KEY = 'luma.lang';
const Ctx = createContext<I18n | null>(null);

function interpolate(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] === undefined || params[k] === null ? '' : String(params[k])));
}

function stored(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'ar' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => stored() ?? 'en');
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage unavailable: preference lasts for this tab only */
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const dict = dicts[lang] as Record<string, string>;
    const t = (key: TKey, params?: Params) => interpolate(dict[key] ?? (en as Record<string, string>)[key] ?? key, params);
    const tx = (key: string, params?: Params, fallback?: string) => {
      const s = dict[key] ?? (en as Record<string, string>)[key];
      return s ? interpolate(s, params) : fallback ?? key;
    };
    const pick = (e: string | null | undefined, a: string | null | undefined) => (lang === 'ar' ? a || e : e || a) ?? '';
    return { lang, dir, locale: lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', setLang, t, tx, pick };
  }, [lang, dir, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside provider');
  return c;
}

export function hasStoredLanguage(): boolean {
  return stored() !== null;
}

export type { TKey };
