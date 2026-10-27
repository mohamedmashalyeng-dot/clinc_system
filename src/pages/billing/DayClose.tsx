// End-of-day drawer count. The server computes what should be in the drawer from the day's cash
// payments, refunds and cash expenses; staff enter what they counted and explain any difference.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Lock } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, EmptyState, ErrorState, KV, Loading, MoneyField, Panel, TextArea } from '@/components/ui';

interface Closing {
  id: number;
  date: string;
  openingFloat: number;
  cashIn: number;
  cashRefunds: number;
  cashExpenses: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  cardTotal: number;
  transferTotal: number;
  notes: string | null;
  closedByName: string | null;
  closedAt: string;
  supersededBy: number | null;
}

type MethodSum = { received: number; receivedCount: number; refunded: number; refundedCount: number; net: number };
interface DayData {
  date: string;
  today: string;
  methods: Record<'cash' | 'card' | 'bank_transfer', MethodSum>;
  cashExpenses: number;
  current: Closing | null;
  previous: Closing[];
  suggestedFloat: number;
}

function VarianceBadge({ v }: { v: number }) {
  const { t } = useI18n();
  const fmt = useFmt();
  if (v === 0) return <Badge tone="success">{t('dc.balanced')}</Badge>;
  return <Badge tone={v < 0 ? 'danger' : 'warning'}>{v < 0 ? t('dc.short', { amount: fmt.money(-v) }) : t('dc.over', { amount: fmt.money(v) })}</Badge>;
}

