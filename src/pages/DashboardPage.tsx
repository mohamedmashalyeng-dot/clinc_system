import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, CreditCard, Info, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useUrlState } from '@/lib/hooks';
import { useI18n } from '@/i18n';
import { Button, Checkbox, EmptyState, ErrorState, Loading, Panel } from '@/components/ui';
import { DateRangeControl } from '@/components/pickers';
import { useActions } from '@/layout/actions';
import { ReceptionQueue, ScheduleRow } from './appointments/shared';
import { useTimeOff, useTimeOffText } from './appointments/TimeOff';
import type { Appointment } from '@/lib/types';

interface DashboardData {
  range: { from: string; to: string };
  scheduleDate: string;
  metrics: {
    appointments: number;
    cancelled: number;
    noShows: number;
    waiting: number;
    inTreatment: number;
    completedSessions: number;
    paymentsCollected?: number;
    refunds?: number;
    outstandingInRange?: number;
    outstandingInvoices?: number;
    outstandingAll?: number;
    packagesExpiring?: number;
    packageWindowEnd?: string;
    lowStock?: number;
    expiringBatches?: number;
    unbookedPackages?: number;
  };
  schedule: Appointment[];
}

export function DashboardPage() {
  const { t } = useI18n();
  const fmt = useFmt();
  const navigate = useNavigate();
  const { can, me } = useSession();
  const actions = useActions();
  const today = fmt.today();
  const [range, setRange] = useUrlState({ from: today, to: today });
  const [mine, setMine] = useState(me.user.role === 'practitioner' && !!me.user.practitionerId);
  const [showDefs, setShowDefs] = useState(false);
  const q = useQuery({
    queryKey: ['dashboard', range.from, range.to, mine],
    queryFn: () => api.get<DashboardData>('/dashboard', { from: range.from, to: range.to, practitionerId: mine ? me.user.practitionerId : undefined }),
    refetchInterval: 60_000,
  });
  const m = q.data?.metrics;
  const listLink = (extra: Record<string, string> = {}) => `/appointments?${new URLSearchParams({ view: 'list', from: range.from, to: range.to, ...extra })}`;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('dash.title')}</h1>
          <p className="sub">{range.from === range.to ? fmt.dayLong(range.from) : `${fmt.day(range.from)} – ${fmt.day(range.to)}`}</p>
        </div>
        <div className="toolbar">
          {can('patients.edit') && (
            <Button icon={<UserPlus size={16} />} onClick={() => actions.newPatient((id) => navigate(`/patients/${id}`))}>
              {t('dash.addPatient')}
            </Button>
          )}
          {can('appointments.manage') && (
            <Button variant="primary" icon={<CalendarPlus size={16} />} onClick={() => actions.book()}>
              {t('dash.book')}
            </Button>
          )}
          {can('payments.record') && (
            <Button icon={<CreditCard size={16} />} onClick={() => actions.collectPayment()}>
              {t('dash.collect')}
            </Button>
          )}
        </div>
      </div>

      <div className="row wrap between">
        <DateRangeControl from={range.from} to={range.to} onChange={(r) => setRange(r)} />
        <div className="row">
          {me.user.practitionerId && <Checkbox label={t('dash.mySchedule')} checked={mine} onChange={setMine} />}
          <Button size="sm" variant="ghost" icon={<Info size={15} />} aria-expanded={showDefs} onClick={() => setShowDefs((s) => !s)}>
            {t('dash.definitions')}
          </Button>
        </div>
      </div>
      {showDefs && <div className="callout callout-neutral small">{t('dash.def')}</div>}

      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {m && (
        <div className="metrics">
          <Metric label={t('dash.appointments')} value={fmt.num(m.appointments)} sub={t('dash.appointmentsSub', { cancelled: m.cancelled, noShows: m.noShows })} onClick={() => navigate(listLink())} />
          <Metric label={t('dash.waiting')} value={fmt.num(m.waiting)} tone={m.waiting ? 'warning' : undefined} onClick={() => navigate(listLink({ status: 'arrived' }))} />
          <Metric label={t('dash.inTreatment')} value={fmt.num(m.inTreatment)} onClick={() => navigate(listLink({ status: 'in_treatment' }))} />
          <Metric label={t('dash.completed')} value={fmt.num(m.completedSessions)} onClick={() => navigate(listLink({ status: 'completed' }))} />
          {m.paymentsCollected !== undefined && (
            <Metric
              label={t('dash.collected')}
              value={fmt.money(m.paymentsCollected)}
              sub={t('dash.collectedSub', { refunds: fmt.money(m.refunds ?? 0) })}
              onClick={() => navigate(`/billing?tab=payments&from=${range.from}&to=${range.to}`)}
            />
          )}
          {m.outstandingInRange !== undefined && (
            <Metric
              label={t('dash.outstanding')}
              value={fmt.money(m.outstandingInRange)}
              sub={t('dash.outstandingSub', { n: m.outstandingInvoices ?? 0, all: fmt.money(m.outstandingAll ?? 0) })}
              tone={m.outstandingInRange ? 'warning' : undefined}
              onClick={() => navigate(`/billing?status=outstanding&from=${range.from}&to=${range.to}`)}
            />
          )}
          {m.packagesExpiring !== undefined && (
            <Metric
              label={t('dash.packagesExpiring')}
              value={fmt.num(m.packagesExpiring)}
              sub={m.packageWindowEnd ? t('dash.packagesExpiringSub', { date: fmt.day(m.packageWindowEnd) }) : undefined}
              onClick={() => navigate(`/follow-up?tab=packages&until=${range.to}`)}
            />
          )}
          {m.unbookedPackages !== undefined && (
            <Metric label={t('dash.unbooked')} value={fmt.num(m.unbookedPackages)} sub={t('dash.unbookedSub')} tone={m.unbookedPackages ? 'warning' : undefined} onClick={() => navigate('/growth?tab=unbooked')} />
          )}
          {m.lowStock !== undefined && <Metric label={t('dash.lowStock')} value={fmt.num(m.lowStock)} tone={m.lowStock ? 'danger' : undefined} onClick={() => navigate('/inventory?filter=low')} />}
          {m.expiringBatches !== undefined && (
            <Metric label={t('dash.expiringItems')} value={fmt.num(m.expiringBatches)} tone={m.expiringBatches ? 'warning' : undefined} onClick={() => navigate('/inventory?filter=expiring')} />
          )}
        </div>
      )}

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
        <Panel title={`${t('dash.schedule')} · ${q.data ? fmt.dayShort(q.data.scheduleDate) : ''}`} flush actions={<Button size="sm" variant="ghost" onClick={() => navigate(`/appointments?view=day&date=${q.data?.scheduleDate ?? today}`)}>{t('appt.day')}</Button>}>
          {q.data && <OffOnDay date={q.data.scheduleDate} />}
          {q.data && !q.data.schedule.length && <EmptyState title={t('dash.scheduleEmpty')} />}
          {q.data?.schedule.map((a) => <ScheduleRow key={a.id} a={a} />)}
        </Panel>
        {can('appointments.view') && (
          <Panel title={t('dash.queue')} flush>
            <ReceptionQueue compact />
          </Panel>
        )}
      </div>
    </div>
  );
}

/** Who is away on the schedule day, so reception does not offer them. */
function OffOnDay({ date }: { date: string }) {
  const { t } = useI18n();
  const ref = useRef_();
  const fmt = useFmt();
  const text = useTimeOffText();
  const navigate = useNavigate();
  const q = useTimeOff(date, date);
  if (!q.data?.items.length) return null;
  return (
    <button type="button" className="link-btn small" style={{ display: 'block', width: '100%', textAlign: 'start', padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--warning)' }} onClick={() => navigate('/appointments?view=timeoff')}>
      {date === fmt.today() ? t('off.today') : t('off.label')}:{' '}
      {q.data.items.map((o) => `${ref.practitionerName(o.practitionerId)} (${text.kind(o.kind)}${o.allDay ? '' : ` ${o.startTime}–${o.endTime}`})`).join(' · ')}
    </button>
  );
}

function Metric({ label, value, sub, onClick, tone }: { label: string; value: string; sub?: string; onClick: () => void; tone?: 'warning' | 'danger' }) {
  return (
    <button className={`metric ${tone ? `tone-${tone}` : ''}`} onClick={onClick}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {sub && <span className="metric-sub">{sub}</span>}
    </button>
  );
}
