import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Printer } from 'lucide-react';
import { api, ApiError, newKey } from '@/lib/api';
import { useAction, useErrorText } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, Loading, MoneyField, SelectField, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { PAYMENT_METHODS } from '@shared/domain';
import type { InvoiceDetail } from './InvoiceDrawer';
import type { TKey } from '@/i18n/en';

export interface PaymentTarget {
  invoiceId: number;
  kind?: 'payment' | 'deposit';
  suggestedAmount?: number;
}

export function PaymentDialog({ target, onClose }: { target: PaymentTarget; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { me } = useSession();
  const errorText = useErrorText();
  const q = useQuery({ queryKey: ['invoice', target.invoiceId], queryFn: () => api.get<InvoiceDetail>(`/invoices/${target.invoiceId}`) });
  const balance = q.data?.balance.balance ?? 0;
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('cash');
  const [reference, setReference] = useState('');
  const [kind, setKind] = useState<'payment' | 'deposit'>(target.kind ?? 'payment');
  // One key per dialog: double clicks and retries of the same payment are recorded once.
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ paymentId: number } | null>(null);
  useEffect(() => {
    if (q.data && amount === null) setAmount(Math.min(target.suggestedAmount && target.suggestedAmount > 0 ? target.suggestedAmount : balance, balance));
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pay = useAction(() => api.post<{ paymentId: number; duplicate: boolean }>(`/invoices/${target.invoiceId}/payments`, { amount, method, reference: reference || null, kind, idempotencyKey: key }), {
    success: t('bill.paymentRecorded'),
    onSuccess: (r) => setDone({ paymentId: r.paymentId }),
    onError: (e) => {
      setError(e instanceof ApiError && e.code === 'OVERPAYMENT' ? `${t('err.OVERPAYMENT')} (${fmt.money(e.details?.balance ?? balance)})` : errorText(e));
      return true;
    },
  });
  const submit = () => {
    setError(null);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return setError(t('v.positive'));
    if (amount > balance) return setError(t('err.OVERPAYMENT'));
    pay.mutate(undefined);
  };

  if (done) {
    return (
      <Dialog
        open
        size="narrow"
        onClose={onClose}
        title={t('bill.paymentRecorded')}
        footer={
          <>
            <a className="btn" href={`/print/receipt/${done.paymentId}`} target="_blank" rel="noopener">
              <Printer size={15} /> {t('bill.printReceipt')}
            </a>
            <Button variant="primary" onClick={onClose} data-autofocus>
              {t('common.done')}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <CheckCircle2 size={36} style={{ color: 'var(--success)' }} />
          <div className="strong">{fmt.money(amount ?? 0)}</div>
          <div className="small muted">{t(`method.${method}` as TKey)}</div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('bill.paymentTitle')}
      subtitle={q.data ? `${q.data.invoice.number} · ${q.data.invoice.patientName}` : undefined}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={pay.isPending} disabled={!q.data || balance <= 0} onClick={submit}>
            {t('bill.recordPayment')}
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : (
        <div className="stack">
          <p className="small">{t('bill.paymentHint', { balance: fmt.money(balance) })}</p>
          {balance <= 0 && <Callout tone="success">{t('err.INVOICE_ALREADY_PAID')}</Callout>}
          {error && <Callout tone="danger">{error}</Callout>}
          <MoneyField label={t('common.amount')} required currency={me.settings.currency} value={amount} onChange={setAmount} />
          <div className="row wrap">
            <Button size="xs" variant="ghost" onClick={() => setAmount(balance)}>
              {t('common.total')}: {fmt.money(balance)}
            </Button>
          </div>
          <SelectField label={t('common.method')} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`method.${m}` as TKey)}
              </option>
            ))}
          </SelectField>
          {method !== 'cash' && <TextField label={t('bill.reference')} value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr" />}
          {q.data?.invoice.kind === 'service' && (
            <SelectField label={t('common.type')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="payment">{t('bill.kindPayment')}</option>
              <option value="deposit">{t('bill.kindDeposit')}</option>
            </SelectField>
          )}
          {amount !== null && !Number.isNaN(amount) && amount > 0 && amount <= balance && (
            <p className="small muted">
              {t('bill.balanceAfter')}: <strong>{fmt.money(balance - amount)}</strong>
            </p>
          )}
          <p className="xs muted">{t('bill.recordingOnly')}</p>
        </div>
      )}
    </Dialog>
  );
}
