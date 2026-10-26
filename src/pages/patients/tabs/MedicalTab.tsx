import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, History, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useForm } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, EmptyState, ErrorState, KV, Loading, Panel, SelectField, TextArea, TextField } from '@/components/ui';
import { Drawer } from '@/components/overlays';
import { UnsavedChangesGuard } from '@/components/pickers';
import { medicalSchema } from '@shared/schemas';
import type { Alert } from '@/lib/types';
import type { TKey } from '@/i18n/en';

interface MedicalData {
  medicalHistory: string | null;
  allergies: string | null;
  medications: string | null;
  skinType: string | null;
  pregnant: 'unknown' | 'no' | 'yes';
  precautions: string | null;
  alerts: Alert[];
}

export function MedicalTab({ patientId }: { patientId: number }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const q = useQuery({
    queryKey: ['medical', patientId],
    queryFn: () => api.get<{ data: MedicalData | null; version: number; updatedAt: string | null; updatedBy: string | null }>(`/patients/${patientId}/medical`),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!.data;
  return (
    <div className="stack">
      <Callout tone="neutral">{t('med.disclaimer')}</Callout>
      {editing ? (
        <MedicalForm patientId={patientId} data={d} version={q.data!.version} onDone={() => setEditing(false)} />
      ) : (
        <Panel
          title={t('med.title')}
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<History size={15} />} onClick={() => setShowVersions(true)}>
                {t('med.versions')}
              </Button>
              {can('medical.edit') && (
                <Button size="sm" icon={<Pencil size={15} />} onClick={() => setEditing(true)}>
                  {t('common.edit')}
                </Button>
              )}
            </>
          }
          footer={q.data!.updatedAt ? <span className="xs muted">{t('common.lastUpdated', { when: fmt.dateTime(q.data!.updatedAt), who: q.data!.updatedBy ?? '—' })}</span> : undefined}
        >
          {!d ? (
            <EmptyState title={t('med.empty')} />
          ) : (
            <div className="stack loose">
              {d.alerts.length > 0 && (
                <div className="stack tight">
                  <h3 className="section-title">{t('med.alerts')}</h3>
                  {d.alerts.map((a, i) => (
                    <div key={i} className={`alert-item ${a.severity}`}>
                      <AlertTriangle size={15} aria-hidden />
                      <span className="grow">{a.text}</span>
                      <span className="xs">{t(`med.sev.${a.severity}` as TKey)}</span>
                    </div>
                  ))}
                </div>
              )}
              <KV
                items={[
                  [t('med.history'), <span className="pre-wrap">{d.medicalHistory ?? '—'}</span>],
                  [t('med.allergies'), <span className="pre-wrap">{d.allergies ?? '—'}</span>],
                  [t('med.medications'), <span className="pre-wrap">{d.medications ?? '—'}</span>],
                  [t('med.skinType'), d.skinType ?? '—'],
                  [t('med.pregnant'), t(`med.pregnant.${d.pregnant}` as TKey)],
                  [t('med.precautions'), <span className="pre-wrap">{d.precautions ?? '—'}</span>],
                ]}
              />
            </div>
          )}
        </Panel>
      )}
      {showVersions && <VersionsDrawer patientId={patientId} onClose={() => setShowVersions(false)} />}
    </div>
  );
}

