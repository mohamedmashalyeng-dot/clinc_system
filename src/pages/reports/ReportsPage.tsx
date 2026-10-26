import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { downloadCsv, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_ } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, EmptyState, ErrorState, Loading, Panel } from '@/components/ui';
import { DateRangeControl, presetRange } from '@/components/pickers';
import type { TKey } from '@/i18n/en';

interface ReportData {
  range: { from: string; to: string };
  financial?: {
    collected: number;
    collectedByMethod: { method: string; total: number; n: number }[];
    collectedByKind: { kind: string; total: number }[];
    refunds: { total: number; n: number };
    netCollected: number;
    expenses: { total: number; byCategory: { category: string; total: number; n: number }[] };
    netAfterExpenses: number;
    invoiced: { kind: string; total: number; n: number; discounts: number }[];
    outstanding: { total: number; aging: { bucket: string; total: number; n: number }[] };
    packageSales: { n: number; gross: number; discounts: number; net: number; collected: number };
  };
  operational?: {
    appointments: { total: number; created: number; byStatus: Record<string, number>; cancellationRate: number; noShowRate: number };
    sessionsByService: { serviceId: number; sessions: number; packageSessions: number }[];
    sessionsByPractitioner: { practitionerId: number; sessions: number; patients: number }[];
    packageUsage: { templateId: number; nameEn: string; nameAr: string; redeemed: number; reversed: number; adjusted: number }[];
    consumption: { itemId: number; name: string; unit: string; sku: string; used: number; wasted: number; received: number; cost: number | null }[];
  };
}

interface Col<T> {
  label: string;
  value: (r: T) => string | number;
  render?: (r: T) => ReactNode;
  num?: boolean;
}

