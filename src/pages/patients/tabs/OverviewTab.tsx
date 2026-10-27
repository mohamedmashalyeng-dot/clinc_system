import { Link } from 'react-router';
import { AlertTriangle, CalendarClock, Package, TrendingUp, Wallet } from 'lucide-react';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, KV, Panel, Progress, Restricted, StatusBadge } from '@/components/ui';
import { useActions } from '@/layout/actions';
import type { PatientOverview } from '../PatientProfilePage';
import type { AppointmentStatus } from '@shared/domain';
import type { TKey } from '@/i18n/en';
import { SegmentBadge, useRiskText } from '@/components/insights';

export function OverviewTab({ data, onTab }: { data: PatientOverview; onTab: (tab: string) => void }) {
  const { t, tx, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const p = data.patient;
  const activePkgs = data.packages?.filter((x) => x.state === 'active') ?? [];
  return (
    <div className="stack loose">
      <div className="summary-cards">
        <div className="summary-card">
          <span className="label">
            <CalendarClock size={15} aria-hidden /> {t('ov.next')}
          </span>
          {data.nextAppointment ? (
            <>
              <button className="link-btn value" style={{ fontSize: 'var(--fs-lg)' }} onClick={() => actions.openAppointment(data.nextAppointment!.id)}>
                {fmt.dateTime(data.nextAppointment.startAt)}
              </button>
              <span className="small muted">
                {pick(data.nextAppointment.nameEn, data.nextAppointment.nameAr)} · {pick(data.nextAppointment.displayName, data.nextAppointment.displayNameAr)}
              </span>
              <span>
                <StatusBadge status={data.nextAppointment.status as AppointmentStatus} />
              </span>
            </>
          ) : (
            <span className="muted">{t('ov.noNext')}</span>
          )}
        </div>
        <div className="summary-card">
          <span className="label">
            <Package size={15} aria-hidden /> {t('ov.remaining')}
          </span>
          {data.packages === null ? (
            <span className="muted small">{t('common.restricted')}</span>
          ) : activePkgs.length ? (
            <div className="stack tight">
              {activePkgs.map((x) => (
                <button key={x.id} className="link-btn stack tight" style={{ gap: 4, color: 'inherit' }} onClick={() => onTab('packages')}>
                  <span className="row between">
                    <span className="small strong truncate">{pick(x.nameEn, x.nameAr)}</span>
                    <span className="value" style={{ fontSize: 'var(--fs-lg)' }}>
                      {x.remainingSessions}
                      <span className="small muted">/{x.totalSessions}</span>
                    </span>
                  </span>
                  <Progress value={x.totalSessions - x.remainingSessions} max={x.totalSessions} />
                  <span className="xs muted">
                    {t('pkg.expiry')} {fmt.day(x.expiryDate)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <span className="muted">{t('ov.noPackages')}</span>
          )}
        </div>
        <div className="summary-card">
          <span className="label">
            <Wallet size={15} aria-hidden /> {t('ov.outstanding')}
          </span>
          {data.outstanding === null ? (
            <span className="muted small">{t('common.restricted')}</span>
          ) : data.outstanding > 0 ? (
            <>
              <span className="value" style={{ color: 'var(--warning)' }}>
                {fmt.money(data.outstanding)}
              </span>
              <button className="link-btn small" onClick={() => onTab('billing')}>
                {t('tab.billing')}
              </button>
            </>
          ) : (
            <span className="muted">{t('ov.settled')}</span>
          )}
        </div>
        <div className="summary-card">
          <span className="label">
            <AlertTriangle size={15} aria-hidden /> {t('ov.alerts')}
          </span>
          {data.clinical === null ? (
            <span className="muted small">{t('common.restrictedClinical')}</span>
          ) : data.clinical.alerts.length || data.clinical.allergies ? (
            <div className="stack tight">
              {data.clinical.alerts.map((a, i) => (
                <div key={i} className={`alert-item ${a.severity}`}>
                  <AlertTriangle size={14} aria-hidden /> {a.text}
                </div>
              ))}
              {data.clinical.allergies && (
                <div className="small">
                  <span className="muted">{t('med.allergies')}: </span>
                  {data.clinical.allergies}
                </div>
              )}
            </div>
          ) : (
            <span className="muted">{t('ov.noAlerts')}</span>
          )}
        </div>
      </div>

      <div className="grid-2">
        <Panel title={t('pat.contact')}>
          <KV
            items={[
              [t('pat.phone'), <span className="ltr">{p.phone}</span>],
              [t('pat.altPhone'), p.altPhone ? <span className="ltr">{p.altPhone}</span> : '—'],
              [t('pat.email'), p.email ? <span className="ltr">{p.email}</span> : '—'],
              [t('pat.dob'), p.dob ? `${fmt.day(p.dob)} (${t('pat.yearsOld', { n: p.age ?? '' })})` : '—'],
              [t('pat.address'), p.address],
              [t('pat.emergency'), p.emergencyName ? `${p.emergencyName}${p.emergencyRelation ? ` (${p.emergencyRelation})` : ''} · ${p.emergencyPhone ?? ''}` : '—'],
              [t('pat.channel'), `${tx(`pat.channel.${p.contactChannel}`)} · ${p.preferredLanguage === 'ar' ? 'العربية' : 'English'}`],
              [t('pat.allowReminders'), p.allowReminders ? t('common.yes') : t('common.no')],
              [t('pat.allowMarketing'), p.allowMarketing ? t('common.yes') : t('common.no')],
              [t('pat.source'), p.source ? tx(`src.${p.source}`) : t('src.unknown')],
              ...(p.referredByPatientId
                ? ([[t('pat.referredBy'), <Link to={`/patients/${p.referredByPatientId}`}>{p.referredByName ?? '—'}</Link>]] as [string, React.ReactNode][])
                : []),
              [t('pat.primaryPractitioner'), ref.practitionerName(p.primaryPractitionerId)],
              ...(p.adminNotes ? ([[t('common.notes'), p.adminNotes]] as [string, string][]) : []),
            ]}
          />
          <p className="small muted" style={{ marginTop: 12 }}>
            {t('ov.visits', { n: data.stats.completedVisits, ns: data.stats.noShows, c: data.stats.cancellations })}
          </p>
        </Panel>
        <div className="stack">
          <InsightsPanel data={data} />
          {data.consents && (
            <Panel title={t('ov.consents')} actions={<button className="link-btn small" onClick={() => onTab('consents')}>{t('common.view')}</button>}>
              <div className="stack tight">
                {(['treatment', 'clinical_photography', 'marketing_photography', 'data_processing'] as const).map((k) => {
                  const c = data.consents![k];
                  return (
                    <div key={k} className="row between">
                      <span className="small">{t(`con.type.${k}` as TKey)}</span>
                      {c ? <Badge tone={c.status === 'granted' ? 'success' : 'danger'}>{c.status === 'granted' ? t('con.granted') : t('con.withdrawn')}</Badge> : <Badge tone="outline">{t('con.notRecorded')}</Badge>}
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
          {!can('medical.view') && <Restricted perm="medical.view" clinical />}
          <Panel title={t('ov.activity')}>
            {!data.activity.length ? (
              <p className="muted small">{t('ov.noActivity')}</p>
            ) : (
              <ul className="timeline">
                {data.activity.map((a, i) => (
                  <li key={i}>
                    <div className="grow small">
                      {a.type === 'payment'
                        ? `${t('act.payment', { number: a.number ?? '' })} · ${fmt.money(a.amount ?? 0)}`
                        : a.type === 'package'
                          ? t('act.package', { name: pick(a.nameEn, a.nameAr) })
                          : a.type.startsWith('appointment.') && ['created', 'rescheduled', 'session_reversed'].includes(a.type.slice(12))
                            ? tx(`act.${a.type}`, { service: pick(a.serviceEn, a.serviceAr) })
                            : t('act.appointment.status', { service: pick(a.serviceEn, a.serviceAr), status: tx(`status.${a.type.slice(12)}`) })}
                    </div>
                    <div className="when">
                      {fmt.dateTime(a.at)}
                      {a.by && <div>{a.by}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Value, loyalty and attendance at a glance — every figure is derived from visits and payments. */
function InsightsPanel({ data }: { data: PatientOverview }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const riskText = useRiskText();
  const i = data.insights;
  return (
    <Panel
      title={
        <h2 className="row" style={{ gap: 8 }}>
          <TrendingUp size={17} aria-hidden /> {t('ins.title')}
        </h2>
      }
      actions={<SegmentBadge segment={i.segment} lapsed={i.lapsed} always />}
    >
      <KV
        items={[
          ...(i.lifetimeValue !== null
            ? ([
                [t('ins.ltv'), <strong>{fmt.money(i.lifetimeValue)}</strong>],
                [t('ins.avgPerVisit'), fmt.money(i.avgPerVisit ?? 0)],
              ] as [string, React.ReactNode][])
            : []),
          [t('ins.visits'), t('ins.visitsValue', { n: i.completedVisits, first: i.firstVisit ? fmt.date(i.firstVisit) : '—' })],
          [t('pat.lastVisit'), i.lastVisit ? `${fmt.date(i.lastVisit)} · ${t('gr.daysAgo', { n: i.daysSinceLastVisit ?? 0 })}` : '—'],
          [t('ins.interval'), i.avgIntervalDays !== null ? t('gr.days', { n: i.avgIntervalDays }) : '—'],
          [t('ins.attendance'), i.attendanceRate !== null ? fmt.pct(i.attendanceRate) : '—'],
          [
            t('ins.risk'),
            i.noShowRisk.level === 'low' ? (
              <span className="muted">{t('risk.low')}</span>
            ) : (
              <span style={{ color: i.noShowRisk.level === 'high' ? 'var(--danger)' : 'var(--warning)' }}>
                {i.noShowRisk.level === 'high' ? t('risk.high') : t('risk.medium')} — {riskText(i.noShowRisk)}
              </span>
            ),
          ],
          [t('ins.referrals'), String(i.referrals)],
        ]}
      />
      <p className="xs muted" style={{ marginTop: 10 }}>
        {t(`seg.def.${i.segment}` as TKey)}
      </p>
    </Panel>
  );
}
