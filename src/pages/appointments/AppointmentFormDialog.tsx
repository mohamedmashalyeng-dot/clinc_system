import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, CalendarClock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAction, useDebounced, useErrorText } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, SelectField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { PatientPicker, type PatientRef } from '@/components/pickers';
import { useTimeOff, useTimeOffText } from './TimeOff';
import type { Appointment } from '@/lib/types';

export interface BookingPrefill {
  patient?: PatientRef;
  serviceId?: number;
  practitionerId?: number;
  date?: string;
  time?: string;
  purchasedPackageId?: number | null;
}

interface Issue {
  code: string;
  message: string;
  params: Record<string, string | number>;
}
interface Alternative {
  date: string;
  time: string;
  practitionerId: number;
  roomId: number;
  deviceId: number | null;
  samePractitioner: boolean;
}
interface CheckResult {
  ok: boolean;
  issues: Issue[];
  alternatives: Alternative[];
  buffers: { before: number; after: number; duration: number } | null;
}

/** Localized issue text: record ids in the params are shown with their names in the current language. */
export function useIssueMessage() {
  const { tx } = useI18n();
  const ref = useRef_();
  const offText = useTimeOffText();
  return (i: Issue) => {
    const params = { ...i.params } as Record<string, string | number>;
    if (typeof params.weekday === 'number') params.weekday = tx(`weekday.${params.weekday}`);
    if (typeof params.serviceId === 'number') params.service = ref.serviceName(params.serviceId);
    if (typeof params.practitionerId === 'number') params.practitioner = ref.practitionerName(params.practitionerId);
    if (typeof params.roomId === 'number') params.room = ref.roomName(params.roomId);
    if (typeof params.deviceId === 'number') params.device = ref.deviceName(params.deviceId);
    if (i.code === 'PRACTITIONER_TIME_OFF') {
      params.period = offText.period({ allDay: !!params.allDay, startDate: String(params.startDate), endDate: String(params.endDate), startTime: String(params.startTime), endTime: String(params.endTime) });
    }
    return tx(`issue.${i.code}`, params, i.message);
  };
}

