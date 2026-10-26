import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, CreditCard, Printer, Receipt, SlidersHorizontal, Undo2 } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, ErrorState, Loading, MoneyField, SelectField, TextArea } from '@/components/ui';
import { ConfirmDialog, Dialog, Drawer } from '@/components/overlays';
import { useActions } from '@/layout/actions';
import { PAYMENT_METHODS } from '@shared/domain';
import type { TKey } from '@/i18n/en';

export interface InvoiceDetail {
  invoice: {
    id: number;
    number: string;
    patientId: number;
    patientName: string;
    patientCode: string;
    phone: string;
    email: string | null;
    address: string | null;
    appointmentId: number | null;
    kind: 'service' | 'package' | 'custom';
    status: 'issued' | 'void';
    issueDate: string;
    subtotal: number;
    discountTotal: number;
    taxRate: number;
    tax: number;
    adjustmentsTotal: number;
    total: number;
    discountReason: string | null;
    notes: string | null;
    createdByName: string | null;
    createdAt: string;
    voidedAt: string | null;
    voidedByName: string | null;
    voidReason: string | null;
  };
  items: { id: number; description: string; quantity: number; unitPrice: number; discount: number; lineTotal: number }[];
  balance: { total: number; paid: number; refunded: number; netPaid: number; balance: number; paymentStatus: string };
  payments: { id: number; number: string; amount: number; method: string; reference: string | null; kind: string; receivedAt: string; receivedByName: string | null; refunded: number }[];
  refunds: { id: number; number: string; amount: number; method: string; reason: string; createdAt: string; createdByName: string | null; paymentNumber: string }[];
  adjustments: { id: number; amount: number; reason: string; createdAt: string; createdByName: string | null }[];
  installments: { id: number; seq: number; dueDate: string; amount: number; paid: number; status: string }[];
  package: { id: number; nameEn: string; nameAr: string } | null;
  appointment: { id: number; startAt: string; status: string; serviceId: number } | null;
}

export function InvoiceStatusBadge({ status, balance, paid }: { status: string; balance: number; paid: number }) {
  const { t } = useI18n();
  if (status === 'void') return <Badge>{t('bill.status.void')}</Badge>;
  if (balance <= 0) return <Badge tone="success">{t('bill.status.paid')}</Badge>;
  if (paid > 0) return <Badge tone="warning">{t('bill.status.partially_paid')}</Badge>;
  return <Badge tone="danger">{t('bill.status.unpaid')}</Badge>;
}

