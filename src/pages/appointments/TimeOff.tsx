import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarOff, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAction, useForm } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, EmptyState, ErrorState, KV, Loading, Panel, SelectField, TextArea, TextField } from '@/components/ui';
import { ConfirmDialog, Dialog } from '@/components/overlays';
import { useActions } from '@/layout/actions';
import { timeOffSchema } from '@shared/schemas';
import { TIME_OFF_KINDS } from '@shared/domain';
import { timeToMinutes } from '@shared/time';
import type { Appointment, TimeOff } from '@/lib/types';
import type { TKey } from '@/i18n/en';

/** Active time off overlapping a range of clinic-local dates (calendar shading, booking hints). */
export function useTimeOff(from: string, to: string, practitionerId?: number | '' | null) {
  return useQuery({
    queryKey: ['time-off', 'range', from, to, practitionerId ?? ''],
    queryFn: () => api.get<{ items: TimeOff[] }>('/time-off', { from, to, practitionerId: practitionerId || undefined }),
    enabled: !!from && !!to,
    staleTime: 60_000,
  });
}

/** The part of a time-off period that falls on one clinic-local date, in minutes from midnight. */
export function offSegment(o: TimeOff, date: string): { start: number; end: number } | null {
  if (date < o.startDate || date > o.endDate) return null;
  const start = date === o.startDate && !o.allDay ? timeToMinutes(o.startTime) : 0;
  const end = date === o.endDate && !o.allDay ? timeToMinutes(o.endTime) : 24 * 60;
  return end > start ? { start, end } : null;
}

export function useTimeOffText() {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  return {
    kind: (kind: string | null) => (kind ? tx(`off.kind.${kind}`, undefined, kind) : t('off.unavailable')),
    period: (o: { allDay: boolean | number; startDate: string; endDate: string; startTime: string; endTime: string }) =>
      o.allDay
        ? o.startDate === o.endDate
          ? fmt.day(o.startDate)
          : `${fmt.day(o.startDate)} – ${fmt.day(o.endDate)}`
        : `${fmt.day(o.startDate)} · ${o.startTime}–${o.endTime}`,
  };
}

