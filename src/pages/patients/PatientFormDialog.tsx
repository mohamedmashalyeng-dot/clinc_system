import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useAction, useDebounced, useForm } from '@/lib/hooks';
import { useRef_ } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, Checkbox, SelectField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { patientSchema } from '@shared/schemas';
import type { Patient } from '@/lib/types';

interface Dupe {
  id: number;
  code: string;
  fullName: string;
  phone: string;
  dob: string | null;
}

export function PatientFormDialog({ patient, onCreated, onClose }: { patient?: Patient; onCreated?: (id: number) => void; onClose: () => void }) {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const editing = !!patient;
  const form = useForm(
    {
      firstName: patient?.firstName ?? '',
      lastName: patient?.lastName ?? '',
      phone: patient?.phone ?? '',
      altPhone: patient?.altPhone ?? '',
      email: patient?.email ?? '',
      dob: patient?.dob ?? '',
      gender: patient?.gender ?? 'female',
      address: patient?.address ?? '',
      emergencyName: patient?.emergencyName ?? '',
      emergencyPhone: patient?.emergencyPhone ?? '',
      emergencyRelation: patient?.emergencyRelation ?? '',
      preferredLanguage: patient?.preferredLanguage ?? 'ar',
      contactChannel: patient?.contactChannel ?? 'whatsapp',
      allowReminders: patient?.allowReminders ?? true,
      allowMarketing: patient?.allowMarketing ?? false,
      primaryPractitionerId: (patient?.primaryPractitionerId ?? null) as number | null,
      adminNotes: patient?.adminNotes ?? '',
    },
    patientSchema,
  );
  const v = form.values;
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [serverDupes, setServerDupes] = useState<Dupe[] | null>(null);
  const phoneKey = useDebounced(`${v.phone}|${v.altPhone}`, 400);
  const dupQ = useQuery({
    queryKey: ['duplicates', phoneKey, patient?.id],
    queryFn: () => api.get<{ items: Dupe[] }>('/patients/duplicates', { phone: v.phone, altPhone: v.altPhone, excludeId: patient?.id }),
    enabled: v.phone.replace(/\D/g, '').length >= 7,
  });
  const dupes = serverDupes ?? dupQ.data?.items ?? [];

  const save = useAction(
    (body: unknown) => (editing ? api.put<{ id?: number }>(`/patients/${patient!.id}`, body) : api.post<{ id?: number }>('/patients', body)),
    {
      success: editing ? t('pat.updated') : t('pat.created'),
      onSuccess: (r) => {
        onClose();
        if (!editing && onCreated && r.id) onCreated(r.id);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
          setServerDupes(e.details?.matches ?? []);
          return true;
        }
        return form.applyServerError(e);
      },
    },
  );

  const submit = () => {
    const data = form.validate();
    if (!data) return;
    if (dupes.length && !confirmDuplicate) return;
    save.mutate({ ...data, confirmDuplicate });
  };

  const field = (name: keyof typeof v) => ({
    value: v[name] as string,
    error: form.errors[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => form.set(name, e.target.value as never),
  });

  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      dirty={form.dirty && !save.isSuccess}
      title={editing ? t('pat.edit') : t('pat.new')}
      subtitle={patient?.code}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={dupes.length > 0 && !confirmDuplicate} onClick={submit}>
            {editing ? t('common.saveChanges') : t('pat.new')}
          </Button>
        </>
      }
    >
      <div className="stack loose">
        {Object.keys(form.errors).length > 0 && <Callout tone="danger">{t('common.fixFields')}</Callout>}
        {dupes.length > 0 && (
          <Callout tone="warning" title={t('pat.duplicateTitle')}>
            <p>{t('pat.duplicateBody')}</p>
            <ul>
              {dupes.map((d) => (
                <li key={d.id}>
                  <Link to={`/patients/${d.id}`} onClick={onClose}>
                    {d.fullName}
                  </Link>{' '}
                  <span className="xs ltr">
                    {d.code} · {d.phone}
                  </span>
                </li>
              ))}
            </ul>
            <p className="small" style={{ marginTop: 6 }}>
              {t('pat.duplicateAction')}
            </p>
            <div style={{ marginTop: 6 }}>
              <Checkbox label={t('pat.createAnyway')} checked={confirmDuplicate} onChange={setConfirmDuplicate} />
            </div>
          </Callout>
        )}
        <fieldset className="form-grid">
          <legend className="section-title span-2" style={{ marginBottom: 4 }}>
            {t('pat.contact')}
          </legend>
          <TextField label={t('pat.firstName')} required autoComplete="off" {...field('firstName')} data-autofocus />
          <TextField label={t('pat.lastName')} required autoComplete="off" {...field('lastName')} />
          <TextField label={t('pat.phone')} required type="tel" dir="ltr" {...field('phone')} />
          <TextField label={t('pat.altPhone')} type="tel" dir="ltr" hint={t('common.optional')} {...field('altPhone')} />
          <TextField label={t('pat.email')} type="email" dir="ltr" hint={t('common.optional')} {...field('email')} />
          <TextField label={t('pat.dob')} type="date" {...field('dob')} />
          <SelectField label={t('pat.gender')} {...field('gender')}>
            <option value="female">{t('pat.gender.female')}</option>
            <option value="male">{t('pat.gender.male')}</option>
            <option value="unspecified">{t('pat.gender.unspecified')}</option>
          </SelectField>
          <SelectField
            label={t('pat.primaryPractitioner')}
            value={v.primaryPractitionerId ?? ''}
            onChange={(e) => form.set('primaryPractitionerId', e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t('common.none')}</option>
            {ref.data?.practitioners
              .filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {pick(p.displayName, p.displayNameAr)}
                </option>
              ))}
          </SelectField>
          <TextField className="span-2" label={t('pat.address')} hint={t('common.optional')} {...field('address')} />
        </fieldset>
        <fieldset className="form-grid">
          <legend className="section-title span-2" style={{ marginBottom: 4 }}>
            {t('pat.emergency')}
          </legend>
          <TextField label={t('pat.emergencyName')} {...field('emergencyName')} />
          <TextField label={t('pat.emergencyPhone')} type="tel" dir="ltr" {...field('emergencyPhone')} />
          <TextField label={t('pat.emergencyRelation')} {...field('emergencyRelation')} />
        </fieldset>
        <fieldset className="form-grid">
          <legend className="section-title span-2" style={{ marginBottom: 4 }}>
            {t('pat.preferences')}
          </legend>
          <SelectField label={t('pat.language')} {...field('preferredLanguage')}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </SelectField>
          <SelectField label={t('pat.channel')} {...field('contactChannel')}>
            {['whatsapp', 'sms', 'email', 'phone', 'none'].map((c) => (
              <option key={c} value={c}>
                {t(`pat.channel.${c}` as 'pat.channel.sms')}
              </option>
            ))}
          </SelectField>
          <Checkbox label={t('pat.allowReminders')} checked={v.allowReminders} onChange={(x) => form.set('allowReminders', x)} />
          <Checkbox label={t('pat.allowMarketing')} checked={v.allowMarketing} onChange={(x) => form.set('allowMarketing', x)} />
          <TextArea className="span-2" label={t('pat.adminNotes')} rows={2} {...field('adminNotes')} />
        </fieldset>
      </div>
    </Dialog>
  );
}
