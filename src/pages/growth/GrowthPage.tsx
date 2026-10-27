import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Cake, CalendarPlus, CreditCard, Download, Hourglass, Info, MessageSquare, Package, Repeat, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { downloadCsv, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, EmptyState, ErrorState, Loading, Panel, Segmented, Tabs } from '@/components/ui';
import { useActions } from '@/layout/actions';
import { ComposeDialog, type Compose, type Contactable } from '@/pages/followup/ComposeDialog';
import { diffDays } from '@shared/time';

interface Contact {
  patientId: number;
  patientName: string;
  phone: string;
  contactChannel: string;
  allowReminders: boolean;
  allowMarketing: boolean;
  preferredLanguage: string;
  lastContactAt: string | null;
}

interface GrowthData {
  today: string;
  lapsedDays: number;
  summary: {
    prepaidOutstanding: { sessions: number; value: number } | null;
    unbookedValue: number | null;
    lapsedValue: number | null;
    collectTotal: number | null;
  };
  unbooked: (Contact & { packageId: number; nameEn: string; nameAr: string; remaining: number; total: number; expiryDate: string; daysToExpiry: number; serviceId: number | null; value: number; lastVisit: string | null })[] | null;
  due: (Contact & { serviceId: number; lastSession: string; sessions: number; intervalDays: number; basis: 'plan' | 'typical'; dueDate: string; overdueDays: number })[];
  lapsed: (Contact & { lastVisit: string; daysSince: number; visits: number; lastServiceId: number | null; lifetimeValue: number | null })[];
  renewals: (Contact & { packageId: number; templateId: number; nameEn: string; nameAr: string; remaining: number; total: number; state: string; expiryDate: string })[] | null;
  birthdays: (Contact & { date: string; inDays: number; turning: number | null })[];
  collect: (Contact & { outstanding: number; appointmentId: number; nextVisit: string })[] | null;
}

type Tab = 'unbooked' | 'due' | 'lapsed' | 'renewals' | 'birthdays' | 'collect';

