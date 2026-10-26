import { useState } from 'react';
import { api, newKey } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, Checkbox, MoneyField, SelectField, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import type { PatientRef } from '@/components/pickers';
import { addDays } from '@shared/time';
import { PAYMENT_METHODS } from '@shared/domain';
import type { TKey } from '@/i18n/en';

export function SellPackageDialog({ patient, onClose }: { patient: PatientRef; onClose: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can, me } = useSession();
  const templates = (ref.data?.packageTemplates ?? []).filter((p) => p.active);
  const [templateId, setTemplateId] = useState<number | ''>(templates[0]?.id ?? '');
  const [startDate, setStartDate] = useState(fmt.today());
  const [discount, setDiscount] = useState<number | null>(0);
  const [discountReason, setDiscountReason] = useState('');
  const [installments, setInstallments] = useState(1);
  const [payNow, setPayNow] = useState(true);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('cash');
  const [reference, setReference] = useState('');
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const tpl = templateId ? templates.find((x) => x.id === templateId) : undefined;
  const total = tpl ? tpl.price - (discount ?? 0) : 0;
  // Matches the server: whole-pound installments, the last one absorbs the remainder.
  const split = (n: number) => Math.floor(total / n / 100) * 100;
  const firstInstallment = installments > 1 ? split(installments) : total;

  const sell = useAction((body: unknown) => api.post<{ id: number; invoiceId: number }>('/packages', body), { success: t('pkg.sold'), onSuccess: onClose });
  const submit = () => {
    setError(null);
    if (!tpl) return setError(t('v.required'));
    if (discount === null || Number.isNaN(discount) || discount > tpl.price) return setError(t('v.invalid'));
    if (discount > 0 && !discountReason.trim()) return setError(`${t('pkg.discountReason')}: ${t('v.required')}`);
    const pay = payNow ? amount ?? firstInstallment : 0;
    if (payNow && (Number.isNaN(pay) || pay <= 0 || pay > total)) return setError(t('err.OVERPAYMENT'));
    sell.mutate({
      patientId: patient.id,
      templateId: tpl.id,
      startDate,
      discount,
      discountReason: discountReason || null,
      installments,
      initialPayment: payNow ? { amount: pay, method, reference: reference || null } : null,
      idempotencyKey: key,
    });
  };
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      title={t('pkg.sell')}
      subtitle={patient.fullName}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={sell.isPending} onClick={submit}>
            {t('pkg.sell')} · {fmt.money(total)}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="form-grid">
          <SelectField className="span-2" label={t('pkg.template')} required value={templateId} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : '')}>
            {templates.map((p) => (
              <option key={p.id} value={p.id}>
                {pick(p.nameEn, p.nameAr)} · {fmt.money(p.price)}
              </option>
            ))}
          </SelectField>
          {tpl && (
            <div className="span-2 subtle-box small stack tight">
              <div>
                <strong>{t('pkg.items')}: </strong>
                {tpl.items.map((i) => `${ref.serviceName(i.serviceId)} × ${i.quantity}`).join(' · ')}
              </div>
              <div>
                {t('pkg.validity', { n: tpl.validityDays })} → {t('pkg.expiry')} {fmt.day(addDays(startDate, tpl.validityDays))}
              </div>
              {(tpl.termsEn || tpl.termsAr) && <div className="muted">{pick(tpl.termsEn, tpl.termsAr)}</div>}
            </div>
          )}
          <TextField label={t('pkg.startDate')} type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <SelectField label={t('pkg.installments')} hint={t('pkg.installmentsHint')} value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
            {[1, 2, 3, 4, 6].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? t('pkg.paidInFull') : `${n} × ${fmt.money(split(n))}`}
              </option>
            ))}
          </SelectField>
          <MoneyField label={t('pkg.discount')} currency={me.settings.currency} value={discount} onChange={setDiscount} disabled={!can('discounts.apply')} hint={!can('discounts.apply') ? t('pkg.discountNoPerm') : undefined} />
          {(discount ?? 0) > 0 && <TextField label={t('pkg.discountReason')} required value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} />}
        </div>
        <div className="subtle-box stack">
          <Checkbox label={t('pkg.payNow')} checked={payNow} onChange={setPayNow} />
          {payNow && (
            <div className="form-grid">
              <MoneyField label={t('common.amount')} currency={me.settings.currency} value={amount ?? firstInstallment} onChange={setAmount} hint={`${t('common.total')}: ${fmt.money(total)}`} />
              <SelectField label={t('common.method')} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`method.${m}` as TKey)}
                  </option>
                ))}
              </SelectField>
              {method !== 'cash' && <TextField className="span-2" label={t('bill.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />}
            </div>
          )}
          <p className="xs muted">{t('bill.recordingOnly')}</p>
        </div>
      </div>
    </Dialog>
  );
}