export function InvoiceDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const actions = useActions();
  const [refund, setRefund] = useState<InvoiceDetail['payments'][number] | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  const voidInv = useAction((reason: string) => api.post(`/invoices/${id}/void`, { reason }), { success: t('bill.voided'), onSuccess: () => setVoidOpen(false) });
  const d = q.data;
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={d ? `${t('bill.invoice')} ${d.invoice.number}` : t('common.loading')}
      subtitle={d ? `${d.invoice.patientName} · ${fmt.day(d.invoice.issueDate)}` : undefined}
      actions={d && <InvoiceStatusBadge status={d.invoice.status} balance={d.balance.balance} paid={d.balance.netPaid} />}
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <div className="stack loose">
          <div className="toolbar">
            {d.invoice.status === 'issued' && d.balance.balance > 0 && can('payments.record') && (
              <Button variant="primary" size="sm" icon={<CreditCard size={15} />} onClick={() => actions.recordPayment({ invoiceId: id })}>
                {t('bill.recordPayment')}
              </Button>
            )}
            <a className="btn btn-sm" href={`/print/invoice/${id}`} target="_blank" rel="noopener">
              <Printer size={15} /> {t('bill.printInvoice')}
            </a>
            {d.invoice.status === 'issued' && can('invoices.adjust') && (
              <Button size="sm" variant="ghost" icon={<SlidersHorizontal size={15} />} onClick={() => setAdjust(true)}>
                {t('bill.adjust')}
              </Button>
            )}
            {d.invoice.status === 'issued' && can('invoices.adjust') && d.balance.netPaid === 0 && (
              <Button size="sm" variant="ghost" icon={<Ban size={15} />} onClick={() => setVoidOpen(true)}>
                {t('bill.void')}
              </Button>
            )}
          </div>
          {d.invoice.status === 'void' && (
            <Callout tone="neutral">
              {t('bill.status.void')} · {fmt.dateTime(d.invoice.voidedAt)} · {d.invoice.voidedByName} — {d.invoice.voidReason}
            </Callout>
          )}
          <div className="small">
            <Link to={`/patients/${d.invoice.patientId}`} onClick={onClose}>
              {d.invoice.patientName}
            </Link>{' '}
            <span className="muted">{d.invoice.patientCode}</span>
            {d.package && <div className="muted">{t('bill.forPackage', { name: pick(d.package.nameEn, d.package.nameAr) })}</div>}
            {d.appointment && (
              <div>
                <button className="link-btn" onClick={() => actions.openAppointment(d.appointment!.id)}>
                  {t('bill.forAppointment', { date: fmt.dateTime(d.appointment.startAt) })}
                </button>
              </div>
            )}
          </div>
          <div className="table-wrap">
            <table className="table table-compact">
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
          </div>
          <Totals d={d} />
          {d.invoice.discountReason && <p className="small muted">{t('bill.discountReason')}: {d.invoice.discountReason}</p>}
          {d.installments.length > 0 && (
            <div className="stack tight">
              <h3 className="section-title">{t('bill.installments')}</h3>
              <table className="table table-compact">
                <tbody>
                  {d.installments.map((i) => (
                    <tr key={i.id}>
                      <td>#{i.seq}</td>
                      <td>{fmt.day(i.dueDate)}</td>
                      <td className="num">{fmt.money(i.amount)}</td>
                      <td>
                        <Badge tone={i.status === 'paid' ? 'success' : i.status === 'overdue' ? 'danger' : i.status === 'partially_paid' ? 'warning' : 'neutral'}>{t(`bill.inst.${i.status}` as TKey)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="stack tight">
            <h3 className="section-title">{t('bill.paymentsOnInvoice')}</h3>
            {!d.payments.length ? (
              <p className="small muted">{t('bill.noPayments')}</p>
            ) : (
              <table className="table table-compact">
                <tbody>
                  {d.payments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div className="ltr strong">{p.number}</div>
                        <div className="xs muted">
                          {fmt.dateTime(p.receivedAt)} · {p.receivedByName}
                        </div>
                      </td>
                      <td className="small">
                        {t(`method.${p.method}` as TKey)}
                        {p.kind === 'deposit' && <div className="xs muted">{t('bill.kindDeposit')}</div>}
                        {p.reference && <div className="xs muted ltr">{p.reference}</div>}
                      </td>
                      <td className="num">
                        {fmt.money(p.amount)}
                        {p.refunded > 0 && <div className="xs" style={{ color: 'var(--danger)' }}>−{fmt.money(p.refunded)}</div>}
                      </td>
                      <td className="nowrap" style={{ textAlign: 'end' }}>
                        <a className="btn btn-xs btn-ghost" href={`/print/receipt/${p.id}`} target="_blank" rel="noopener" aria-label={t('bill.printReceipt')}>
                          <Receipt size={13} />
                        </a>
                        {can('refunds.issue') && p.amount - p.refunded > 0 && (
                          <Button size="xs" variant="ghost" icon={<Undo2 size={13} />} onClick={() => setRefund(p)}>
                            {t('bill.refund')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {d.refunds.length > 0 && (
            <div className="stack tight">
              <h3 className="section-title">{t('bill.refunds')}</h3>
              <table className="table table-compact">
                <tbody>
                  {d.refunds.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="ltr strong">{r.number}</div>
                        <div className="xs muted">
                          {fmt.dateTime(r.createdAt)} · {r.createdByName} · ← <span className="ltr">{r.paymentNumber}</span>
                        </div>
                      </td>
                      <td className="small">{r.reason}</td>
                      <td className="num">−{fmt.money(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.adjustments.length > 0 && (
            <div className="stack tight">
              <h3 className="section-title">{t('bill.adjustments')}</h3>
              <table className="table table-compact">
                <tbody>
                  {d.adjustments.map((a) => (
                    <tr key={a.id}>
                      <td className="xs muted nowrap">
                        {fmt.dateTime(a.createdAt)}
                        <div>{a.createdByName}</div>
                      </td>
                      <td className="small">{a.reason}</td>
                      <td className="num">{fmt.money(a.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="xs muted">{t('bill.recordingOnly')}</p>
        </div>
      )}
      {refund && d && <RefundDialog payment={refund} onClose={() => setRefund(null)} />}
      {adjust && <AdjustDialog invoiceId={id} onClose={() => setAdjust(false)} />}
      <ConfirmDialog
        open={voidOpen}
        title={t('bill.voidTitle')}
        body={t('bill.voidHint')}
        reasonLabel={t('common.reason')}
        confirmLabel={t('bill.void')}
        danger
        loading={voidInv.isPending}
        onCancel={() => setVoidOpen(false)}
        onConfirm={(r) => voidInv.mutate(r)}
      />
    </Drawer>
  );
}

export function Totals({ d }: { d: InvoiceDetail }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const rows: [string, string, boolean?][] = [
    [t('bill.subtotal'), fmt.money(d.invoice.subtotal)],
    ...(d.invoice.discountTotal ? ([[t('bill.discounts'), `−${fmt.money(d.invoice.discountTotal)}`]] as [string, string][]) : []),
    ...(d.invoice.tax ? ([[t('bill.tax', { rate: d.invoice.taxRate }), fmt.money(d.invoice.tax)]] as [string, string][]) : []),
    ...(d.invoice.adjustmentsTotal ? ([[t('bill.adjustments'), fmt.money(d.invoice.adjustmentsTotal)]] as [string, string][]) : []),
    [t('common.total'), fmt.money(d.invoice.total), true],
    [t('bill.paid'), fmt.money(d.balance.paid)],
    ...(d.balance.refunded ? ([[t('bill.refunded'), `−${fmt.money(d.balance.refunded)}`]] as [string, string][]) : []),
    [t('bill.balance'), fmt.money(d.balance.balance), true],
  ];
  return (
    <div style={{ maxWidth: 340, marginInlineStart: 'auto', width: '100%' }}>
      <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
        {rows.map(([k, v, strong]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className={strong ? 'strong' : ''} style={strong ? { color: 'var(--text)' } : undefined}>
              {k}
            </dt>
            <dd className={`num ${strong ? 'strong' : ''}`} style={{ textAlign: 'end' }}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RefundDialog({ payment, onClose }: { payment: InvoiceDetail['payments'][number]; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { me } = useSession();
  const available = payment.amount - payment.refunded;
  const [amount, setAmount] = useState<number | null>(available);
  const [method, setMethod] = useState(payment.method);
  const [reason, setReason] = useState('');
  const [key] = useState(newKey);
  const valid = amount !== null && !Number.isNaN(amount) && amount > 0 && amount <= available && !!reason.trim();
  const save = useAction(() => api.post(`/payments/${payment.id}/refunds`, { amount, method, reason, idempotencyKey: key }), { success: t('bill.refundRecorded'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('bill.refundTitle', { number: payment.number })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('bill.refund')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">{t('bill.refundHint', { amount: fmt.money(available) })}</p>
        <MoneyField label={t('common.amount')} required currency={me.settings.currency} value={amount} onChange={setAmount} error={amount !== null && (Number.isNaN(amount) || amount > available) ? t('err.REFUND_EXCEEDS_PAYMENT') : undefined} />
        <SelectField label={t('common.method')} value={method} onChange={(e) => setMethod(e.target.value)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`method.${m}` as TKey)}
            </option>
          ))}
        </SelectField>
        <TextArea label={t('common.reason')} required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

function AdjustDialog({ invoiceId, onClose }: { invoiceId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { me, can } = useSession();
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const valid = amount !== null && !Number.isNaN(amount) && amount !== 0 && !!reason.trim();
  const save = useAction(() => api.post(`/invoices/${invoiceId}/adjustments`, { amount, reason }), { success: t('bill.adjusted'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('bill.adjustTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid || (amount! < 0 && !can('discounts.apply'))} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">{t('bill.adjustHint')}</p>
        <MoneyField label={t('bill.adjustAmount')} required allowNegative currency={me.settings.currency} value={amount} onChange={setAmount} />
        <TextArea label={t('common.reason')} required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}