function MedicalForm({ patientId, data, version, onDone }: { patientId: number; data: MedicalData | null; version: number; onDone: () => void }) {
  const { t } = useI18n();
  const form = useForm(
    {
      medicalHistory: data?.medicalHistory ?? '',
      allergies: data?.allergies ?? '',
      medications: data?.medications ?? '',
      skinType: data?.skinType ?? '',
      pregnant: data?.pregnant ?? 'unknown',
      precautions: data?.precautions ?? '',
      alerts: (data?.alerts ?? []).map((a) => ({ text: a.text, severity: a.severity })),
    },
    medicalSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => api.put(`/patients/${patientId}/medical`, { data: body, version }), {
    success: t('med.saved'),
    onSuccess: () => {
      form.markClean();
      onDone();
    },
    onError: (e) => form.applyServerError(e),
  });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  const text = (k: 'medicalHistory' | 'allergies' | 'medications' | 'precautions') => ({
    value: v[k],
    error: form.errors[k],
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => form.set(k, e.target.value),
  });
  return (
    <Panel
      title={t('med.title')}
      footer={
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onDone}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <UnsavedChangesGuard when={form.dirty && !save.isSuccess} />
      <div className="stack loose">
        <fieldset className="stack tight">
          <legend className="section-title">{t('med.alerts')}</legend>
          {v.alerts.map((a, i) => (
            <div key={i} className="row top">
              <TextField
                className="grow"
                label={i === 0 ? t('med.alertText') : undefined}
                aria-label={t('med.alertText')}
                value={a.text}
                error={form.errors[`alerts.${i}.text`]}
                onChange={(e) => form.set('alerts', v.alerts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              />
              <SelectField
                label={i === 0 ? t('med.severity') : undefined}
                aria-label={t('med.severity')}
                value={a.severity}
                onChange={(e) => form.set('alerts', v.alerts.map((x, j) => (j === i ? { ...x, severity: e.target.value as Alert['severity'] } : x)))}
              >
                {(['high', 'medium', 'low'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`med.sev.${s}` as TKey)}
                  </option>
                ))}
              </SelectField>
              <Button variant="ghost" style={{ marginTop: i === 0 ? 24 : 0 }} icon={<Trash2 size={16} />} aria-label={t('common.remove')} onClick={() => form.set('alerts', v.alerts.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="soft" icon={<Plus size={15} />} onClick={() => form.set('alerts', [...v.alerts, { text: '', severity: 'medium' }])}>
              {t('med.addAlert')}
            </Button>
          </div>
        </fieldset>
        <div className="form-grid">
          <TextArea className="span-2" label={t('med.history')} rows={3} {...text('medicalHistory')} />
          <TextArea label={t('med.allergies')} rows={2} {...text('allergies')} />
          <TextArea label={t('med.medications')} rows={2} {...text('medications')} />
          <SelectField label={t('med.skinType')} value={v.skinType} onChange={(e) => form.set('skinType', e.target.value)}>
            <option value="">—</option>
            {['I', 'II', 'III', 'IV', 'V', 'VI'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('med.pregnant')} value={v.pregnant} onChange={(e) => form.set('pregnant', e.target.value as MedicalData['pregnant'])}>
            {(['unknown', 'no', 'yes'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`med.pregnant.${s}` as TKey)}
              </option>
            ))}
          </SelectField>
          <TextArea className="span-2" label={t('med.precautions')} rows={2} {...text('precautions')} />
        </div>
      </div>
    </Panel>
  );
}

function VersionsDrawer({ patientId, onClose }: { patientId: number; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['medical-versions', patientId],
    queryFn: () => api.get<{ items: { version: number; data: MedicalData; createdAt: string; author: string | null }[] }>(`/patients/${patientId}/medical/versions`),
  });
  return (
    <Drawer open onClose={onClose} title={t('med.versions')}>
      {q.isLoading && <Loading />}
      {q.data && !q.data.items.length && <EmptyState title={t('med.noVersions')} />}
      <div className="stack">
        {q.data?.items.map((v) => (
          <div key={v.version} className="subtle-box stack tight">
            <div className="row between">
              <strong>{t('med.version', { n: v.version })}</strong>
              <span className="xs muted">
                {fmt.dateTime(v.createdAt)} · {v.author ?? '—'}
              </span>
            </div>
            <KV
              items={[
                [t('med.history'), v.data.medicalHistory ?? '—'],
                [t('med.allergies'), v.data.allergies ?? '—'],
                [t('med.medications'), v.data.medications ?? '—'],
                [t('med.precautions'), v.data.precautions ?? '—'],
                [t('med.alerts'), v.data.alerts?.map((a) => a.text).join('; ') || '—'],
              ]}
            />
          </div>
        ))}
      </div>
    </Drawer>
  );
}