export function GrowthPage() {
  const { t } = useI18n();
  const fmt = useFmt();
  const [s, set] = useUrlState({ tab: '', days: '90' });
  const [compose, setCompose] = useState<Compose | null>(null);
  const [showDefs, setShowDefs] = useState(false);
  const q = useQuery({ queryKey: ['growth', s.days], queryFn: () => api.get<GrowthData>('/growth', { lapsedDays: s.days }), placeholderData: (p) => p });
  const d = q.data;
  const tabs: { id: Tab; label: string; count?: number }[] = d
    ? [
        ...(d.unbooked ? [{ id: 'unbooked' as Tab, label: t('gr.tab.unbooked'), count: d.unbooked.length }] : []),
        { id: 'due', label: t('gr.tab.due'), count: d.due.length },
        { id: 'lapsed', label: t('gr.tab.lapsed'), count: d.lapsed.length },
        ...(d.renewals ? [{ id: 'renewals' as Tab, label: t('gr.tab.renewals'), count: d.renewals.length }] : []),
        { id: 'birthdays', label: t('gr.tab.birthdays'), count: d.birthdays.length },
        ...(d.collect ? [{ id: 'collect' as Tab, label: t('gr.tab.collect'), count: d.collect.length }] : []),
      ]
    : [];
  const tab = (tabs.find((x) => x.id === s.tab)?.id ?? tabs[0]?.id ?? 'due') as Tab;
  const go = (x: Tab) => set({ tab: x });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('gr.title')}</h1>
          <p className="sub">{t('gr.sub')}</p>
        </div>
        <Button size="sm" variant="ghost" icon={<Info size={15} />} aria-expanded={showDefs} onClick={() => setShowDefs((v) => !v)}>
          {t('dash.definitions')}
        </Button>
      </div>
      {showDefs && (
        <div className="callout callout-neutral small stack tight">
          <span>{t('gr.def.unbooked')}</span>
          <span>{t('gr.def.due')}</span>
          <span>{t('gr.def.lapsed')}</span>
          <span>{t('gr.def.renewals')}</span>
          <span>{t('gr.def.messages')}</span>
        </div>
      )}
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <>
          <div className="metrics">
            {d.summary.prepaidOutstanding && (
              <Kpi icon={<Package size={15} />} label={t('gr.k.prepaid')} value={fmt.money(d.summary.prepaidOutstanding.value)} sub={t('gr.k.prepaidSub', { n: d.summary.prepaidOutstanding.sessions })} />
            )}
            {d.unbooked && (
              <Kpi icon={<CalendarPlus size={15} />} label={t('gr.k.unbooked')} value={fmt.num(d.unbooked.length)} sub={d.summary.unbookedValue !== null ? t('gr.k.unbookedSub', { value: fmt.money(d.summary.unbookedValue) }) : undefined} tone={d.unbooked.length ? 'warning' : undefined} onClick={() => go('unbooked')} />
            )}
            <Kpi icon={<Repeat size={15} />} label={t('gr.k.due')} value={fmt.num(d.due.length)} sub={t('gr.k.dueSub')} onClick={() => go('due')} />
            <Kpi
              icon={<Hourglass size={15} />}
              label={t('gr.k.lapsed', { days: d.lapsedDays })}
              value={fmt.num(d.lapsed.length)}
              sub={d.summary.lapsedValue !== null ? t('gr.k.lapsedSub', { value: fmt.money(d.summary.lapsedValue) }) : undefined}
              onClick={() => go('lapsed')}
            />
            {d.collect && d.summary.collectTotal !== null && (
              <Kpi icon={<Wallet size={15} />} label={t('gr.k.collect')} value={fmt.money(d.summary.collectTotal)} sub={t('gr.k.collectSub', { n: d.collect.length })} onClick={() => go('collect')} />
            )}
            <Kpi icon={<Cake size={15} />} label={t('gr.k.birthdays')} value={fmt.num(d.birthdays.length)} onClick={() => go('birthdays')} />
          </div>

          <Tabs label={t('gr.title')} tabs={tabs.map((x) => ({ id: x.id, label: x.label, count: x.count }))} value={tab} onChange={go} />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'unbooked' && d.unbooked && <Unbooked rows={d.unbooked} today={d.today} onCompose={setCompose} />}
            {tab === 'due' && <Due rows={d.due} today={d.today} onCompose={setCompose} />}
            {tab === 'lapsed' && <Lapsed rows={d.lapsed} today={d.today} days={s.days} onDays={(days) => set({ days })} onCompose={setCompose} />}
            {tab === 'renewals' && d.renewals && <Renewals rows={d.renewals} today={d.today} onCompose={setCompose} />}
            {tab === 'birthdays' && <Birthdays rows={d.birthdays} today={d.today} onCompose={setCompose} />}
            {tab === 'collect' && d.collect && <Collect rows={d.collect} today={d.today} />}
          </div>
        </>
      )}
      {compose && <ComposeDialog c={compose} onClose={() => setCompose(null)} />}
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone, onClick }: { icon: ReactNode; label: string; value: string; sub?: string; tone?: 'warning'; onClick?: () => void }) {
  const body = (
    <>
      <span className="metric-label">
        {icon} {label}
      </span>
      <span className="metric-value">{value}</span>
      {sub && <span className="metric-sub">{sub}</span>}
    </>
  );
  return onClick ? (
    <button className={`metric ${tone ? `tone-${tone}` : ''}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="metric" style={{ cursor: 'default' }}>
      {body}
    </div>
  );
}

const who = (c: Contact): Contactable => ({ ...c });

function Who({ c, today }: { c: Contact; today: string }) {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const opted = !c.allowReminders || c.contactChannel === 'none';
  const contacted = c.lastContactAt ? diffDays(fmt.localDate(c.lastContactAt), today) : null;
  return (
    <div>
      <Link to={`/patients/${c.patientId}`} className="strong">
        {c.patientName}
      </Link>
      <div className="xs muted">
        <span className="ltr">{c.phone}</span> · {tx(`pat.channel.${c.contactChannel}`)}
      </div>
      <div className="row wrap" style={{ gap: 4, marginTop: 2 }}>
        {opted && <Badge tone="warning">{c.contactChannel === 'none' ? t('fu.noContact') : t('fu.optedOut')}</Badge>}
        {contacted !== null && contacted <= 14 && <Badge tone="outline">{contacted === 0 ? t('gr.contactedToday') : t('gr.contactedAgo', { n: contacted })}</Badge>}
      </div>
    </div>
  );
}

function ListPanel({ title, hint, empty, csv, csvRows, children, actions }: { title: string; hint: string; empty: boolean; csv: string; csvRows: () => (string | number | null)[][]; children: ReactNode; actions?: ReactNode }) {
  const { t } = useI18n();
  return (
    <Panel
      flush
      title={title}
      actions={
        <>
          {actions}
          {!empty && (
            <Button size="xs" variant="ghost" icon={<Download size={13} />} onClick={() => downloadCsv(`${csv}.csv`, csvRows())}>
              {t('common.download')}
            </Button>
          )}
        </>
      }
    >
      <p className="xs muted" style={{ padding: '10px 14px 0' }}>
        {hint}
      </p>
      {empty ? <EmptyState title={t('gr.empty')} /> : <div className="table-wrap">{children}</div>}
    </Panel>
  );
}

function MessageBtn({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  if (!can('followup.manage')) return null;
  return (
    <Button size="xs" variant="soft" icon={<MessageSquare size={13} />} onClick={onClick}>
      {t('fu.prepare')}
    </Button>
  );
}

function BookBtn({ c, serviceId, packageId }: { c: Contact; serviceId?: number | null; packageId?: number }) {
  const { t } = useI18n();
  const { can } = useSession();
  const actions = useActions();
  if (!can('appointments.manage')) return null;
  return (
    <Button size="xs" variant="ghost" icon={<CalendarPlus size={13} />} onClick={() => actions.book({ patient: { id: c.patientId, fullName: c.patientName, phone: c.phone }, serviceId: serviceId ?? undefined, purchasedPackageId: packageId })}>
      {t('pat.book')}
    </Button>
  );
}

function Unbooked({ rows, today, onCompose }: { rows: NonNullable<GrowthData['unbooked']>; today: string; onCompose: (c: Compose) => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  return (
    <ListPanel
      title={t('gr.tab.unbooked')}
      hint={t('gr.def.unbooked')}
      empty={!rows.length}
      csv={`prepaid-unbooked_${today}`}
      csvRows={() => [
        [t('appt.patient'), t('pat.phone'), t('pkg.template'), t('pkg.remaining'), t('pkg.expiry'), t('gr.value')],
        ...rows.map((r) => [r.patientName, r.phone, pick(r.nameEn, r.nameAr), r.remaining, r.expiryDate, r.value / 100]),
      ]}
    >
      <table className="table">
        <thead>
          <tr>
            <th>{t('appt.patient')}</th>
            <th>{t('pkg.template')}</th>
            <th className="num">{t('pkg.remaining')}</th>
            <th>{t('pkg.expiry')}</th>
            <th className="num">{t('gr.value')}</th>
            <th>{t('pat.lastVisit')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.packageId}>
              <td>
                <Who c={r} today={today} />
              </td>
              <td className="small">{pick(r.nameEn, r.nameAr)}</td>
              <td className="num strong">
                {r.remaining}/{r.total}
              </td>
              <td className="nowrap small">
                {fmt.day(r.expiryDate)}
                <div className="xs" style={{ color: r.daysToExpiry <= 30 ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {t('pkg.daysLeft', { n: r.daysToExpiry })}
                </div>
              </td>
              <td className="num">{fmt.money(r.value)}</td>
              <td className="small nowrap">{r.lastVisit ? fmt.date(r.lastVisit) : '—'}</td>
              <td className="nowrap" style={{ textAlign: 'end' }}>
                <MessageBtn
                  onClick={() =>
                    onCompose({
                      who: who(r),
                      kind: 'unused_sessions',
                      vars: { package: pick(r.nameEn, r.nameAr), remaining: String(r.remaining), expiry_date: fmt.day(r.expiryDate), service: ref.serviceName(r.serviceId) },
                    })
                  }
                />
                <BookBtn c={r} serviceId={r.serviceId} packageId={r.packageId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListPanel>
  );
}

function Due({ rows, today, onCompose }: { rows: GrowthData['due']; today: string; onCompose: (c: Compose) => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  return (
    <ListPanel
      title={t('gr.tab.due')}
      hint={t('gr.def.due')}
      empty={!rows.length}
      csv={`due-again_${today}`}
      csvRows={() => [[t('appt.patient'), t('pat.phone'), t('appt.service'), t('gr.lastSession'), t('gr.dueDate')], ...rows.map((r) => [r.patientName, r.phone, ref.serviceName(r.serviceId), fmt.localDate(r.lastSession), r.dueDate])]}
    >
      <table className="table">
        <thead>
          <tr>
            <th>{t('appt.patient')}</th>
            <th>{t('appt.service')}</th>
            <th>{t('gr.lastSession')}</th>
            <th>{t('gr.dueDate')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.patientId}-${r.serviceId}`}>
              <td>
                <Who c={r} today={today} />
              </td>
              <td className="small">
                {ref.serviceName(r.serviceId)}
                <div className="xs muted">{r.basis === 'plan' ? t('gr.basis.plan', { n: r.intervalDays }) : t('gr.basis.typical', { n: r.intervalDays })}</div>
              </td>
              <td className="small nowrap">
                {fmt.date(r.lastSession)}
                <div className="xs muted">{t('gr.sessionsDone', { n: r.sessions })}</div>
              </td>
              <td className="nowrap small">
                {fmt.day(r.dueDate)}
                <div className="xs" style={{ color: r.overdueDays > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {r.overdueDays > 0 ? t('gr.overdue', { n: r.overdueDays }) : r.overdueDays === 0 ? t('gr.dueToday') : t('gr.dueIn', { n: -r.overdueDays })}
                </div>
              </td>
              <td className="nowrap" style={{ textAlign: 'end' }}>
                <MessageBtn onClick={() => onCompose({ who: who(r), kind: 'rebook', vars: { service: ref.serviceName(r.serviceId) } })} />
                <BookBtn c={r} serviceId={r.serviceId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListPanel>
  );
}

function Lapsed({ rows, today, days, onDays, onCompose }: { rows: GrowthData['lapsed']; today: string; days: string; onDays: (d: string) => void; onCompose: (c: Compose) => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const money = rows.some((r) => r.lifetimeValue !== null);
  return (
    <ListPanel
      title={t('gr.tab.lapsed')}
      hint={t('gr.def.lapsed')}
      empty={!rows.length}
      csv={`win-back_${today}`}
      csvRows={() => [
        [t('appt.patient'), t('pat.phone'), t('pat.lastVisit'), t('gr.visits'), ...(money ? [t('ins.ltv')] : [])],
        ...rows.map((r) => [r.patientName, r.phone, fmt.localDate(r.lastVisit), r.visits, ...(money ? [(r.lifetimeValue ?? 0) / 100] : [])]),
      ]}
      actions={
        <Segmented
          label={t('gr.lapsedWindow')}
          value={days}
          onChange={onDays}
          options={[
            { id: '60', label: t('gr.days', { n: 60 }) },
            { id: '90', label: t('gr.days', { n: 90 }) },
            { id: '180', label: t('gr.days', { n: 180 }) },
          ]}
        />
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>{t('appt.patient')}</th>
            <th>{t('pat.lastVisit')}</th>
            <th className="num">{t('gr.visits')}</th>
            {money && <th className="num">{t('ins.ltv')}</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.patientId}>
              <td>
                <Who c={r} today={today} />
              </td>
              <td className="small nowrap">
                {fmt.date(r.lastVisit)}
                <div className="xs muted">
                  {ref.serviceName(r.lastServiceId)} · {t('gr.daysAgo', { n: r.daysSince })}
                </div>
              </td>
              <td className="num">{r.visits}</td>
              {money && <td className="num strong">{fmt.money(r.lifetimeValue ?? 0)}</td>}
              <td className="nowrap" style={{ textAlign: 'end' }}>
                <MessageBtn onClick={() => onCompose({ who: who(r), kind: 'win_back', marketing: true, vars: { service: ref.serviceName(r.lastServiceId) } })} />
                <BookBtn c={r} serviceId={r.lastServiceId} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListPanel>
  );
}

function Renewals({ rows, today, onCompose }: { rows: NonNullable<GrowthData['renewals']>; today: string; onCompose: (c: Compose) => void }) {
  const { t, pick, tx } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const actions = useActions();
  return (
    <ListPanel
      title={t('gr.tab.renewals')}
      hint={t('gr.def.renewals')}
      empty={!rows.length}
      csv={`renewals_${today}`}
      csvRows={() => [[t('appt.patient'), t('pat.phone'), t('pkg.template'), t('pkg.remaining')], ...rows.map((r) => [r.patientName, r.phone, pick(r.nameEn, r.nameAr), r.remaining])]}
    >
      <table className="table">
        <thead>
          <tr>
            <th>{t('appt.patient')}</th>
            <th>{t('pkg.template')}</th>
            <th className="num">{t('pkg.remaining')}</th>
            <th>{t('pkg.expiry')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.packageId}>
              <td>
                <Who c={r} today={today} />
              </td>
              <td className="small">
                {pick(r.nameEn, r.nameAr)}
                {r.state !== 'active' && (
                  <div>
                    <Badge tone="outline">{tx(`pkg.state.${r.state}`, undefined, r.state)}</Badge>
                  </div>
                )}
              </td>
              <td className="num strong">
                {r.remaining}/{r.total}
              </td>
              <td className="small nowrap">{fmt.day(r.expiryDate)}</td>
              <td className="nowrap" style={{ textAlign: 'end' }}>
                <MessageBtn onClick={() => onCompose({ who: who(r), kind: 'renewal', vars: { package: pick(r.nameEn, r.nameAr), remaining: String(r.remaining) } })} />
                {can('packages.sell') && (
                  <Button size="xs" variant="ghost" icon={<Package size={13} />} onClick={() => actions.sellPackage({ id: r.patientId, fullName: r.patientName, phone: r.phone })}>
                    {t('pat.sellPackage')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListPanel>
  );
}

function Birthdays({ rows, today, onCompose }: { rows: GrowthData['birthdays']; today: string; onCompose: (c: Compose) => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  return (
    <ListPanel
      title={t('gr.tab.birthdays')}
      hint={t('gr.def.birthdays')}
      empty={!rows.length}
      csv={`birthdays_${today}`}
      csvRows={() => [[t('appt.patient'), t('pat.phone'), t('common.date')], ...rows.map((r) => [r.patientName, r.phone, r.date])]}
    >
      <table className="table">
        <thead>
          <tr>
            <th>{t('appt.patient')}</th>
            <th>{t('common.date')}</th>
            <th>{t('pat.allowMarketing')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.patientId}>
              <td>
                <Who c={r} today={today} />
              </td>
              <td className="small nowrap">
                {fmt.dayShort(r.date)}
                <div className="xs muted">
                  {r.inDays === 0 ? t('gr.today') : t('gr.inDays', { n: r.inDays })}
                  {r.turning !== null && ` · ${t('gr.turning', { n: r.turning })}`}
                </div>
              </td>
              <td>{r.allowMarketing ? <Badge tone="success">{t('common.yes')}</Badge> : <Badge tone="outline">{t('common.no')}</Badge>}</td>
              <td className="nowrap" style={{ textAlign: 'end' }}>
                <MessageBtn onClick={() => onCompose({ who: who(r), kind: 'birthday', marketing: true, vars: {} })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListPanel>
  );
}

function Collect({ rows, today }: { rows: NonNullable<GrowthData['collect']>; today: string }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const actions = useActions();
  return (
    <ListPanel
      title={t('gr.tab.collect')}
      hint={t('gr.def.collect')}
      empty={!rows.length}
      csv={`collect-at-visit_${today}`}
      csvRows={() => [[t('appt.patient'), t('pat.phone'), t('pat.nextVisit'), t('pat.balance')], ...rows.map((r) => [r.patientName, r.phone, r.nextVisit, r.outstanding / 100])]}
    >
      <table className="table">
        <thead>
          <tr>
            <th>{t('appt.patient')}</th>
            <th>{t('pat.nextVisit')}</th>
            <th className="num">{t('pat.balance')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.patientId}>
              <td>
                <Who c={r} today={today} />
              </td>
              <td className="small nowrap">
                <button className="link-btn" onClick={() => actions.openAppointment(r.appointmentId)}>
                  {fmt.dateTime(r.nextVisit)}
                </button>
              </td>
              <td className="num strong" style={{ color: 'var(--warning)' }}>
                {fmt.money(r.outstanding)}
              </td>
              <td className="nowrap" style={{ textAlign: 'end' }}>
                {can('payments.record') && (
                  <Button size="xs" variant="soft" icon={<CreditCard size={13} />} onClick={() => actions.collectPayment({ id: r.patientId, fullName: r.patientName, phone: r.phone })}>
                    {t('pat.collect')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListPanel>
  );
}

