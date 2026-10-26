import { useQuery } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, EmptyState, ErrorState, Loading, Panel, PayBadge, StatusBadge } from '@/components/ui';
import { useActions } from '@/layout/actions';
import type { PatientRef } from '@/components/pickers';
import type { Appointment } from '@/lib/types';

export function AppointmentsTab({ patientId, patient }: { patientId: number; patient: PatientRef }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const q = useQuery({
    queryKey: ['patient-appointments', patientId],
    queryFn: () => api.get<{ items: (Appointment & { patientId: number })[] }>(`/patients/${patientId}/appointments`),
  });
  return (
    <Panel
      title={t('tab.appointments')}
      flush
      actions={
        can('appointments.manage') && (
          <Button size="sm" variant="primary" icon={<CalendarPlus size={15} />} onClick={() => actions.book({ patient })}>
            {t('pat.book')}
          </Button>
        )
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('appt.empty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('appt.service')}</th>
                <th>{t('appt.practitioner')}</th>
                <th>{t('appt.room')}</th>
                <th>{t('appt.package')}</th>
                <th>{t('common.status')}</th>
                <th>{t('appt.payment')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((a) => (
                <tr key={a.id} className="clickable" tabIndex={0} onClick={() => actions.openAppointment(a.id)} onKeyDown={(e) => e.key === 'Enter' && actions.openAppointment(a.id)}>
                  <td className="nowrap num">{fmt.dateTime(a.startAt)}</td>
                  <td>{ref.serviceName(a.serviceId)}</td>
                  <td className="nowrap">{ref.practitionerName(a.practitionerId)}</td>
                  <td className="small">{ref.roomName(a.roomId)}</td>
                  <td className="small">{a.purchasedPackageId ? pick(a.packageEn, a.packageAr) || `#${a.purchasedPackageId}` : '—'}</td>
                  <td>
                    <StatusBadge status={a.status} />
                    {a.cancelReason && <div className="xs muted">{a.cancelReason}</div>}
                  </td>
                  <td>{a.payment ? <PayBadge state={a.payment.state} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
