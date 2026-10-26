import { useEffect } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, ErrorState, Loading } from '@/components/ui';
import { Totals, type InvoiceDetail } from './InvoiceDrawer';
import type { TKey } from '@/i18n/en';

function ClinicHeader({ title, number, date }: { title: string; number: string; date: string }) {
  const { me } = useSession();
  const { pick } = useI18n();
  const s = me.settings;
  return (
    <div className="row between top" style={{ marginBottom: 24 }}>
      <div className="row top">
        {s.hasLogo && <img src="/api/settings/logo" alt="" style={{ width: 56, height: 56, objectFit: 'contain' }} />}
        <div>
          <h1>{pick(s.clinicName, s.clinicNameAr)}</h1>
          <div className="small">{s.address}</div>
          <div className="small ltr">
            {s.phone} {s.email && `· ${s.email}`}
          </div>
          {s.taxRegistration && <div className="small">Tax reg.: {s.taxRegistration}</div>}
        </div>
      </div>
      <div style={{ textAlign: 'end' }}>
        <h2>{title}</h2>
        <div className="ltr strong">{number}</div>
        <div className="small">{date}</div>
      </div>
    </div>
  );
}

function PrintShell({ children, ready }: { children: React.ReactNode; ready: boolean }) {
  const { t } = useI18n();
  const { me } = useSession();
  useEffect(() => {
    if (ready) setTimeout(() => window.print(), 400);
  }, [ready]);
  return (
    <div style={{ background: '#fff', minHeight: '100%' }}>
      <div className="print-actions">
        <Button variant="primary" onClick={() => window.print()}>
          {t('common.print')}
        </Button>
        <Button onClick={() => window.close()}>{t('common.close')}</Button>
      </div>
      <div className="print-page">
        {children}
        {me.demoMode && <p className="xs muted" style={{ marginTop: 24, textAlign: 'center' }}>{t('bill.notTaxInvoice')}</p>}
      </div>
    </div>
  );
}

export function PrintInvoicePage() {
  const id = Number(useParams().id);
  const { t } = useI18n();
  const fmt = useFmt();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <PrintShell ready>
      <ClinicHeader title={t('bill.invoice')} number={d.invoice.number} date={fmt.day(d.invoice.issueDate)} />
      {d.invoice.status === 'void' && <p className="strong" style={{ color: 'var(--danger)' }}>{t('bill.status.void')} — {d.invoice.voidReason}</p>}
      <div style={{ marginBottom: 16 }}>
        <div className="strong">{d.invoice.patientName}</div>
        <div className="small">
          {d.invoice.patientCode} · <span className="ltr">{d.invoice.phone}</span>
        </div>
        {d.invoice.address && <div className="small">{d.invoice.address}</div>}
      </div>
      <table>
        <thead>
          <tr>
            <th>{t('bill.item')}</th>
            <th className="num">{t('common.quantity')}</th>
            <th className="num">{t('bill.unitPrice')}</th>
            <th className="num">{t('bill.lineDiscount')}</th>
            <th className="num">{t('bill.lineTotal')}</th>
          </tr>
        </thead>
        <tbody>
          {d.items.map((i) => (
            <tr key={i.id}>
              <td>{i.description}</td>
              <td className="num">{i.quantity}</td>
              <td className="num">{fmt.money(i.unitPrice)}</td>
              <td className="num">{i.discount ? `−${fmt.money(i.discount)}` : '—'}</td>
              <td className="num">{fmt.money(i.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 16 }}>
        <Totals d={d} />
      </div>
      {d.installments.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>{t('bill.installments')}</h3>
          <table>
            <tbody>
              {d.installments.map((i) => (
                <tr key={i.id}>
                  <td>#{i.seq}</td>
                  <td>{fmt.day(i.dueDate)}</td>
                  <td className="num">{fmt.money(i.amount)}</td>
                  <td>{t(`bill.inst.${i.status}` as TKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {d.payments.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>{t('bill.paymentsOnInvoice')}</h3>
          <table>
            <tbody>
              {d.payments.map((p) => (
                <tr key={p.id}>
                  <td className="ltr">{p.number}</td>
                  <td>{fmt.dateTime(p.receivedAt)}</td>
                  <td>{t(`method.${p.method}` as TKey)}</td>
                  <td className="num">{fmt.money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p style={{ marginTop: 24 }}>{t('bill.thankYou')}</p>
    </PrintShell>
  );
}

interface ReceiptData {
  payment: { id: number; number: string; amount: number; method: string; reference: string | null; kind: string; receivedAt: string; receivedByName: string | null; invoiceNumber: string; invoiceTotal: number; patientName: string; patientCode: string; phone: string };
  balanceAfter: number;
  refunds: { id: number; number: string; amount: number; reason: string; createdAt: string }[];
}

export function PrintReceiptPage() {
  const id = Number(useParams().id);
  const { t } = useI18n();
  const fmt = useFmt();
  const q = useQuery({ queryKey: ['payment', id], queryFn: () => api.get<ReceiptData>(`/payments/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const p = q.data.payment;
  return (
    <PrintShell ready>
      <ClinicHeader title={t('bill.receipt')} number={p.number} date={fmt.dateTime(p.receivedAt)} />
      <table>
        <tbody>
          <tr>
            <th>{t('appt.patient')}</th>
            <td>
              {p.patientName} · {p.patientCode}
            </td>
          </tr>
          <tr>
            <th>{t('bill.invoice')}</th>
            <td className="ltr">{p.invoiceNumber}</td>
          </tr>
          <tr>
            <th>{t('common.method')}</th>
            <td>
              {t(`method.${p.method}` as TKey)} {p.reference && <span className="ltr">({p.reference})</span>}
            </td>
          </tr>
          <tr>
            <th>{t('common.type')}</th>
            <td>{p.kind === 'deposit' ? t('bill.kindDeposit') : t('bill.kindPayment')}</td>
          </tr>
          <tr>
            <th>{t('common.amount')}</th>
            <td className="strong">{fmt.money(p.amount)}</td>
          </tr>
          {q.data.refunds.map((r) => (
            <tr key={r.id}>
              <th>{t('bill.refunded')}</th>
              <td>
                −{fmt.money(r.amount)} · <span className="ltr">{r.number}</span> · {r.reason}
              </td>
            </tr>
          ))}
          <tr>
            <th>{t('bill.balance')}</th>
            <td>{fmt.money(q.data.balanceAfter)}</td>
          </tr>
          <tr>
            <th>{t('bill.receivedBy')}</th>
            <td>{p.receivedByName}</td>
          </tr>
        </tbody>
      </table>
      <p style={{ marginTop: 24 }}>{t('bill.thankYou')}</p>
    </PrintShell>
  );
}