export function AppointmentFormDialog({ prefill, appointment, onClose }: { prefill?: BookingPrefill; appointment?: Appointment; onClose: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { me } = useSession();
  const errorText = useErrorText();
  const issueMessage = useIssueMessage();
  const editing = !!appointment;

  const [patient, setPatient] = useState<PatientRef | null>(
    appointment?.patientId ? { id: appointment.patientId, fullName: appointment.patientName ?? '', phone: appointment.patientPhone ?? undefined } : prefill?.patient ?? null,
  );
  const [serviceId, setServiceId] = useState<number | ''>(appointment?.serviceId ?? prefill?.serviceId ?? '');
  const [practitionerId, setPractitionerId] = useState<number | ''>(appointment?.practitionerId ?? prefill?.practitionerId ?? '');
  const [roomId, setRoomId] = useState<number | ''>(appointment?.roomId ?? '');
  const [deviceId, setDeviceId] = useState<number | ''>(appointment?.deviceId ?? '');
  const [date, setDate] = useState(appointment ? fmt.localDate(appointment.startAt) : prefill?.date ?? fmt.today());
  const [time, setTime] = useState(appointment ? fmt.localTime(appointment.startAt) : prefill?.time ?? '');
  const [packageId, setPackageId] = useState<number | '' | null>(appointment ? appointment.purchasedPackageId ?? '' : prefill?.purchasedPackageId ?? null);
  const [notes, setNotes] = useState(appointment?.notes ?? '');
  const [status, setStatus] = useState<'booked' | 'confirmed'>('booked');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverConflict, setServerConflict] = useState<CheckResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const initial = useMemo(() => JSON.stringify([patient?.id, serviceId, practitionerId, roomId, deviceId, date, time, notes]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify([patient?.id, serviceId, practitionerId, roomId, deviceId, date, time, notes]) !== initial;

  const service = serviceId ? ref.services.get(serviceId) : undefined;
  const services = (ref.data?.services ?? []).filter((s) => s.active || s.id === serviceId);
  const categories = ref.data?.categories ?? [];
  const practitioners = (ref.data?.practitioners ?? []).filter((p) => p.active);
  const qualified = (pid: number) => {
    const p = ref.practitioners.get(pid);
    return !service?.qualification || !!p?.qualifications.includes(service.qualification);
  };
  const rooms = (ref.data?.rooms ?? []).filter((r) => r.active && (!service?.roomIds.length || service.roomIds.includes(r.id)));
  const devices = service?.deviceIds.length ? (ref.data?.devices ?? []).filter((d) => d.active && service.deviceIds.includes(d.id)) : [];

  // Keep room/device valid for the chosen service.
  useEffect(() => {
    if (!service) return;
    if (!rooms.some((r) => r.id === roomId)) setRoomId(rooms[0]?.id ?? '');
    if (!devices.length) setDeviceId('');
    else if (!devices.some((d) => d.id === deviceId)) setDeviceId(devices[0].id);
    if (practitionerId && !qualified(practitionerId)) setPractitionerId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  const packagesQ = useQuery({
    queryKey: ['eligible-packages', patient?.id, serviceId, date],
    queryFn: () => api.get<{ items: { id: number; nameEn: string; nameAr: string; expiryDate: string; remaining: number; balance: number }[] }>('/appointments/eligible-packages', { patientId: patient!.id, serviceId: serviceId as number, date }),
    enabled: !!patient && !!serviceId,
  });
  useEffect(() => {
    // Suggest an eligible package the first time one is available (staff can switch to pay-per-session).
    if (packageId === null && packagesQ.data) setPackageId(packagesQ.data.items[0]?.id ?? '');
  }, [packagesQ.data, packageId]);

  const slotsQ = useQuery({
    queryKey: ['slots', serviceId, practitionerId, date],
    queryFn: () => api.get<{ items: { time: string; roomId: number; deviceId: number | null }[] }>('/appointments/slots', { serviceId: serviceId as number, practitionerId: practitionerId as number, date }),
    enabled: !!serviceId && !!practitionerId && !!date,
  });
  const offQ = useTimeOff(date, date, practitionerId);
  const offToday = practitionerId ? (offQ.data?.items ?? []).filter((o) => o.practitionerId === practitionerId) : [];
  const offText = useTimeOffText();
  const nowLocal = fmt.localTime(new Date().toISOString());
  const freeSlots = (slotsQ.data?.items ?? []).filter((s) => date !== fmt.today() || s.time > nowLocal);

  const checkInput = useDebounced(
    serviceId && practitionerId && roomId && date && /^\d{2}:\d{2}$/.test(time)
      ? { serviceId, practitionerId, roomId, deviceId: deviceId || null, date, time, patientId: patient?.id ?? null, excludeAppointmentId: appointment?.id ?? null }
      : null,
    350,
  );
  const checkKey = JSON.stringify(checkInput);
  useEffect(() => setServerConflict(null), [checkKey]);
  const checkQ = useQuery({
    queryKey: ['check', checkInput],
    queryFn: () => api.post<CheckResult>('/appointments/check', checkInput),
    enabled: !!checkInput,
    staleTime: 5_000,
  });
  const check = serverConflict ?? checkQ.data;

  const save = useAction(
    (body: Record<string, unknown>) => (editing ? api.put(`/appointments/${appointment!.id}`, body) : api.post<{ id: number }>('/appointments', body)),
    {
      success: editing ? t('appt.updated') : t('appt.created'),
      onSuccess: () => onClose(),
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'SCHEDULING_CONFLICT' && e.details) {
          setServerConflict({ ok: false, issues: e.details.issues ?? [], alternatives: e.details.alternatives ?? [], buffers: null });
          return true;
        }
        if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
          setFormError(t('common.fixFields'));
          return true;
        }
        setFormError(errorText(e));
        return true;
      },
    },
  );

  const submit = () => {
    const errs: Record<string, string> = {};
    if (!patient) errs.patient = t('v.required');
    if (!serviceId) errs.service = t('v.required');
    if (!practitionerId) errs.practitioner = t('v.required');
    if (!roomId) errs.room = t('v.required');
    if (devices.length && !deviceId) errs.device = t('v.required');
    if (!date) errs.date = t('v.date');
    if (!/^\d{2}:\d{2}$/.test(time)) errs.time = t('v.time');
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setServerConflict(null);
    save.mutate({
      patientId: patient!.id,
      serviceId,
      practitionerId,
      roomId,
      deviceId: deviceId || null,
      date,
      time,
      purchasedPackageId: packageId || null,
      notes: notes || null,
      status,
    });
  };

  const applyAlternative = (a: Alternative) => {
    setServerConflict(null);
    setDate(a.date);
    setTime(a.time);
    setPractitionerId(a.practitionerId);
    setRoomId(a.roomId);
    setDeviceId(a.deviceId ?? '');
  };

  const pkgs = packagesQ.data?.items ?? [];
  const showDeposit = service && service.depositAmount > 0 && !packageId;

  return (
    <Dialog
      open
      onClose={onClose}
      dirty={dirty && !save.isSuccess}
      size="wide"
      title={editing ? t('appt.edit') : t('appt.new')}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit} disabled={check ? !check.ok && !!checkInput : false}>
            {editing ? t('common.saveChanges') : t('appt.new')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {formError && <Callout tone="danger">{formError}</Callout>}
        <div className="form-grid">
          <div className="span-2">
            <PatientPicker label={t('appt.patient')} required value={patient} onChange={(p) => { setPatient(p); setPackageId(null); }} error={errors.patient} disabled={editing} />
          </div>
          <SelectField label={t('appt.service')} required value={serviceId} onChange={(e) => { setServiceId(e.target.value ? Number(e.target.value) : ''); setPackageId(null); }} error={errors.service} placeholder={t('common.select')}>
            {categories.map((c) => (
              <optgroup key={c.id} label={pick(c.nameEn, c.nameAr)}>
                {services
                  .filter((s) => s.categoryId === c.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {pick(s.nameEn, s.nameAr)} · {t('common.minutes', { n: s.durationMin })} · {fmt.money(s.price)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </SelectField>
          <SelectField label={t('appt.practitioner')} required value={practitionerId} onChange={(e) => setPractitionerId(e.target.value ? Number(e.target.value) : '')} error={errors.practitioner} placeholder={t('common.select')}>
            {practitioners.map((p) => (
              <option key={p.id} value={p.id} disabled={!qualified(p.id)}>
                {pick(p.displayName, p.displayNameAr)}
                {!qualified(p.id) ? ` — ${ref.qualificationName(service?.qualification)} ✕` : ''}
              </option>
            ))}
          </SelectField>
          <TextField label={t('common.date')} type="date" required value={date} onChange={(e) => setDate(e.target.value)} error={errors.date} />
          <TextField label={t('common.time')} type="time" step={(me.settings.slotMinutes || 15) * 60} required value={time} onChange={(e) => setTime(e.target.value)} error={errors.time} />
          {serviceId && practitionerId && (
            <div className="span-2 stack tight">
              <span className="field-label">{t('appt.freeTimes')}</span>
              {offToday.map((o) => (
                <Callout key={o.id} tone="warning">
                  {t('issue.PRACTITIONER_TIME_OFF', { practitioner: ref.practitionerName(o.practitionerId), period: offText.period(o) })}
                </Callout>
              ))}
              {slotsQ.isLoading ? (
                <span className="small muted">{t('common.loading')}</span>
              ) : freeSlots.length ? (
                <div className="slot-chips">
                  {freeSlots.slice(0, 24).map((s) => (
                    <button
                      type="button"
                      key={s.time}
                      className={`chip num ${time === s.time ? 'active' : ''}`}
                      aria-pressed={time === s.time}
                      onClick={() => {
                        setTime(s.time);
                        setRoomId(s.roomId);
                        setDeviceId(s.deviceId ?? '');
                        setServerConflict(null);
                      }}
                    >
                      {s.time}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="small muted">{t('appt.noFreeTimes')}</span>
              )}
            </div>
          )}
          <SelectField label={t('appt.room')} required value={roomId} onChange={(e) => setRoomId(e.target.value ? Number(e.target.value) : '')} error={errors.room} placeholder={t('common.select')}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {pick(r.name, r.nameAr)}
              </option>
            ))}
          </SelectField>
          {devices.length > 0 ? (
            <SelectField label={t('appt.device')} required value={deviceId} onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : '')} error={errors.device} placeholder={t('common.select')}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {pick(d.name, d.nameAr)}
                </option>
              ))}
            </SelectField>
          ) : (
            <TextField label={t('appt.device')} value={t('appt.noDevice')} disabled readOnly />
          )}
        </div>

        {checkInput && (checkQ.isFetching && !serverConflict ? (
          <div className="callout callout-neutral small">
            <span className="spinner" style={{ width: 14, height: 14 }} /> {t('appt.checking')}
          </div>
        ) : check?.ok ? (
          <div className="callout callout-success small">
            <CheckCircle2 size={16} /> {t('appt.available', { before: check.buffers?.before ?? 0, after: check.buffers?.after ?? 0 })}
          </div>
        ) : check && !check.ok ? (
          <div className="callout callout-warning">
            <AlertTriangle size={16} />
            <div className="grow stack tight">
              <strong>{t('appt.unavailable')}</strong>
              <ul>
                {check.issues.map((i, idx) => (
                  <li key={idx}>{issueMessage(i)}</li>
                ))}
              </ul>
              <div className="stack tight">
                <span className="strong small">{t('appt.alternatives')}</span>
                {check.alternatives.length ? (
                  <div className="slot-chips">
                    {check.alternatives.map((a, i) => (
                      <button type="button" key={i} className="chip" onClick={() => applyAlternative(a)}>
                        <CalendarClock size={13} aria-hidden />
                        {fmt.dayShort(a.date)} {a.time} · {ref.practitionerName(a.practitionerId)} · {ref.roomName(a.roomId)}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="small">{t('appt.noAlternatives')}</span>
                )}
              </div>
            </div>
          </div>
        ) : null)}

        <div className="form-grid">
          {patient && serviceId && (
            <SelectField label={t('appt.package')} value={packageId ?? ''} onChange={(e) => setPackageId(e.target.value ? Number(e.target.value) : '')} hint={t('appt.packageHint')}>
              <option value="">{t('appt.noPackage')}</option>
              {pkgs.map((p) => (
                <option key={p.id} value={p.id}>
                  {pick(p.nameEn, p.nameAr)} · {t('pkg.remaining')}: {p.remaining} · {t('pkg.expiry')} {fmt.day(p.expiryDate)}
                </option>
              ))}
            </SelectField>
          )}
          {!editing && (
            <SelectField label={t('appt.initialStatus')} value={status} onChange={(e) => setStatus(e.target.value as 'booked' | 'confirmed')}>
              <option value="booked">{t('status.booked')}</option>
              <option value="confirmed">{t('status.confirmed')}</option>
            </SelectField>
          )}
          {showDeposit && (
            <div className="span-2">
              <Callout tone="info">{t('appt.depositRequired', { amount: fmt.money(service!.depositAmount) })}</Callout>
            </div>
          )}
          <TextArea className="span-2" label={t('appt.notes')} hint={t('common.optional')} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </div>
      </div>
    </Dialog>
  );
}
