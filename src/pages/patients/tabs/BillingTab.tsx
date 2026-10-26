import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, FilePlus2, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, EmptyState, ErrorState, Loading, Panel } from '@/components/ui';
import { useActions } from '@/layout/actions';
import { InvoiceStatusBadge } from '@/pages/billing/InvoiceDrawer';
import { NewInvoiceDialog } from '@/pages/billing/NewInvoiceDialog';
import type { PatientRef } from '@/components/pickers';
import type { TKey } from '@/i18n/en';

interface BillingData {
  invoices: { id: number; number: string; issueDate: string; kind: string; status: string; total: number; netPaid: number; balance: number }[];
  payments: { id: number; number: string; receivedAt: string; invoiceNumber: string; invoiceId: number; method: string; amount: number; refunded: number; kind: string; receivedByName: string | null }[];
  refunds: { id: number; number: string; createdAt: string; paymentNumber: string; amount: number; reason: string; createdByName: string | null }[];
  outstanding: number;
}

export function BillingTab({ patientId, patient }: { patientId: number; patient: PatientRef }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const actions = useActions();
  const [newInvoice, setNewInvoice] = useState(false);
  const q = useQuery({ queryKey: ['patient-billing', patientId], queryFn: () => api.get<BillingData>(`/patients/${patientId}/billing`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="stack loose">
      <div className="row between wrap">
        <div className="summary-card" style={{ minWidth: 240 }}>
          <span className="label">{t('bill.outstandingTotal')}</span>
          <span className="value" style={{ color: d.outstanding > 0 ? 'var(--warning)' : undefined }}>
            {fmt.money(d.outstanding)}
          </span>
        </div>
        <div className="toolbar">
          {can('payments.record') && (
            <>
              <Button icon={<FilePlus2 size={16} />} onClick={() => setNewInvoice(true)}>
                {t('bill.newInvoice')}
              </Button>
              <Button variant="primary" icon={<CreditCard size={16} />} disabled={d.outstanding <= 0} onClick={() => actions.collectPayment(patient)}>
                {t('bill.recordPayment')}
              </Button>
            </>
          )}
        </div>
      </div>
      <Panel title={t('bill.invoices')} flush>
        {!d.invoices.length ? (
          <EmptyState title={t('bill.empty')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('bill.number')}</th>
                  <th>{t('bill.issueDate')}</th>
                  <th>{t('bill.kind')}</th>
                  <th className="num">{t('common.total')}</th>
                  <th className="num">{t('bill.paid')}</th>
                  <th className="num">{t('bill.balance')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {d.invoices.map((i) => (
                  <tr key={i.id} className="clickable" tabIndex={0} onClick={() => actions.openInvoice(i.id)} onKeyDown={(e) => e.key === 'Enter' && actions.openInvoice(i.id)}>
                    <td className="ltr nowrap strong">{i.number}</td>
                    <td className="nowrap">{fmt.day(i.issueDate)}</td>
                    <td>{t(`bill.kind.${i.kind}` as TKey)}</td>
                    <td className="num">{fmt.money(i.total)}</td>
                    <td className="num">{fmt.money(i.netPaid)}</td>
                    <td className="num strong">{fmt.money(i.balance)}</td>
                    <td>
                      <InvoiceStatusBadge status={i.status} balance={i.balance} paid={i.netPaid} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title={t('bill.payments')} flush>
        {!d.payments.length ? (
          <EmptyState title={t('bill.noPayments')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('bill.receipt')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('bill.invoice')}</th>
                  <th>{t('common.method')}</th>
                  <th className="num">{t('common.amount')}</th>
                  <th className="num">{t('bill.refunded')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="ltr nowrap">
                      {p.number} {p.kind === 'deposit' && <span className="xs muted">({t('bill.kindDeposit')})</span>}
                    </td>
                    <td className="nowrap">{fmt.dateTime(p.receivedAt)}</td>
                    <td>
                      <button className="link-btn ltr" onClick={() => actions.openInvoice(p.invoiceId)}>
                        {p.invoiceNumber}
                      </button>
                    </td>
                    <td>{t(`method.${p.method}` as TKey)}</td>
                    <td className="num">{fmt.money(p.amount)}</td>
                    <td className="num">{p.refunded ? fmt.money(p.refunded) : '—'}</td>
                    <td>
                      <a className="btn btn-xs btn-ghost" href={`/print/receipt/${p.id}`} target="_blank" rel="noopener" aria-label={t('bill.printReceipt')}>
                        <Printer size={13} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {d.refunds.length > 0 && (
        <Panel title={t('bill.refunds')} flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('bill.number')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('bill.receipt')}</th>
                  <th className="num">{t('common.amount')}</th>
                  <th>{t('common.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {d.refunds.map((r) => (
                  <tr key={r.id}>
                    <td className="ltr nowrap">{r.number}</td>
                    <td className="nowrap">{fmt.dateTime(r.createdAt)}</td>
                    <td className="ltr">{r.paymentNumber}</td>
                    <td className="num">{fmt.money(r.amount)}</td>
                    <td className="small">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {newInvoice && <NewInvoiceDialog patient={patient} onClose={() => setNewInvoice(false)} />}
    </div>
  );
}