export function DayClose() {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can, me } = useSession();
  const [s, set] = useUrlState({ date: fmt.today() });
  const q = useQuery({ queryKey: ['day-close', s.date], queryFn: () => api.get<DayData>('/day-close', { date: s.date }) });
  const history = useQuery({ queryKey: ['day-close-history'], queryFn: () => api.get<{ items: Closing[]; unclosed: string[] }>('/day-close/history') });
  const d = q.data;
  const [float, setFloat] = useState<number | null>(null);
  const [counted, setCounted] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [key, setKey] = useState(newKey);
  useEffect(() => {
    setFloat(null);
    setCounted(null);
    setNotes('');
    setKey(newKey());
  }, [s.date]);
  const openingFloat = float ?? d?.suggestedFloat ?? 0;
  const expected = d ? openingFloat + d.methods.cash.net - d.cashExpenses : 0;
  const variance = counted !== null && !Number.isNaN(counted) ? counted - expected : null;
  const needsNote = !!d && ((variance !== null && variance !== 0) || !!d.current);
  const close = useAction(() => api.post('/day-close', { date: s.date, openingFloat, countedCash: counted, notes: notes.trim() || null, idempotencyKey: key }), {
    success: t('dc.closed'),
    onSuccess: () => {
      setCounted(null);
      setNotes('');
      setKey(newKey());
    },
  });

  return (
    <div className="stack loose">
      <div className="row wrap between">
        <div className="row wrap">
          <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.date')} max={fmt.today()} value={s.date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
          <strong>{fmt.dayLong(s.date)}</strong>
          {d?.current ? (
            <Badge tone="success">
              <Lock size={12} aria-hidden /> {t('dc.isClosed')}
            </Badge>
          ) : (
            <Badge tone="outline">{t('dc.isOpen')}</Badge>
          )}
        </div>
        {history.data && history.data.unclosed.length > 0 && (
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="small muted">{t('dc.unclosed')}:</span>
            {history.data.unclosed.slice(0, 6).map((day) => (
              <button key={day} className="chip" aria-pressed={s.date === day} onClick={() => set({ date: day })}>
                {fmt.dayShort(day)}
              </button>
            ))}
          </div>
        )}
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <>
          <div className="metrics">
            <div className="metric" style={{ cursor: 'default' }}>
              <span className="metric-label">{t('dc.cashIn')}</span>
              <span className="metric-value">{fmt.money(d.methods.cash.received)}</span>
              <span className="metric-sub">{t('dc.count', { n: d.methods.cash.receivedCount })}</span>
            </div>
            <div className="metric" style={{ cursor: 'default' }}>
              <span className="metric-label">{t('dc.cashOut')}</span>
              <span className="metric-value">{fmt.money(d.methods.cash.refunded + d.cashExpenses)}</span>
              <span className="metric-sub">{t('dc.cashOutSub', { refunds: fmt.money(d.methods.cash.refunded), expenses: fmt.money(d.cashExpenses) })}</span>
            </div>
            <div className="metric" style={{ cursor: 'default' }}>
              <span className="metric-label">{t('method.card')}</span>
              <span className="metric-value">{fmt.money(d.methods.card.net)}</span>
              <span className="metric-sub">{t('dc.cardSub', { n: d.methods.card.receivedCount })}</span>
            </div>
            <div className="metric" style={{ cursor: 'default' }}>
              <span className="metric-label">{t('method.bank_transfer')}</span>
              <span className="metric-value">{fmt.money(d.methods.bank_transfer.net)}</span>
              <span className="metric-sub">{t('dc.count', { n: d.methods.bank_transfer.receivedCount })}</span>
            </div>
          </div>

          <div className="grid-2">
            <Panel title={d.current ? t('dc.recount') : t('dc.countTitle')}>
              {can('payments.record') ? (
                <div className="stack">
                  <div className="form-grid">
                    <MoneyField label={t('dc.float')} hint={t('dc.floatHint')} currency={me.settings.currency} value={openingFloat} onChange={(v) => setFloat(v ?? 0)} />
                    <MoneyField label={t('dc.counted')} required currency={me.settings.currency} value={counted} onChange={setCounted} />
                  </div>
                  <div className="subtle-box">
                    <KV
                      items={[
                        [t('dc.float'), fmt.money(openingFloat)],
                        [t('dc.plusCash'), `+ ${fmt.money(d.methods.cash.received)}`],
                        [t('dc.minusRefunds'), `− ${fmt.money(d.methods.cash.refunded)}`],
                        [t('dc.minusExpenses'), `− ${fmt.money(d.cashExpenses)}`],
                        [<strong>{t('dc.expected')}</strong>, <strong>{fmt.money(expected)}</strong>],
                        ...(variance !== null ? ([[t('dc.variance'), <VarianceBadge v={variance} />]] as [string, React.ReactNode][]) : []),
                      ]}
                    />
                  </div>
                  {(needsNote || notes) && (
                    <TextArea
                      label={d.current ? t('dc.recountReason') : t('dc.varianceNote')}
                      required={needsNote}
                      rows={2}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  )}
                  <div>
                    <Button
                      variant="primary"
                      icon={<CheckCircle2 size={16} />}
                      loading={close.isPending}
                      disabled={counted === null || Number.isNaN(counted) || (needsNote && !notes.trim())}
                      onClick={() => close.mutate(undefined)}
                    >
                      {d.current ? t('dc.saveRecount') : t('dc.closeDay')}
                    </Button>
                  </div>
                  <p className="xs muted">{t('dc.explain')}</p>
                </div>
              ) : (
                <p className="small muted">{t('dc.viewOnly')}</p>
              )}
            </Panel>
            <Panel title={t('dc.result')}>
              {!d.current ? (
                <EmptyState title={t('dc.notYet')} />
              ) : (
                <div className="stack">
                  <KV
                    items={[
                      [t('dc.expected'), fmt.money(d.current.expectedCash)],
                      [t('dc.counted'), fmt.money(d.current.countedCash)],
                      [t('dc.variance'), <VarianceBadge v={d.current.variance} />],
                      [t('method.card'), fmt.money(d.current.cardTotal)],
                      [t('method.bank_transfer'), fmt.money(d.current.transferTotal)],
                      [t('dc.closedBy'), `${d.current.closedByName ?? '—'} · ${fmt.dateTime(d.current.closedAt)}`],
                      ...(d.current.notes ? ([[t('common.notes'), d.current.notes]] as [string, string][]) : []),
                    ]}
                  />
                  {d.previous.length > 0 && (
                    <Callout tone="neutral" title={t('dc.earlierCounts', { n: d.previous.length })}>
                      <ul className="stack tight" style={{ margin: 0, paddingInlineStart: 16 }}>
                        {d.previous.map((p) => (
                          <li key={p.id} className="small">
                            {fmt.dateTime(p.closedAt)} · {p.closedByName} · {fmt.money(p.countedCash)} <VarianceBadge v={p.variance} />
                          </li>
                        ))}
                      </ul>
                    </Callout>
                  )}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      <Panel title={t('dc.history')} flush>
        {history.data && !history.data.items.length && <EmptyState title={t('dc.noHistory')} />}
        {history.data && history.data.items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th className="num">{t('dc.expected')}</th>
                  <th className="num">{t('dc.counted')}</th>
                  <th>{t('dc.variance')}</th>
                  <th className="num">{t('method.card')}</th>
                  <th className="num">{t('method.bank_transfer')}</th>
                  <th>{t('dc.closedBy')}</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => set({ date: c.date })}>
                    <td className="nowrap">{fmt.dayShort(c.date)}</td>
                    <td className="num">{fmt.money(c.expectedCash)}</td>
                    <td className="num">{fmt.money(c.countedCash)}</td>
                    <td>
                      <VarianceBadge v={c.variance} />
                      {c.notes && <div className="xs muted">{c.notes}</div>}
                    </td>
                    <td className="num">{fmt.money(c.cardTotal)}</td>
                    <td className="num">{fmt.money(c.transferTotal)}</td>
                    <td className="small">{c.closedByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