// ---------------------------------------------------------------- list (Appointments → Time off)
export function TimeOffView() {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const { can } = useSession();
  const text = useTimeOffText();
  const [practitionerId, setPractitionerId] = useState('');
  const [past, setPast] = useState(false);
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['time-off', 'list', practitionerId, past],
    queryFn: () => api.get<{ items: TimeOff[] }>('/time-off', { practitionerId, past: past ? 1 : undefined, includeCancelled: past ? 1 : undefined }),
  });
  return (
    <Panel
      title={t('off.title')}
      flush
      actions={
        can('appointments.manage') && (
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setCreate(true)}>
            {t('off.new')}
          </Button>
        )
      }
    >
      <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 12 }}>
        <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('appt.practitioner')} value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}>
          <option value="">{t('appt.filters.practitioner')}</option>
          {ref.data?.practitioners.map((p) => (
            <option key={p.id} value={p.id}>
              {pick(p.displayName, p.displayNameAr)}
            </option>
          ))}
        </select>
        <Checkbox label={t('off.showPast')} checked={past} onChange={setPast} />
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState icon={<CalendarOff size={22} />} title={t('off.empty')} hint={t('off.emptyHint')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('appt.practitioner')}</th>
                <th>{t('off.kind')}</th>
                <th>{t('off.period')}</th>
                <th>{t('appt.title')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((o) => (
                <tr key={o.id} className="clickable" tabIndex={0} onClick={() => setDetail(o.id)} onKeyDown={(e) => e.key === 'Enter' && setDetail(o.id)} style={{ opacity: o.status === 'cancelled' ? 0.6 : 1 }}>
                  <td className="nowrap">
                    <span className="row">
                      <span className="color-dot" style={{ background: ref.practitionerColor(o.practitionerId) }} />
                      <strong>{ref.practitionerName(o.practitionerId)}</strong>
                    </span>
                  </td>
                  <td>{text.kind(o.kind)}</td>
                  <td className="nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{text.period(o)}</td>
                  <td>{o.affectedCount > 0 ? <Badge tone="warning">{t('off.affected', { n: o.affectedCount })}</Badge> : <span className="muted">—</span>}</td>
                  <td>{o.status === 'cancelled' ? <Badge>{t('status.cancelled')}</Badge> : <Badge tone="success">{t('common.active')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {create && <TimeOffDialog onClose={() => setCreate(false)} />}
      {detail !== null && <TimeOffDetailDialog id={detail} onClose={() => setDetail(null)} />}
    </Panel>
  );
}

function AffectedList({ items, onOpen }: { items: Appointment[]; onOpen?: (id: number) => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  return (
    <ul className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((a) => {
        const label = (
          <>
            <span className="num">{fmt.dateShort(a.startAt)} · {fmt.time(a.startAt)}</span> — <strong>{a.masked ? t('appt.busy') : a.patientName}</strong> · {ref.serviceName(a.serviceId)}
          </>
        );
        return (
          <li key={a.id} className="small">
            {onOpen ? (
              <button type="button" className="link-btn" onClick={() => onOpen(a.id)}>
                {label}
              </button>
            ) : (
              label
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- record time off
export function TimeOffDialog({ prefill, onClose }: { prefill?: { practitionerId?: number; date?: string }; onClose: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const start = prefill?.date ?? fmt.today();
  const form = useForm(
    {
      practitionerId: prefill?.practitionerId ?? (null as number | null),
      kind: 'leave' as string,
      startDate: start,
      endDate: start,
      allDay: true,
      startTime: '',
      endTime: '',
      note: '',
    },
    timeOffSchema,
  );
  const v = form.values;
  const [affected, setAffected] = useState<Appointment[] | null>(null);
  const periodKey = JSON.stringify([v.practitionerId, v.startDate, v.endDate, v.allDay, v.startTime, v.endTime]);
  useEffect(() => setAffected(null), [periodKey]);
  const save = useAction((body: Record<string, unknown>) => api.post<{ id: number; affected: Appointment[] }>('/time-off', body), {
    success: t('off.created'),
    onSuccess: onClose,
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'TIME_OFF_AFFECTS_BOOKINGS') {
        setAffected(e.details?.affected ?? []);
        return true;
      }
      return form.applyServerError(e);
    },
  });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate({ ...d, confirmAffected: affected !== null });
  };
  const practitioners = (ref.data?.practitioners ?? []).filter((p) => p.active || p.id === v.practitionerId);
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={form.dirty && !save.isSuccess}
      title={t('off.new')}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={affected ? 'danger' : 'primary'} loading={save.isPending} onClick={submit}>
            {affected ? t('off.saveAnyway') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <SelectField label={t('appt.practitioner')} required value={v.practitionerId ?? ''} error={form.errors.practitionerId} placeholder={t('common.select')} onChange={(e) => form.set('practitionerId', e.target.value ? Number(e.target.value) : null)}>
          {practitioners.map((p) => (
            <option key={p.id} value={p.id}>
              {pick(p.displayName, p.displayNameAr)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('off.kind')} required value={v.kind} onChange={(e) => form.set('kind', e.target.value)}>
          {TIME_OFF_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`off.kind.${k}` as TKey)}
            </option>
          ))}
        </SelectField>
        <div className="span-2">
          <Checkbox label={t('off.allDay')} checked={v.allDay} onChange={(x) => form.set('allDay', x)} />
        </div>
        <TextField
          label={t('off.startDate')}
          type="date"
          required
          value={v.startDate}
          error={form.errors.startDate}
          onChange={(e) => {
            form.set('startDate', e.target.value);
            if (!v.allDay || e.target.value > v.endDate) form.set('endDate', e.target.value);
          }}
        />
        {v.allDay ? (
          <TextField label={t('off.endDate')} type="date" required min={v.startDate} value={v.endDate} error={form.errors.endDate} onChange={(e) => form.set('endDate', e.target.value)} />
        ) : (
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <TextField label={t('off.startTime')} type="time" required value={v.startTime} error={form.errors.startTime} onChange={(e) => form.set('startTime', e.target.value)} />
            <TextField label={t('off.endTime')} type="time" required value={v.endTime} error={form.errors.endTime ?? form.errors.endDate} onChange={(e) => form.set('endTime', e.target.value)} />
          </div>
        )}
        <TextArea className="span-2" label={t('off.note')} hint={t('off.noteHint')} rows={2} maxLength={200} value={v.note} error={form.errors.note} onChange={(e) => form.set('note', e.target.value)} />
        <div className="span-2">
          {affected ? (
            <Callout tone="warning" title={`${t('off.affectedTitle')} · ${affected.length}`}>
              <div className="stack tight">
                <AffectedList items={affected} />
                <span>{t('off.affectedConfirm')}</span>
              </div>
            </Callout>
          ) : (
            <Callout tone="info">{t('off.blocks')}</Callout>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- details / cancel
export function TimeOffDetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const text = useTimeOffText();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({ queryKey: ['time-off', id], queryFn: () => api.get<{ item: TimeOff; affected: Appointment[] }>(`/time-off/${id}`) });
  const cancel = useAction((reason: string) => api.post(`/time-off/${id}/cancel`, { reason }), { success: t('off.cancelled'), onSuccess: onClose });
  const o = q.data?.item;
  const active = o?.status === 'active';
  return (
    <Dialog
      open
      onClose={onClose}
      title={o ? `${text.kind(o.kind)} · ${ref.practitionerName(o.practitionerId)}` : t('off.label')}
      footer={
        <>
          {o && active && can('appointments.manage') && (
            <Button variant="danger" onClick={() => setConfirm(true)}>
              {t('off.cancel')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {o && (
        <div className="stack">
          <KV
            items={[
              [t('appt.practitioner'), ref.practitionerName(o.practitionerId)],
              [t('off.kind'), text.kind(o.kind)],
              [t('off.period'), <span className="num">{text.period(o)}</span>],
              ...(o.note ? ([[t('off.note'), o.note]] as [string, string][]) : []),
              [t('common.status'), active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('status.cancelled')}</Badge>],
            ]}
          />
          <div className="xs muted">
            {t('off.recordedBy', { name: o.createdByName ?? '—', date: fmt.dateTime(o.createdAt) })}
            {o.cancelledAt && (
              <div>
                {t('off.cancelledBy', { name: o.cancelledByName ?? '—', date: fmt.dateTime(o.cancelledAt) })}
                {o.cancelReason ? ` — ${o.cancelReason}` : ''}
              </div>
            )}
          </div>
          {active &&
            (q.data!.affected.length ? (
              <Callout tone="warning" title={`${t('off.affectedTitle')} · ${q.data!.affected.length}`}>
                <AffectedList
                  items={q.data!.affected}
                  onOpen={(apptId) => {
                    onClose();
                    actions.openAppointment(apptId);
                  }}
                />
              </Callout>
            ) : (
              <span className="small muted">{t('off.none')}</span>
            ))}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        danger
        title={t('off.cancel')}
        body={t('off.cancelBody')}
        reasonLabel={t('common.reason')}
        loading={cancel.isPending}
        onConfirm={(reason) => cancel.mutate(reason)}
        onCancel={() => setConfirm(false)}
      />
    </Dialog>
  );
}
