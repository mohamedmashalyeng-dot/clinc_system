// Smart waitlist: patients who want a sooner or specific time. Each waiting entry shows the earliest
// free slot that fits it; a cancelled booking lists the waiting patients who could take its time.
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CalendarPlus, ListPlus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, EmptyState, ErrorState, Loading, Panel, Segmented, SelectField, TextArea, TextField } from '@/components/ui';
import { ConfirmDialog, Dialog } from '@/components/overlays';
import { PatientPicker, type PatientRef } from '@/components/pickers';
import { useActions } from '@/layout/actions';
import { addDays } from '@shared/time';
import { WAITLIST_TIMES } from '@shared/domain';

interface Slot {
  date: string;
  time: string;
  practitionerId: number;
  roomId: number;
  deviceId: number | null;
}

export interface WaitlistEntry {
  id: number;
  patientId: number;
  patientName: string;
  patientCode: string;
  patientPhone: string;
  serviceId: number;
  practitionerId: number | null;
  earliestDate: string;
  latestDate: string;
  timeOfDay: string;
  notes: string | null;
  status: 'waiting' | 'booked' | 'removed';
  appointmentId: number | null;
  appointmentStart: string | null;
  createdAt: string;
  createdByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  closeReason: string | null;
  expired?: boolean;
  slot: Slot | null;
}

export interface WaitlistPrefill {
  patient?: PatientRef;
  serviceId?: number;
  practitionerId?: number | null;
  earliestDate?: string;
}

function useBookSlot() {
  const actions = useActions();
  return (e: Pick<WaitlistEntry, 'patientId' | 'patientName' | 'patientPhone' | 'serviceId'>, slot: Slot) =>
    actions.book({
      patient: { id: e.patientId, fullName: e.patientName, phone: e.patientPhone },
      serviceId: e.serviceId,
      practitionerId: slot.practitionerId,
      roomId: slot.roomId,
      deviceId: slot.deviceId,
      date: slot.date,
      time: slot.time,
    });
}

