import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImageUp, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useForm, useUrlState } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, Panel, SelectField, TextArea, TextField } from '@/components/ui';
import { ConfirmDialog } from '@/components/overlays';
import { UnsavedChangesGuard } from '@/components/pickers';
import { settingsSchema } from '@shared/schemas';
import { ServicesConfig, PackageTemplatesConfig } from '@/pages/services/ServicesPage';
import { PractitionersSettings, RoomsDevicesSettings, ConsentTemplatesSettings } from './ResourceSettings';
import { StaffSettings, PermissionsSettings, AuditLog } from './AccessSettings';
import type { Permission } from '@shared/permissions';
import type { TKey } from '@/i18n/en';

type Section = 'clinic' | 'hours' | 'cancellation' | 'practitioners' | 'rooms' | 'services' | 'packages' | 'consents' | 'staff' | 'permissions' | 'integrations' | 'audit' | 'demo';

const SECTIONS: { id: Section; label: TKey; perm: Permission; demoOnly?: boolean }[] = [
  { id: 'clinic', label: 'set.clinic', perm: 'settings.manage' },
  { id: 'hours', label: 'set.hours', perm: 'settings.manage' },
  { id: 'cancellation', label: 'set.cancellation', perm: 'settings.manage' },
  { id: 'practitioners', label: 'set.practitioners', perm: 'settings.manage' },
  { id: 'rooms', label: 'set.rooms', perm: 'settings.manage' },
  { id: 'services', label: 'set.services', perm: 'settings.manage' },
  { id: 'packages', label: 'set.packages', perm: 'settings.manage' },
  { id: 'consents', label: 'set.consents', perm: 'settings.manage' },
  { id: 'staff', label: 'set.staff', perm: 'staff.manage' },
  { id: 'permissions', label: 'set.permissions', perm: 'permissions.manage' },
  { id: 'integrations', label: 'set.integrations', perm: 'settings.manage' },
  { id: 'audit', label: 'set.audit', perm: 'audit.view' },
  { id: 'demo', label: 'set.demo', perm: 'settings.manage', demoOnly: true },
];

export function SettingsPage() {
  const { t } = useI18n();
  const { can, me } = useSession();
  const available = SECTIONS.filter((s) => can(s.perm) && (!s.demoOnly || me.demoMode));
  const [s, set] = useUrlState({ section: available[0]?.id ?? 'clinic' });
  const section = (available.find((x) => x.id === s.section)?.id ?? available[0]?.id) as Section;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('set.title')}</h1>
      </div>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(180px, 220px) minmax(0, 1fr)', alignItems: 'start' }}>
        <nav className="panel" aria-label={t('set.title')} style={{ padding: 6 }}>
          {available.map((x) => (
            <button key={x.id} className="menu-item" data-active={section === x.id} aria-current={section === x.id ? 'page' : undefined} onClick={() => set({ section: x.id })} style={{ borderRadius: 6 }}>
              {t(x.label)}
            </button>
          ))}
        </nav>
        <div className="stack" style={{ minWidth: 0 }}>
          {(section === 'clinic' || section === 'hours' || section === 'cancellation') && <ClinicSettings key={section} section={section} />}
          {section === 'practitioners' && <PractitionersSettings />}
          {section === 'rooms' && <RoomsDevicesSettings />}
          {section === 'services' && <ServicesConfig />}
          {section === 'packages' && <PackageTemplatesConfig />}
          {section === 'consents' && <ConsentTemplatesSettings />}
          {section === 'staff' && <StaffSettings />}
          {section === 'permissions' && <PermissionsSettings />}
          {section === 'integrations' && <Integrations />}
          {section === 'audit' && <AuditLog />}
          {section === 'demo' && <DemoReset />}
        </div>
      </div>
    </div>
  );
}

const CURRENCIES = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'KWD', 'QAR', 'JOD'];

