// Applies the signed-in user's appearance (theme, density, text size) and the accent colour: the
// user's own choice, else the clinic brand colour, else the built-in purple. The last applied look is
// remembered on this device so the sign-in page and the first paint match.
import type { Preferences } from '@shared/schemas';

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', accent: null, density: 'comfortable', textSize: 'normal', startPage: null };

export const ACCENT_PRESETS: { id: string; hex: string }[] = [
  { id: 'violet', hex: '#6b5b95' },
  { id: 'rose', hex: '#a8466a' },
  { id: 'teal', hex: '#2f7f80' },
  { id: 'blue', hex: '#2f63a8' },
  { id: 'emerald', hex: '#2e7553' },
  { id: 'amber', hex: '#a0601a' },
  { id: 'gold', hex: '#8c7230' },
  { id: 'slate', hex: '#4b5567' },
];
export const BUILT_IN_ACCENT = ACCENT_PRESETS[0].hex;
const STORAGE_KEY = 'luma.appearance';

type RGB = [number, number, number];
const toRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const toHex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: string, b: string, weightOfA: number) => {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex(x.map((v, i) => v * weightOfA + y[i] * (1 - weightOfA)) as RGB);
};
const luminance = (hex: string) => {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** CSS variables for an accent colour, keeping white text on buttons readable in both themes. */
export function accentVars(hex: string, dark: boolean): Record<string, string> {
  let accent = hex;
  // Light accents are darkened until white button text has enough contrast (≈4.5:1).
  for (let i = 0; i < 8 && (1.05 / (luminance(accent) + 0.05) < 4.5); i++) accent = mix(accent, '#000000', 0.88);
  if (dark) {
    return {
      '--accent': accent,
      '--accent-hover': mix(accent, '#ffffff', 0.85),
      '--accent-soft': mix(accent, '#1c1921', 0.22),
      '--accent-soft-2': mix(accent, '#1c1921', 0.38),
      '--accent-text': mix(hex, '#ffffff', 0.45),
      '--focus': mix(hex, '#ffffff', 0.6),
    };
  }
  return {
    '--accent': accent,
    '--accent-hover': mix(accent, '#000000', 0.85),
    '--accent-soft': mix(accent, '#ffffff', 0.1),
    '--accent-soft-2': mix(accent, '#ffffff', 0.2),
    '--accent-text': mix(accent, '#000000', 0.78),
    '--focus': mix(accent, '#ffffff', 0.85),
  };
}

const darkQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function resolvedTheme(p: Pick<Preferences, 'theme'>): 'light' | 'dark' {
  if (p.theme === 'light' || p.theme === 'dark') return p.theme;
  return darkQuery()?.matches ? 'dark' : 'light';
}

export function applyAppearance(p: Preferences, clinicAccent: string | null): void {
  const root = document.documentElement;
  const theme = resolvedTheme(p);
  root.dataset.theme = theme;
  root.dataset.density = p.density;
  root.dataset.text = p.textSize;
  const accent = isHex(p.accent) ? p.accent : isHex(clinicAccent) ? clinicAccent : BUILT_IN_ACCENT;
  for (const [k, v] of Object.entries(accentVars(accent, theme === 'dark'))) root.style.setProperty(k, v);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p, clinicAccent }));
  } catch {
    /* appearance not remembered on this device */
  }
}

/** Re-apply the last look used on this device (before sign-in / first paint). */
export function applyStoredAppearance(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return applyAppearance(DEFAULT_PREFERENCES, null);
    const { p, clinicAccent } = JSON.parse(raw) as { p: Preferences; clinicAccent: string | null };
    applyAppearance({ ...DEFAULT_PREFERENCES, ...p }, clinicAccent);
  } catch {
    applyAppearance(DEFAULT_PREFERENCES, null);
  }
}

/** Follow the operating system when the theme is "system". Returns an unsubscribe function. */
export function watchSystemTheme(onChange: () => void): () => void {
  const q = darkQuery();
  if (!q) return () => undefined;
  q.addEventListener('change', onChange);
  return () => q.removeEventListener('change', onChange);
}