export function WaitlistView() {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const book = useBookSlot();
  const [status, setStatus] = useState<'waiting' | 'closed'>('waiting');
  const [removing, setRemoving] = useState<WaitlistEntry | null>(null);
  const q = useQuery({ queryKey: ['waitlist', status], queryFn: () => api.get<{ items: WaitlistEntry[]; searchDays: number }>('/waitlist', { status }) });
  const remove = useAction((v: { id: number; reason: string }) => api.post(`/waitlist/${v.id}/remove`, { reason: v.reason }), { success: t('wl.removed'), onSuccess: () => setRemoving(null) });
  const items = q.data?.items ?? [];
  return (
    <Panel
      flush
      title={t('wl.title')}
      actions={
        <>
          <Segmented
            label={t('wl.title')}
            value={status}
            onChange={setStatus}
            options={[
              { id: 'waiting', label: t('wl.waiting') },
              { id: 'closed', label: t('wl.closed') },
            ]}
          />
          {can('appointments.manage') && (
            <Button size="sm" variant="primary" icon={<ListPlus size={15} />} onClick={() => actions.addToWaitlist()}>
              {t('wl.add')}
            </Button>
          )}
        </>
      }
    >
      <p className="xs muted" style={{ padding: '10px 14px 0' }}>
        {t('wl.hint', { days: q.data?.searchDays ?? 21 })}
      </p>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !items.length && <EmptyState title={status === 'waiting' ? t('wl.empty') : t('wl.emptyClosed')} />}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('appt.patient')}</th>
                <th>{t('appt.service')}</th>
                <th>{t('wl.window')}</th>
                <th>{status === 'waiting' ? t('wl.earliestSlot') : t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={`/patients/${e.patientId}`} className="strong">
                      {e.patientName}
                    </Link>
                    <div className="xs muted ltr">{e.patientPhone}</div>
                    {e.notes && <div className="xs muted">{e.notes}</div>}
                  </td>
                  <td className="small">
                    {ref.serviceName(e.serviceId)}
                    <div className="xs muted">{e.practitionerId ? ref.practitionerName(e.practitionerId) : t('wl.anyPractitioner')}</div>
                  </td>
                  <td className="small nowrap">
                    {fmt.day(e.earliestDate)} – {fmt.day(e.latestDate)}
                    <div className="xs muted">{tx(`wl.tod.${e.timeOfDay}`)}</div>
                  </td>
                  <td className="small">
                    {e.status === 'waiting' ? (
                      e.expired ? (
                        <Badge tone="outline">{t('wl.expired')}</Badge>
                      ) : e.slot ? (
                        <span className="stack tight" style={{ gap: 2 }}>
                          <span className="strong" style={{ color: 'var(--success)' }}>
                            {fmt.dayShort(e.slot.date)} · {e.slot.time}
                          </span>
                          <span className="xs muted">{ref.practitionerName(e.slot.practitionerId)}</span>
                        </span>
                      ) : (
                        <span className="muted">{t('wl.noSlot')}</span>
                      )
                    ) : e.status === 'booked' ? (
                      <span className="stack tight" style={{ gap: 2 }}>
                        <Badge tone="success">{t('wl.status.booked')}</Badge>
                        {e.appointmentStart && e.appointmentId && (
                          <button className="link-btn xs" onClick={() => actions.openAppointment(e.appointmentId!)}>
                            {fmt.dateTime(e.appointmentStart)}
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="stack tight" style={{ gap: 2 }}>
                        <Badge tone="outline">{t('wl.status.removed')}</Badge>
                        {e.closeReason && <span className="xs muted">{e.closeReason}</span>}
                      </span>
                    )}
                  </td>
                  <td className="nowrap" style={{ textAlign: 'end' }}>
                    {e.status === 'waiting' && can('appointments.manage') && (
                      <>
                        {e.slot && (
                          <Button size="xs" variant="primary" icon={<CalendarCheck size={13} />} onClick={() => book(e, e.slot!)}>
                            {t('wl.bookSlot')}
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={<CalendarPlus size={13} />}
                          onClick={() => actions.book({ patient: { id: e.patientId, fullName: e.patientName, phone: e.patientPhone }, serviceId: e.serviceId, practitionerId: e.practitionerId ?? undefined, date: e.earliestDate > fmt.today() ? e.earliestDate : fmt.today() })}
                        >
                          {t('wl.chooseTime')}
                        </Button>
                        <Button size="xs" variant="ghost" icon={<Trash2 size={13} />} aria-label={t('wl.remove')} onClick={() => setRemoving(e)} />
                      </>
                    )}
                    {e.status !== 'waiting' && <span className="xs muted">{e.closedByName ? `${e.closedByName} · ${fmt.date(e.closedAt)}` : fmt.date(e.closedAt)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        title={t('wl.remove')}
        body={removing ? `${removing.patientName} · ${ref.serviceName(removing.serviceId)}` : undefined}
        reasonLabel={t('common.reason')}
        confirmLabel={t('wl.remove')}
        danger
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={(reason) => removing && remove.mutate({ id: removing.id, reason })}
      />
    </Panel>
  );
}

export function WaitlistDialog({ prefill, onClose }: { prefill?: WaitlistPrefill; onClose: () => void }) {
  const { t, pick, tx } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const today = fmt.today();
  const [patient, setPatient] = useState<PatientRef | null>(prefill?.patient ?? null);
  const [serviceId, setServiceId] = useState<number | ''>(prefill?.serviceId ?? '');
  const [practitionerId, setPractitionerId] = useState<number | ''>(prefill?.practitionerId ?? '');
  const [earliestDate, setEarliest] = useState(prefill?.earliestDate && prefill.earliestDate > today ? prefill.earliestDate : today);
  const [latestDate, setLatest] = useState(addDays(earliestDate, 14));
  const [timeOfDay, setTimeOfDay] = useState('any');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const service = serviceId ? ref.services.get(serviceId) : undefined;
  const practitioners = (ref.data?.practitioners ?? []).filter((p) => p.active && (!service?.qualification || p.qualifications.includes(service.qualification)));
  const save = useAction((body: unknown) => api.post('/waitlist', body), {
    success: t('wl.added'),
    onSuccess: onClose,
  });
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!patient) errs.patient = t('v.required');
    if (!serviceId) errs.service = t('v.required');
    if (latestDate < earliestDate) errs.latest = t('v.endBeforeStart');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({ patientId: patient!.id, serviceId, practitionerId: practitionerId || null, earliestDate, latestDate, timeOfDay, notes: notes || null });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('wl.add')}
      subtitle={t('wl.addHint')}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('wl.add')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <PatientPicker label={t('appt.patient')} required value={patient} onChange={setPatient} error={errors.patient} />
        <div className="form-grid">
          <SelectField label={t('appt.service')} required value={serviceId} error={errors.service} placeholder={t('common.select')} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : '')}>
            {(ref.data?.services ?? [])
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {pick(s.nameEn, s.nameAr)}
                </option>
              ))}
          </SelectField>
          <SelectField label={t('appt.practitioner')} value={practitionerId} onChange={(e) => setPractitionerId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">{t('wl.anyPractitioner')}</option>
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>
                {pick(p.displayName, p.displayNameAr)}
              </option>
            ))}
          </SelectField>
          <TextField label={t('wl.earliest')} type="date" min={today} value={earliestDate} onChange={(e) => setEarliest(e.target.value)} />
          <TextField label={t('wl.latest')} type="date" min={earliestDate} value={latestDate} error={errors.latest} onChange={(e) => setLatest(e.target.value)} />
          <SelectField label={t('wl.timeOfDay')} value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)}>
            {WAITLIST_TIMES.map((x) => (
              <option key={x} value={x}>
                {tx(`wl.tod.${x}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <TextArea label={t('common.notes')} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Dialog>
  );
}

/** For a cancelled upcoming booking: waiting patients who fit the freed time, one click to book. */
export function WaitlistMatches({ appointmentId }: { appointmentId: number }) {
  const { t } = useI18n();
  const ref = useRef_();
  const { can } = useSession();
  const book = useBookSlot();
  const q = useQuery({ queryKey: ['waitlist-matches', appointmentId], queryFn: () => api.get<{ items: WaitlistEntry[] }>('/waitlist/matches', { appointmentId }) });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Callout tone="success" title={t('wl.matchesTitle', { n: items.length })}>
      <div className="stack tight" style={{ marginTop: 6 }}>
        {items.map((e) => (
          <div key={e.id} className="row between wrap" style={{ gap: 8 }}>
            <span className="small">
              <strong>{e.patientName}</strong> · {ref.serviceName(e.serviceId)}
            </span>
            {can('appointments.manage') && e.slot && (
              <Button size="xs" variant="primary" icon={<CalendarCheck size={13} />} onClick={() => book(e, e.slot!)}>
                {t('wl.bookSlot')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </Callout>
  );
}