/** A plain table with an optional single-hue magnitude bar — values always printed, bar is secondary. */
function ReportTable<T>({ title, definition, cols, rows, bar, csv, footer }: { title: string; definition?: string; cols: Col<T>[]; rows: T[]; bar?: (r: T) => number; csv: string; footer?: ReactNode[] }) {
  const { t } = useI18n();
  const max = bar ? Math.max(1, ...rows.map(bar)) : 1;
  return (
    <Panel
      title={title}
      flush
      actions={
        rows.length > 0 && (
          <Button size="xs" variant="ghost" icon={<Download size={13} />} onClick={() => downloadCsv(`${csv}.csv`, [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.value(r)))])}>
            {t('common.download')}
          </Button>
        )
      }
    >
      {definition && (
        <p className="xs muted row top" style={{ padding: '10px 14px 0', gap: 6 }}>
          <Info size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          {definition}
        </p>
      )}
      {!rows.length ? (
        <EmptyState title={t('rep.noData')} />
      ) : (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th key={i} className={c.num ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
                {bar && <th style={{ width: '28%' }}>{t('rep.share')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c, j) => (
                    <td key={j} className={c.num ? 'num' : undefined}>
                      {c.render ? c.render(r) : c.value(r)}
                    </td>
                  ))}
                  {bar && (
                    <td>
                      <div className="bar-cell" title={String(cols[cols.length - 1].value(r))}>
                        <div className="bar-track">
                          <div className="bar" style={{ width: `${Math.max(1, (bar(r) / max) * 100)}%` }} />
                        </div>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {footer && (
              <tfoot>
                <tr>
                  {footer.map((f, i) => (
                    <td key={i} className={cols[i]?.num ? 'num' : undefined}>
                      {f}
                    </td>
                  ))}
                  {bar && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Panel>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warning' | 'danger' }) {
  return (
    <div className={`metric ${tone ? `tone-${tone}` : ''}`} style={{ cursor: 'default' }} title={hint}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {hint && <span className="metric-sub">{hint}</span>}
    </div>
  );
}

export function ReportsPage() {
  const { t, tx, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const initial = presetRange('month', fmt.today());
  const [r, set] = useUrlState({ from: initial.from, to: initial.to });
  const q = useQuery({ queryKey: ['reports', r.from, r.to], queryFn: () => api.get<ReportData>('/reports', { from: r.from, to: r.to }), placeholderData: (p) => p });
  const f = q.data?.financial;
  const o = q.data?.operational;
  const suffix = `${r.from}_${r.to}`;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('rep.title')}</h1>
          <p className="sub">
            {fmt.day(r.from)} – {fmt.day(r.to)}
          </p>
        </div>
        <DateRangeControl from={r.from} to={r.to} onChange={(x) => set(x)} presets={['today', 'week', 'month', 'last_month', 'last30', 'custom']} />
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {f && (
        <section className="stack" aria-labelledby="fin-h">
          <h2 id="fin-h">{t('rep.financial')}</h2>
          <div className="metrics">
            <Kpi label={t('rep.collected')} value={fmt.money(f.collected)} />
            <Kpi label={t('rep.refunds')} value={fmt.money(f.refunds.total)} hint={`${f.refunds.n}`} />
            <Kpi label={t('rep.netCollected')} value={fmt.money(f.netCollected)} />
            <Kpi label={t('rep.expenses')} value={fmt.money(f.expenses.total)} />
            <Kpi label={t('rep.netAfterExpenses')} value={fmt.money(f.netAfterExpenses)} tone={f.netAfterExpenses < 0 ? 'danger' : undefined} />
            <Kpi label={t('rep.outstanding')} value={fmt.money(f.outstanding.total)} tone={f.outstanding.total ? 'warning' : undefined} />
          </div>
          <div className="grid-2">
            <ReportTable
              title={t('rep.byMethod')}
              definition={t('rep.def.collected')}
              csv={`collected-by-method_${suffix}`}
              rows={f.collectedByMethod}
              bar={(x) => x.total}
              cols={[
                { label: t('common.method'), value: (x) => tx(`method.${x.method}`) },
                { label: t('rep.count'), value: (x) => x.n, num: true },
                { label: t('common.total'), value: (x) => fmt.money(x.total), num: true },
              ]}
              footer={[t('common.total'), String(f.collectedByMethod.reduce((s, x) => s + x.n, 0)), fmt.money(f.collected)]}
            />
            <ReportTable
              title={t('rep.byKind')}
              definition={t('rep.def.refunds')}
              csv={`collected-by-kind_${suffix}`}
              rows={f.collectedByKind}
              bar={(x) => x.total}
              cols={[
                { label: t('bill.kind'), value: (x) => tx(`bill.kind.${x.kind}`) },
                { label: t('common.total'), value: (x) => fmt.money(x.total), num: true },
              ]}
              footer={[`${t('rep.refunds')}: −${fmt.money(f.refunds.total)}`, fmt.money(f.netCollected)]}
            />
            <ReportTable
              title={t('rep.expensesByCat')}
              definition={t('rep.def.expenses')}
              csv={`expenses_${suffix}`}
              rows={f.expenses.byCategory}
              bar={(x) => x.total}
              cols={[
                { label: t('common.category'), value: (x) => tx(`exp.cat.${x.category}`) },
                { label: t('rep.count'), value: (x) => x.n, num: true },
                { label: t('common.total'), value: (x) => fmt.money(x.total), num: true },
              ]}
              footer={[t('common.total'), '', fmt.money(f.expenses.total)]}
            />
            <ReportTable
              title={t('rep.invoiced')}
              definition={t('rep.def.invoiced')}
              csv={`invoiced_${suffix}`}
              rows={f.invoiced}
              bar={(x) => x.total}
              cols={[
                { label: t('bill.kind'), value: (x) => tx(`bill.kind.${x.kind}`) },
                { label: t('rep.count'), value: (x) => x.n, num: true },
                { label: t('bill.discounts'), value: (x) => fmt.money(x.discounts), num: true },
                { label: t('common.total'), value: (x) => fmt.money(x.total), num: true },
              ]}
            />
            <ReportTable
              title={t('rep.aging')}
              definition={t('rep.def.outstanding')}
              csv={`outstanding-aging_${suffix}`}
              rows={['0_30', '31_60', '61_90', '90_plus'].map((b) => f.outstanding.aging.find((a) => a.bucket === b) ?? { bucket: b, total: 0, n: 0 })}
              bar={(x) => x.total}
              cols={[
                { label: t('bill.due'), value: (x) => tx(`rep.age.${x.bucket}`) },
                { label: t('rep.count'), value: (x) => x.n, num: true },
                { label: t('bill.balance'), value: (x) => fmt.money(x.total), num: true },
              ]}
              footer={[t('common.total'), '', fmt.money(f.outstanding.total)]}
            />
            <ReportTable
              title={t('rep.packageSales')}
              definition={t('rep.def.packages')}
              csv={`package-sales_${suffix}`}
              rows={[
                { k: t('rep.packagesSold'), v: String(f.packageSales.n) },
                { k: t('rep.grossValue'), v: fmt.money(f.packageSales.gross) },
                { k: t('bill.discounts'), v: `−${fmt.money(f.packageSales.discounts)}` },
                { k: t('rep.netValue'), v: fmt.money(f.packageSales.net) },
                { k: t('rep.packageCash'), v: fmt.money(f.packageSales.collected) },
              ]}
              cols={[
                { label: t('common.details'), value: (x) => x.k },
                { label: t('common.total'), value: (x) => x.v, num: true },
              ]}
            />
          </div>
        </section>
      )}

      {o && (
        <section className="stack" aria-labelledby="ops-h">
          <h2 id="ops-h">{t('rep.operational')}</h2>
          <div className="metrics">
            <Kpi label={t('rep.scheduled')} value={fmt.num(o.appointments.total)} />
            <Kpi label={t('rep.created')} value={fmt.num(o.appointments.created)} />
            <Kpi label={t('status.completed')} value={fmt.num(o.appointments.byStatus.completed ?? 0)} />
            <Kpi label={t('status.cancelled')} value={fmt.num(o.appointments.byStatus.cancelled ?? 0)} hint={`${t('rep.cancellationRate')}: ${fmt.pct(o.appointments.cancellationRate)}`} />
            <Kpi label={t('status.no_show')} value={fmt.num(o.appointments.byStatus.no_show ?? 0)} hint={`${t('rep.noShowRate')}: ${fmt.pct(o.appointments.noShowRate)}`} tone={o.appointments.noShowRate > 0.1 ? 'warning' : undefined} />
          </div>
          <p className="xs muted row top" style={{ gap: 6 }}>
            <Info size={13} aria-hidden style={{ marginTop: 2 }} />
            {t('rep.def.bookings')}
          </p>
          <div className="grid-2">
            <ReportTable
              title={t('rep.bookings')}
              csv={`bookings_${suffix}`}
              rows={(['booked', 'confirmed', 'arrived', 'in_treatment', 'completed', 'cancelled', 'no_show'] as const).map((s) => ({ s, n: o.appointments.byStatus[s] ?? 0 })).filter((x) => x.n > 0)}
              bar={(x) => x.n}
              cols={[
                { label: t('common.status'), value: (x) => t(`status.${x.s}` as TKey) },
                { label: t('rep.count'), value: (x) => x.n, num: true },
              ]}
              footer={[t('common.total'), String(o.appointments.total)]}
            />
            <ReportTable
              title={t('rep.byService')}
              definition={t('rep.def.sessions')}
              csv={`sessions-by-service_${suffix}`}
              rows={o.sessionsByService}
              bar={(x) => x.sessions}
              cols={[
                { label: t('appt.service'), value: (x) => ref.serviceName(x.serviceId) },
                { label: t('rep.packageSessions'), value: (x) => x.packageSessions, num: true },
                { label: t('rep.sessions'), value: (x) => x.sessions, num: true },
              ]}
              footer={[t('common.total'), String(o.sessionsByService.reduce((s, x) => s + x.packageSessions, 0)), String(o.sessionsByService.reduce((s, x) => s + x.sessions, 0))]}
            />
            <ReportTable
              title={t('rep.byPractitioner')}
              definition={t('rep.def.sessions')}
              csv={`sessions-by-practitioner_${suffix}`}
              rows={o.sessionsByPractitioner}
              bar={(x) => x.sessions}
              cols={[
                { label: t('appt.practitioner'), value: (x) => ref.practitionerName(x.practitionerId) },
                { label: t('rep.patients'), value: (x) => x.patients, num: true },
                { label: t('rep.sessions'), value: (x) => x.sessions, num: true },
              ]}
            />
            <ReportTable
              title={t('rep.packageUsage')}
              definition={t('rep.def.packages')}
              csv={`package-usage_${suffix}`}
              rows={o.packageUsage}
              bar={(x) => x.redeemed}
              cols={[
                { label: t('pkg.template'), value: (x) => pick(x.nameEn, x.nameAr) },
                { label: t('rep.reversed'), value: (x) => x.reversed, num: true },
                { label: t('rep.adjusted'), value: (x) => x.adjusted, num: true },
                { label: t('rep.redeemed'), value: (x) => x.redeemed, num: true },
              ]}
            />
          </div>
          <ReportTable
            title={t('rep.consumption')}
            definition={t('rep.def.consumption')}
            csv={`inventory-consumption_${suffix}`}
            rows={o.consumption}
            cols={[
              { label: t('inv.name'), value: (x) => `${x.name} (${x.sku})` },
              { label: t('rep.receivedQty'), value: (x) => `${fmt.num(x.received)} ${x.unit}`, num: true },
              { label: t('rep.wasted'), value: (x) => `${fmt.num(x.wasted)} ${x.unit}`, num: true },
              ...(o.consumption.some((x) => x.cost !== null) ? [{ label: t('rep.cost'), value: (x: (typeof o.consumption)[number]) => fmt.money(x.cost ?? 0), num: true }] : []),
              { label: t('rep.usedQty'), value: (x) => `${fmt.num(x.used)} ${x.unit}`, num: true },
            ]}
          />
        </section>
      )}
    </div>
  );
}
