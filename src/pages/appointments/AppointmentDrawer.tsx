import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, CalendarClock, CalendarPlus, CheckCheck, CreditCard, FileText, LogIn, Stethoscope, Undo2, UserX } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, ErrorState, KV, Loading, PayBadge, StatusBadge, TextArea } from '@/components/ui';
import { Dialog, Drawer } from '@/components/overlays';
import { useActions } from '@/layout/actions';
import { useStartTreatment, useStatusChange } from './shared';
import { WaitlistMatches } from './Waitlist';
import { useRiskText } from '@/components/insights';
import type { Appointment } from '@/lib/types';
import type { TKey } from '@/i18n/en';
import { STATUS_TRANSITIONS } from '@shared/domain';

interface Detail {
  appointment: Appointment;
  events: { kind: string; fromStatus: string | null; toStatus: string | null; reason: string | null; createdAt: string; byName: string | null }[];
  lateCancellation: boolean;
}

export function AppointmentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { t, tx, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can, me } = useSession();
  const actions = useActions();
  const q = useQuery({ queryKey: ['appointment', id], queryFn: () => api.get<Detail>(`/appointments/${id}`) });
  const status = useStatusChange();
  const start = useStartTreatment();
  const [cancelMode, setCancelMode] = useState<'cancelled' | 'no_show' | null>(null);
  const ensureInvoice = useAction((v: { kind: 'deposit' | 'payment'; amount?: number }) => api.post<{ invoiceId: number }>(`/appointments/${id}/invoice`).then((r) => ({ ...r, ...v })), {
    onSuccess: (r) => actions.recordPayment({ invoiceId: r.invoiceId, kind: r.kind, suggestedAmount: r.amount }),
  });

  const a = q.data?.appointment;
  const allowed = a ? STATUS_TRANSITIONS[a.status] : [];
  const isToday = a ? fmt.localDate(a.startAt) === fmt.today() : false;
  const started = a ? new Date(a.startAt).getTime() <= Date.now() : false;
  const svc = a ? ref.services.get(a.serviceId) : undefined;
  const riskText = useRiskText();

  return (
    <Drawer
      open
      onClose={onClose}
      title={a ? (a.masked ? t('appt.hiddenPatient') : a.patientName) : t('common.loading')}
      subtitle={a ? `${fmt.dayLong(fmt.localDate(a.startAt))} · ${fmt.time(a.startAt)}–${fmt.time(a.endAt)}` : undefined}
      actions={a && <StatusBadge status={a.status} />}
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {a && (
        <div className="stack loose">
          {!a.masked && (
            <div className="toolbar">
              {allowed.includes('confirmed') && a.status === 'booked' && can('appointments.checkin') && (
                <Button size="sm" icon={<CheckCheck size={15} />} loading={status.isPending} onClick={() => status.mutate({ id, status: 'confirmed' })}>
                  {t('appt.confirm')}
                </Button>
              )}
              {allowed.includes('arrived') && isToday && can('appointments.checkin') && (
                <Button size="sm" variant="primary" icon={<LogIn size={15} className="flip-rtl" />} loading={status.isPending} onClick={() => status.mutate({ id, status: 'arrived' })}>
                  {a.status === 'in_treatment' ? t('appt.backToWaiting') : t('appt.checkIn')}
                </Button>
              )}
              {(a.status === 'arrived' || a.status === 'in_treatment' || a.status === 'completed') && can('treatment.perform') && (
                <Button size="sm" variant={a.status === 'completed' ? 'default' : 'primary'} icon={<Stethoscope size={15} />} loading={start.isPending} onClick={() => start.mutate(id)}>
                  {a.status === 'arrived' ? t('appt.startTreatment') : t('appt.openWorkspace')}
                </Button>
              )}
              {a.status === 'arrived' && !can('treatment.perform') && can('appointments.checkin') && (
                <Button size="sm" icon={<Stethoscope size={15} />} loading={status.isPending} onClick={() => status.mutate({ id, status: 'in_treatment' })}>
                  {t('appt.markInTreatment')}
                </Button>
              )}
              {a.status === 'arrived' && can('appointments.checkin') && (
                <Button size="sm" variant="ghost" icon={<Undo2 size={15} />} loading={status.isPending} onClick={() => status.mutate({ id, status: 'confirmed' })}>
                  {t('appt.undoCheckIn')}
                </Button>
              )}
              {(a.status === 'booked' || a.status === 'confirmed') && can('appointments.manage') && (
                <Button size="sm" icon={<CalendarClock size={15} />} onClick={() => { actions.reschedule(a); onClose(); }}>
                  {t('appt.edit')}
                </Button>
              )}
              {allowed.includes('no_show') && started && can('appointments.manage') && (
                <Button size="sm" variant="ghost" icon={<UserX size={15} />} onClick={() => setCancelMode('no_show')}>
                  {t('appt.noShow')}
                </Button>
              )}
              {allowed.includes('cancelled') && can('appointments.manage') && (
                <Button size="sm" variant="ghost" icon={<Ban size={15} />} onClick={() => setCancelMode('cancelled')}>
                  {t('appt.cancel')}
                </Button>
              )}
            </div>
          )}

          {a.noShowRisk && (
            <Callout tone="warning" title={a.noShowRisk.level === 'high' ? t('risk.high') : t('risk.medium')}>
              {riskText(a.noShowRisk)}. {t('risk.advice')}
            </Callout>
          )}
          {a.status === 'cancelled' && !a.masked && <WaitlistMatches appointmentId={a.id} />}

          <KV
            items={[
              [t('appt.patient'), a.patientId ? <Link to={`/patients/${a.patientId}`} onClick={onClose}>{a.patientName} <span className="muted xs">{a.patientCode}</span></Link> : t('appt.busy')],
              [t('pat.phone'), a.patientPhone ? <span className="ltr">{a.patientPhone}</span> : '—'],
              [t('appt.service'), ref.serviceName(a.serviceId)],
              [t('appt.practitioner'), <span className="row"><span className="color-dot" style={{ background: ref.practitionerColor(a.practitionerId) }} />{ref.practitionerName(a.practitionerId)}</span>],
              [t('appt.room'), ref.roomName(a.roomId)],
              [t('appt.device'), a.deviceId ? ref.deviceName(a.deviceId) : t('appt.noDevice')],
              [t('appt.duration'), `${t('common.minutes', { n: svc?.durationMin ?? 0 })} (+${a.bufferBeforeMin}/${a.bufferAfterMin} ${t('common.min')})`],
              [t('appt.package'), a.purchasedPackageId ? pick(a.packageEn, a.packageAr) : t('appt.noPackage')],
              ...(a.notes ? ([[t('appt.notes'), <span className="pre-wrap">{a.notes}</span>]] as [string, React.ReactNode][]) : []),
              ...(a.cancelReason ? ([[t('common.reason'), a.cancelReason]] as [string, React.ReactNode][]) : []),
              ...(a.sessionStatus === 'reversed' ? ([[t('tp.sessions'), <Badge tone="warning">{t('appt.sessionReversed')}</Badge>]] as [string, React.ReactNode][]) : []),
            ]}
          />

          {a.payment && (
            <div className="subtle-box stack tight">
              <div className="row between">
                <span className="strong">{t('appt.payment')}</span>
                <PayBadge state={a.payment.state} />
              </div>
              {a.payment.invoiceId && (
                <div className="small muted">
                  {t('bill.paid')}: {fmt.money(a.payment.paid)} · {t('bill.balance')}: {fmt.money(a.payment.balance)}
                </div>
              )}
              {a.depositAmount > 0 && !a.purchasedPackageId && <div className="small muted">{t('appt.depositRequired', { amount: fmt.money(a.depositAmount) })}</div>}
              <div className="toolbar">
                {can('payments.record') && a.payment.state === 'deposit_due' && !['cancelled', 'no_show'].includes(a.status) && (
                  <Button size="sm" variant="soft" icon={<CreditCard size={15} />} loading={ensureInvoice.isPending} onClick={() => ensureInvoice.mutate({ kind: 'deposit', amount: a.depositAmount })}>
                    {t('appt.collectDeposit')}
                  </Button>
                )}
                {can('payments.record') && a.payment.state !== 'package' && a.payment.state !== 'paid' && !['cancelled', 'no_show'].includes(a.status) && (
                  <Button size="sm" variant="soft" icon={<CreditCard size={15} />} loading={ensureInvoice.isPending} onClick={() => ensureInvoice.mutate({ kind: 'payment' })}>
                    {t('appt.collectPayment')}
                  </Button>
                )}
                {a.payment.invoiceId && (
                  <Button size="sm" variant="ghost" icon={<FileText size={15} />} onClick={() => actions.openInvoice(a.payment!.invoiceId!)}>
                    {t('appt.viewInvoice')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {!a.masked && can('appointments.manage') && a.patientId && (
            <Button
              size="sm"
              icon={<CalendarPlus size={15} />}
              onClick={() => {
                actions.book({ patient: { id: a.patientId!, fullName: a.patientName ?? '', phone: a.patientPhone ?? undefined }, serviceId: a.serviceId, practitionerId: a.practitionerId });
                onClose();
              }}
            >
              {t('appt.bookNext')}
            </Button>
          )}

          {q.data!.events.length > 0 && (
            <div className="stack tight">
              <h3 className="section-title">{t('appt.timeline')}</h3>
              <ul className="timeline">
                {q.data!.events.map((e, i) => (
                  <li key={i}>
                    <div className="grow">
                      <div>{e.kind === 'status' && e.toStatus ? t('appt.ev.status', { status: tx(`status.${e.toStatus}`) }) : tx(`appt.ev.${e.kind}`, undefined, e.kind)}</div>
                      {e.reason && <div className="small muted">{e.reason}</div>}
                    </div>
                    <div className="when">
                      {fmt.dateTime(e.createdAt)}
                      {e.byName && <div>{e.byName}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {cancelMode && (
            <CancelDialog
              appointment={a}
              mode={cancelMode}
              late={q.data!.lateCancellation}
              policyHours={me.settings.cancellation.minNoticeHours}
              onClose={() => setCancelMode(null)}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}

function CancelDialog({ appointment: a, mode, late, policyHours, onClose }: { appointment: Appointment; mode: 'cancelled' | 'no_show'; late: boolean; policyHours: number; onClose: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const { can, me } = useSession();
  const policy = me.settings.cancellation;
  const depositPaid = (a.payment?.paid ?? 0) > 0;
  const policyRetains = mode === 'no_show' ? policy.noShowDeposit === 'retain' : late && policy.lateCancelDeposit === 'retain';
  const [reason, setReason] = useState('');
  const [deposit, setDeposit] = useState<'none' | 'refund' | 'retain'>(policyRetains ? 'retain' : can('refunds.issue') ? 'refund' : 'none');
  const status = useStatusChange(onClose);
  const canRetain = policyRetains || can('invoices.adjust');
  return (
    <Dialog
      open
      onClose={onClose}
      size="narrow"
      title={mode === 'cancelled' ? t('appt.cancelTitle') : t('appt.noShowTitle')}
      subtitle={`${a.patientName} · ${fmt.dateTime(a.startAt)}`}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" disabled={!reason.trim()} loading={status.isPending} onClick={() => status.mutate({ id: a.id, status: mode, reason: reason.trim(), depositAction: depositPaid ? deposit : 'none' })}>
            {mode === 'cancelled' ? t('appt.cancel') : t('appt.noShow')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {mode === 'cancelled' && late && <Callout tone="warning">{t('appt.lateCancel', { hours: policyHours })}</Callout>}
        {a.purchasedPackageId && <Callout tone="info">{t('appt.packageSafe')}</Callout>}
        <TextArea label={t('appt.cancelReason')} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('appt.reasonPlaceholder')} data-autofocus />
        {depositPaid && (
          <fieldset className="stack tight">
            <legend className="field-label">{t('appt.depositHandling', { amount: fmt.money(a.payment!.paid) })}</legend>
            {(
              [
                ['retain', t('appt.depositRetain'), !canRetain],
                ['refund', t('appt.depositRefund'), !can('refunds.issue')],
                ['none', t('appt.depositLater'), false],
              ] as [typeof deposit, string, boolean][]
            ).map(([v, label, disabled]) => (
              <label key={v} className="check" style={{ opacity: disabled ? 0.5 : 1 }}>
                <input type="radio" name="deposit" value={v} checked={deposit === v} disabled={disabled} onChange={() => setDeposit(v)} />
                <span>
                  {label}
                  {v === 'refund' && disabled && <span className="xs muted"> — {t('appt.depositRefundNoPerm')}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {(policy.policyTextEn || policy.policyTextAr) && (
          <div className="small muted">
            <strong>{t('appt.policy')}: </strong>
            {pick(policy.policyTextEn, policy.policyTextAr)}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function useStatusLabel() {
  const { t } = useI18n();
  return (s: string) => t(`status.${s}` as TKey);
}
