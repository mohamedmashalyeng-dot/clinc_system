import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { DoorOpen, LogIn, Stethoscope } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useToast } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, EmptyState, ErrorState, Loading, PayBadge, StatusBadge } from '@/components/ui';
import { useActions } from '@/layout/actions';
import type { Appointment } from '@/lib/types';
import type { AppointmentStatus } from '@shared/domain';
import type { TKey } from '@/i18n/en';

export interface StatusChange {
  id: number;
  status: AppointmentStatus;
  reason?: string | null;
  depositAction?: 'none' | 'refund' | 'retain';
}

export function useStatusChange(onDone?: () => void) {
  const { t } = useI18n();
  const toast = useToast();
  return useAction(
    (v: StatusChange) => api.post<{ ok: boolean; depositOutcome?: string }>(`/appointments/${v.id}/status`, { status: v.status, reason: v.reason ?? null, depositAction: v.depositAction }),
    {
      onSuccess: (_r, v) => {
        toast.success(t('appt.statusChanged', { status: t(`status.${v.status}` as TKey) }));
        onDone?.();
      },
    },
  );
}

/** Starts (or reopens) the session record and goes to the workspace. */
export function useStartTreatment() {
  const navigate = useNavigate();
  return useAction((appointmentId: number) => api.post<{ sessionId: number }>(`/appointments/${appointmentId}/session`), {
    onSuccess: (_r, id) => navigate(`/workspace/${id}`),
  });
}

export function ScheduleRow({ a, showDate }: { a: Appointment; showDate?: boolean }) {
  const ref = useRef_();
  const fmt = useFmt();
  const { t } = useI18n();
  const { can } = useSession();
  const actions = useActions();
  const status = useStatusChange();
  const start = useStartTreatment();
  const today = fmt.today();
  const isToday = fmt.localDate(a.startAt) === today;
  return (
    <div className="sched-item" role="button" tabIndex={0} onClick={() => actions.openAppointment(a.id)} onKeyDown={(e) => e.key === 'Enter' && actions.openAppointment(a.id)}>
      <div className="num">
        <div className="strong">{fmt.time(a.startAt)}</div>
        <div className="xs muted">{showDate ? fmt.dateShort(a.startAt) : fmt.time(a.endAt)}</div>
      </div>
      <span className="sched-bar" style={{ background: ref.practitionerColor(a.practitionerId) }} aria-hidden />
      <div style={{ minWidth: 0 }}>
        <div className="strong truncate">{a.masked ? t('appt.busy') : a.patientName}</div>
        <div className="small muted truncate">
          {ref.serviceName(a.serviceId)} · {ref.practitionerName(a.practitionerId)} · {ref.roomName(a.roomId)}
        </div>
      </div>
      <div className="row wrap" style={{ justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
        <StatusBadge status={a.status} />
        {a.payment && <PayBadge state={a.payment.state} />}
        {isToday && (a.status === 'booked' || a.status === 'confirmed') && can('appointments.checkin') && !a.masked && (
          <Button size="xs" variant="soft" icon={<LogIn size={13} className="flip-rtl" />} loading={status.isPending && status.variables?.id === a.id} onClick={() => status.mutate({ id: a.id, status: 'arrived' })}>
            {t('queue.checkIn')}
          </Button>
        )}
        {(a.status === 'arrived' || a.status === 'in_treatment') && can('treatment.perform') && !a.masked && (
          <Button size="xs" variant="primary" icon={<Stethoscope size={13} />} loading={start.isPending && start.variables === a.id} onClick={() => start.mutate(a.id)}>
            {a.status === 'arrived' ? t('queue.start') : t('queue.openWorkspace')}
          </Button>
        )}
      </div>
    </div>
  );
}

interface QueueData {
  waiting: Appointment[];
  inTreatment: Appointment[];
  expected: Appointment[];
}

export function ReceptionQueue({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const status = useStatusChange();
  const start = useStartTreatment();
  const q = useQuery({ queryKey: ['queue'], queryFn: () => api.get<QueueData>('/appointments/queue'), refetchInterval: 30_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { waiting, inTreatment, expected } = q.data!;
  const now = Date.now();
  const group = (title: TKey, list: Appointment[], kind: 'waiting' | 'treatment' | 'expected') => (
    <div>
      <div className="section-title" style={{ padding: '12px 14px 4px' }}>
        {t(title)} · {list.length}
      </div>
      {!list.length && kind === 'waiting' && <div className="small muted" style={{ padding: '4px 14px 12px' }}>{t('queue.empty')}</div>}
      {(compact && kind === 'expected' ? list.slice(0, 4) : list).map((a, i) => (
        <div key={a.id} className="queue-item">
          {kind === 'waiting' ? <span className="queue-pos">{i + 1}</span> : <span className="color-dot" style={{ background: ref.practitionerColor(a.practitionerId) }} aria-hidden />}
          <button className="link-btn grow" style={{ color: 'inherit', minWidth: 0 }} onClick={() => actions.openAppointment(a.id)}>
            <div className="strong truncate">{a.masked ? t('appt.busy') : a.patientName}</div>
            <div className="xs muted truncate">
              {fmt.time(a.startAt)} · {ref.serviceName(a.serviceId)} · {ref.practitionerName(a.practitionerId)}
            </div>
            {kind === 'waiting' && a.arrivedAt && (
              <div className="xs" style={{ color: now - new Date(a.arrivedAt).getTime() > 15 * 60000 ? 'var(--danger)' : 'var(--warning)' }}>
                {t('queue.arrivedAt', { time: fmt.time(a.arrivedAt) })} · {t('queue.waitingFor', { n: Math.max(0, Math.round((now - new Date(a.arrivedAt).getTime()) / 60000)) })}
              </div>
            )}
          </button>
          {kind === 'expected' && can('appointments.checkin') && !a.masked && (
            <Button size="xs" variant="soft" icon={<DoorOpen size={13} />} loading={status.isPending && status.variables?.id === a.id} onClick={() => status.mutate({ id: a.id, status: 'arrived' })}>
              {t('queue.checkIn')}
            </Button>
          )}
          {kind !== 'expected' && can('treatment.perform') && !a.masked && (
            <Button size="xs" variant={kind === 'waiting' ? 'primary' : 'default'} loading={start.isPending && start.variables === a.id} onClick={() => start.mutate(a.id)}>
              {kind === 'waiting' ? t('queue.start') : t('queue.openWorkspace')}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
  if (!waiting.length && !inTreatment.length && !expected.length) return <EmptyState title={t('queue.empty')} />;
  return (
    <div>
      {group('queue.waiting', waiting, 'waiting')}
      {group('queue.inTreatment', inTreatment, 'treatment')}
      {group('queue.expected', expected, 'expected')}
    </div>
  );
}

export function statusLabel(t: (k: TKey) => string, s: AppointmentStatus) {
  return t(`status.${s}` as TKey);
}