function ClinicSettings({ section }: { section: 'clinic' | 'hours' | 'cancellation' }) {
  const { t } = useI18n();
  const { me } = useSession();
  const qc = useQueryClient();
  const s = me.settings;
  const form = useForm(
    {
      clinicName: s.clinicName,
      clinicNameAr: s.clinicNameAr,
      address: s.address ?? '',
      phone: s.phone ?? '',
      email: s.email ?? '',
      taxRegistration: s.taxRegistration ?? '',
      defaultLanguage: s.defaultLanguage,
      currency: s.currency,
      timezone: s.timezone,
      taxRatePercent: s.taxRatePercent,
      slotMinutes: s.slotMinutes,
      openingHours: s.openingHours,
      cancellation: { ...s.cancellation, policyTextEn: s.cancellation.policyTextEn ?? '', policyTextAr: s.cancellation.policyTextAr ?? '' },
      packageExpiryWarningDays: s.packageExpiryWarningDays,
      expiryWarningDays: s.expiryWarningDays,
    },
    settingsSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => api.put('/settings', body), {
    success: t('set.saved'),
    onSuccess: () => {
      form.markClean();
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => form.applyServerError(e),
  });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  const zones = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai', 'Europe/London', 'UTC'];
    }
  })();
  const footer = (
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      <Button variant="primary" loading={save.isPending} disabled={!form.dirty} onClick={submit}>
        {t('common.saveChanges')}
      </Button>
    </div>
  );
  return (
    <>
      <UnsavedChangesGuard when={form.dirty && !save.isSuccess} />
      {Object.keys(form.errors).length > 0 && <Callout tone="danger">{t('common.fixFields')}</Callout>}
      {section === 'clinic' && (
        <>
          <Panel title={t('set.clinic')} footer={footer}>
            <div className="form-grid">
              <TextField label={t('set.clinicName')} required value={v.clinicName} error={form.errors.clinicName} onChange={(e) => form.set('clinicName', e.target.value)} />
              <TextField label={t('set.clinicNameAr')} required dir="rtl" value={v.clinicNameAr} error={form.errors.clinicNameAr} onChange={(e) => form.set('clinicNameAr', e.target.value)} />
              <TextField className="span-2" label={t('set.address')} value={v.address} onChange={(e) => form.set('address', e.target.value)} />
              <TextField label={t('set.phone')} dir="ltr" value={v.phone} onChange={(e) => form.set('phone', e.target.value)} />
              <TextField label={t('set.email')} type="email" dir="ltr" value={v.email} error={form.errors.email} onChange={(e) => form.set('email', e.target.value)} />
              <TextField label={t('set.taxReg')} value={v.taxRegistration} onChange={(e) => form.set('taxRegistration', e.target.value)} />
              <TextField label={t('set.taxRate')} type="number" min={0} max={50} step="0.5" value={v.taxRatePercent} error={form.errors.taxRatePercent} onChange={(e) => form.set('taxRatePercent', Number(e.target.value))} />
              <SelectField label={t('set.language')} value={v.defaultLanguage} onChange={(e) => form.set('defaultLanguage', e.target.value as 'en' | 'ar')}>
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </SelectField>
              <SelectField label={t('set.currency')} value={v.currency} onChange={(e) => form.set('currency', e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SelectField>
              <SelectField className="span-2" label={t('set.timezone')} value={v.timezone} error={form.errors.timezone} onChange={(e) => form.set('timezone', e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </SelectField>
            </div>
          </Panel>
          <LogoPanel />
        </>
      )}
      {section === 'hours' && (
        <Panel title={t('set.hours')} footer={footer}>
          <div className="stack">
            {form.errors.openingHours && <span className="field-error">{form.errors.openingHours}</span>}
            <div className="table-wrap">
              <table className="table table-compact">
                <tbody>
                  {[6, 0, 1, 2, 3, 4, 5].map((d) => {
                    const day = v.openingHours[d];
                    const setDay = (patch: Partial<typeof day>) => form.set('openingHours', v.openingHours.map((x, i) => (i === d ? { ...x, ...patch } : x)));
                    return (
                      <tr key={d}>
                        <td className="strong" style={{ width: 140 }}>
                          {t(`weekday.${d}` as TKey)}
                        </td>
                        <td style={{ width: 120 }}>
                          <Checkbox label={day.open ? t('set.open') : t('set.closed')} checked={day.open} onChange={(x) => setDay({ open: x })} />
                        </td>
                        <td>
                          <div className="row">
                            <input className="input input-sm" type="time" aria-label={`${t(`weekday.${d}` as TKey)} ${t('set.opens')}`} disabled={!day.open} value={day.start} onChange={(e) => setDay({ start: e.target.value })} style={{ width: 120 }} />
                            <span className="muted">–</span>
                            <input className="input input-sm" type="time" aria-label={`${t(`weekday.${d}` as TKey)} ${t('set.closes')}`} disabled={!day.open} value={day.end} onChange={(e) => setDay({ end: e.target.value })} style={{ width: 120 }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="form-grid">
              <SelectField label={t('set.slot')} value={v.slotMinutes} onChange={(e) => form.set('slotMinutes', Number(e.target.value))}>
                {[5, 10, 15, 20, 30].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </SelectField>
              <TextField label={t('set.pkgWarn')} type="number" min={1} max={180} value={v.packageExpiryWarningDays} onChange={(e) => form.set('packageExpiryWarningDays', Number(e.target.value))} />
              <TextField label={t('set.expWarn')} type="number" min={1} max={365} value={v.expiryWarningDays} onChange={(e) => form.set('expiryWarningDays', Number(e.target.value))} />
            </div>
          </div>
        </Panel>
      )}
      {section === 'cancellation' && (
        <Panel title={t('set.cancellation')} footer={footer}>
          <div className="form-grid">
            <TextField label={t('set.minNotice')} type="number" min={0} max={168} value={v.cancellation.minNoticeHours} onChange={(e) => form.set('cancellation', { ...v.cancellation, minNoticeHours: Number(e.target.value) })} />
            <span />
            <SelectField label={t('set.lateCancel')} value={v.cancellation.lateCancelDeposit} onChange={(e) => form.set('cancellation', { ...v.cancellation, lateCancelDeposit: e.target.value as 'retain' | 'refund' })}>
              <option value="retain">{t('set.retain')}</option>
              <option value="refund">{t('set.refund')}</option>
            </SelectField>
            <SelectField label={t('set.noShow')} value={v.cancellation.noShowDeposit} onChange={(e) => form.set('cancellation', { ...v.cancellation, noShowDeposit: e.target.value as 'retain' | 'refund' })}>
              <option value="retain">{t('set.retain')}</option>
              <option value="refund">{t('set.refund')}</option>
            </SelectField>
            <TextArea className="span-2" label={t('set.policyEn')} rows={3} value={v.cancellation.policyTextEn ?? ''} onChange={(e) => form.set('cancellation', { ...v.cancellation, policyTextEn: e.target.value })} />
            <TextArea className="span-2" label={t('set.policyAr')} rows={3} dir="rtl" value={v.cancellation.policyTextAr ?? ''} onChange={(e) => form.set('cancellation', { ...v.cancellation, policyTextAr: e.target.value })} />
            <div className="span-2">
              <Callout tone="info">{t('appt.packageSafe')}</Callout>
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}

function LogoPanel() {
  const { t } = useI18n();
  const { me } = useSession();
  const qc = useQueryClient();
  const [version, setVersion] = useState(0);
  const upload = useAction((f: File) => api.upload('/settings/logo', f), {
    success: t('set.saved'),
    onSuccess: () => {
      setVersion((x) => x + 1);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const remove = useAction(() => api.del('/settings/logo'), { success: t('set.saved'), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }) });
  return (
    <Panel title={t('set.logo')}>
      <div className="row wrap" style={{ gap: 16 }}>
        <div className="brand-mark has-logo" style={{ width: 64, height: 64, background: me.settings.hasLogo ? 'var(--surface-2)' : 'var(--accent)' }}>
          {me.settings.hasLogo && <img src={`/api/settings/logo?v=${version}`} alt={t('set.logo')} style={{ objectFit: 'contain' }} />}
        </div>
        <div className="stack tight">
          <label className="btn btn-sm" style={{ width: 'fit-content' }}>
            <ImageUp size={15} /> {t('set.logoUpload')}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          </label>
          {me.settings.hasLogo && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} loading={remove.isPending} onClick={() => remove.mutate(undefined)}>
              {t('set.logoRemove')}
            </Button>
          )}
          <span className="xs muted">{t('set.logoHint')}</span>
        </div>
      </div>
    </Panel>
  );
}

function Integrations() {
  const { t } = useI18n();
  const { me } = useSession();
  const rows: [string, ReactNode][] = Object.entries(me.settings.integrations).map(([k, v]) => [k, v]);
  return (
    <Panel title={t('set.integrations')}>
      <div className="stack">
        <p className="small muted">{t('set.integrationsIntro')}</p>
        {rows.map(([k, v]) => (
          <div key={k} className="row between subtle-box">
            <div>
              <div className="strong">{t(`set.int.${k}` as TKey)}</div>
              {k === 'cloud_storage' && <div className="xs muted">{t('set.int.storageLocal')}</div>}
              {k === 'online_payments' && <div className="xs muted">{t('bill.recordingOnly')}</div>}
              {['whatsapp', 'sms', 'email'].includes(k) && <div className="xs muted">{t('fu.integrationNote')}</div>}
            </div>
            <Badge tone={v === 'connected' ? 'success' : 'outline'}>{v === 'connected' ? t('set.connected') : t('set.notConnected')}</Badge>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function DemoReset() {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const reset = useAction(() => api.post('/demo/reset'), { onSuccess: () => window.location.assign('/'), invalidate: false });
  return (
    <Panel title={t('set.demo')}>
      <div className="stack">
        <Callout tone="warning">{t('set.demoIntro')}</Callout>
        <div>
          <Button variant="danger" icon={<RotateCcw size={15} />} onClick={() => setConfirm(true)}>
            {t('set.demoReset')}
          </Button>
        </div>
      </div>
      <ConfirmDialog open={confirm} title={t('set.demoConfirm')} body={t('set.demoIntro')} danger confirmLabel={t('set.demoReset')} loading={reset.isPending} onCancel={() => setConfirm(false)} onConfirm={() => reset.mutate(undefined)} />
    </Panel>
  );
}

