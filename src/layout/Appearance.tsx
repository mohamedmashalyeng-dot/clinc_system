// Personal appearance and start page. Every change applies immediately and is saved to the user's
// account, so it follows them to any computer in the clinic.
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useSession } from '@/lib/session';
import { useToast } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { Button, Segmented, SelectField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { ACCENT_PRESETS, BUILT_IN_ACCENT, isHex } from '@/lib/theme';
import type { Permission } from '@shared/permissions';
import type { Preferences } from '@shared/schemas';
import type { TKey } from '@/i18n/en';

/** Pages a user can choose to open after signing in, with the permission each needs. */
export const START_PAGES: { path: string; label: TKey; perms: Permission[] }[] = [
  { path: '/my-day', label: 'nav.myDay', perms: [] },
  { path: '/dashboard', label: 'nav.dashboard', perms: ['dashboard.view'] },
  { path: '/appointments', label: 'nav.appointments', perms: ['appointments.view'] },
  { path: '/patients', label: 'nav.patients', perms: ['patients.view'] },
  { path: '/follow-up', label: 'nav.followup', perms: ['followup.view'] },
  { path: '/growth', label: 'nav.growth', perms: ['followup.view'] },
  { path: '/billing', label: 'nav.billing', perms: ['billing.view'] },
  { path: '/inventory', label: 'nav.inventory', perms: ['inventory.view'] },
  { path: '/reports', label: 'nav.reports', perms: ['reports.financial', 'reports.operational'] },
];

export function AppearanceDialog({ onClose }: { onClose: () => void }) {
  const { t, lang, setLang } = useI18n();
  const { me, canAny, preferences: p, savePreferences } = useSession();
  const toast = useToast();
  const brand = isHex(me.settings.brandColor) ? me.settings.brandColor : BUILT_IN_ACCENT;
  const save = (patch: Partial<Preferences>) => savePreferences(patch).catch(() => toast.error(t('common.error')));
  const themes: { id: Preferences['theme']; label: TKey; icon: typeof Sun }[] = [
    { id: 'system', label: 'ap.theme.system', icon: Monitor },
    { id: 'light', label: 'ap.theme.light', icon: Sun },
    { id: 'dark', label: 'ap.theme.dark', icon: Moon },
  ];
  return (
    <Dialog open onClose={onClose} title={t('ap.title')} subtitle={t('ap.sub')} footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
      <div className="stack loose">
        <fieldset className="stack tight">
          <legend className="field-label">{t('ap.theme')}</legend>
          <div className="theme-cards">
            {themes.map((x) => (
              <button key={x.id} type="button" className="theme-card" aria-pressed={p.theme === x.id} onClick={() => save({ theme: x.id })}>
                <span className={`theme-preview ${x.id}`} aria-hidden />
                <span className="row small" style={{ gap: 6 }}>
                  <x.icon size={14} aria-hidden /> {t(x.label)}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="stack tight">
          <legend className="field-label">{t('ap.accent')}</legend>
          <div className="swatches" role="group" aria-label={t('ap.accent')}>
            <button type="button" className="swatch-btn clinic" style={{ background: brand }} aria-pressed={!p.accent} onClick={() => save({ accent: null })}>
              {!p.accent && <Check size={14} aria-hidden />} {t('ap.clinicColor')}
            </button>
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="swatch-btn"
                style={{ background: c.hex }}
                aria-pressed={p.accent?.toLowerCase() === c.hex}
                aria-label={t(`ap.color.${c.id}` as TKey)}
                title={t(`ap.color.${c.id}` as TKey)}
                onClick={() => save({ accent: c.hex })}
              >
                {p.accent?.toLowerCase() === c.hex && <Check size={14} aria-hidden />}
              </button>
            ))}
            <label className="swatch-btn" style={{ background: 'conic-gradient(#e74c3c, #f1c40f, #2ecc71, #3498db, #9b59b6, #e74c3c)', position: 'relative' }} title={t('ap.custom')}>
              <input
                type="color"
                aria-label={t('ap.custom')}
                value={p.accent ?? brand}
                onChange={(e) => save({ accent: e.target.value })}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
              />
            </label>
          </div>
        </fieldset>

        <div className="form-grid">
          <div className="stack tight">
            <span className="field-label">{t('ap.density')}</span>
            <Segmented
              label={t('ap.density')}
              value={p.density}
              onChange={(density) => save({ density })}
              options={[
                { id: 'comfortable', label: t('ap.density.comfortable') },
                { id: 'compact', label: t('ap.density.compact') },
              ]}
            />
          </div>
          <div className="stack tight">
            <span className="field-label">{t('ap.textSize')}</span>
            <Segmented
              label={t('ap.textSize')}
              value={p.textSize}
              onChange={(textSize) => save({ textSize })}
              options={[
                { id: 'normal', label: t('ap.text.normal') },
                { id: 'large', label: t('ap.text.large') },
              ]}
            />
          </div>
          <SelectField label={t('ap.startPage')} hint={t('ap.startPageHint')} value={p.startPage ?? ''} onChange={(e) => save({ startPage: e.target.value || null })}>
            <option value="">{t('ap.startAuto')}</option>
            {START_PAGES.filter((s) => !s.perms.length || canAny(...s.perms)).map((s) => (
              <option key={s.path} value={s.path}>
                {t(s.label)}
              </option>
            ))}
          </SelectField>
          <div className="stack tight">
            <span className="field-label">{t('ap.language')}</span>
            <Segmented
              label={t('ap.language')}
              value={lang}
              onChange={setLang}
              options={[
                { id: 'ar', label: 'العربية' },
                { id: 'en', label: 'English' },
              ]}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
