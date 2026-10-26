import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, MoneyField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { PatientPicker, type PatientRef } from '@/components/pickers';
import { useActions } from '@/layout/actions';
import { computeInvoiceTotals } from '@shared/money';

interface Line {
  serviceId: number | null;
  description: string;
  quantity: number;
  unitPrice: number | null;
  discount: number | null;
}

export function NewInvoiceDialog({ patient: initial, onClose }: { patient?: PatientRef; onClose: () => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can, me } = useSession();
  const actions = useActions();
  const [patient, setPatient] = useState<PatientRef | null>(initial ?? null);
  const [lines, setLines] = useState<Line[]>([{ serviceId: null, description: '', quantity: 1, unitPrice: null, discount: 0 }]);
  const [discountReason, setDiscountReason] = useState('');
  const [notes, setNotes] = useState('');
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const clean = lines.map((l) => ({ ...l, unitPrice: l.unitPrice ?? 0, discount: l.discount ?? 0 }));
  const totals = computeInvoiceTotals(clean.map((l) => ({ quantity: l.quantity, unitPrice: Number.isNaN(l.unitPrice) ? 0 : l.unitPrice, discount: Number.isNaN(l.discount) ? 0 : l.discount })), me.settings.taxRatePercent);
  const hasDiscount = clean.some((l) => l.discount > 0);
  const save = useAction((body: unknown) => api.post<{ id: number }>('/invoices', body), {
    success: t('bill.invoiceCreated'),
    onSuccess: (r) => {
      onClose();
      actions.openInvoice(r.id);
    },
  });
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = () => {
    setError(null);
    if (!patient) return setError(`${t('appt.patient')}: ${t('v.required')}`);
    if (clean.some((l) => !l.description.trim() || Number.isNaN(l.unitPrice) || Number.isNaN(l.discount) || l.quantity < 1 || l.discount > l.unitPrice * l.quantity)) return setError(t('common.fixFields'));
    if (hasDiscount && !discountReason.trim()) return setError(`${t('bill.discountReason')}: ${t('v.required')}`);
    save.mutate({ patientId: patient.id, lines: clean, discountReason: discountReason || null, notes: notes || null, idempotencyKey: key });
  };
  return (
    <Dialog
      open
      size="xwide"
      onClose={onClose}
      dirty={lines.some((l) => l.description)}
      title={t('bill.newInvoice')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('bill.newInvoice')} · {fmt.money(totals.total)}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Callout tone="danger">{error}</Callout>}
        <PatientPicker label={t('appt.patient')} required value={patient} onChange={setPatient} disabled={!!initial} />
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>{t('appt.service')}</th>
                <th style={{ minWidth: 200 }}>{t('common.description')}</th>
                <th style={{ width: 80 }}>{t('common.quantity')}</th>
                <th style={{ width: 150 }}>{t('bill.unitPrice')}</th>
                <th style={{ width: 150 }}>{t('bill.lineDiscount')}</th>
                <th className="num">{t('bill.lineTotal')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select
                      className="select input-sm"
                      aria-label={t('appt.service')}
                      value={l.serviceId ?? ''}
                      onChange={(e) => {
                        const s = e.target.value ? ref.services.get(Number(e.target.value)) : undefined;
                        setLine(i, { serviceId: s?.id ?? null, description: s ? s.nameEn : l.description, unitPrice: s ? s.price : l.unitPrice });
                      }}
                    >
                      <option value="">—</option>
                      {ref.data?.services
                        .filter((s) => s.active)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {pick(s.nameEn, s.nameAr)}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <input className="input input-sm" aria-label={t('common.description')} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                  </td>
                  <td>
                    <input className="input input-sm num" type="number" min={1} aria-label={t('common.quantity')} value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                  </td>
                  <td>
                    <MoneyField currency={me.settings.currency} value={l.unitPrice} onChange={(v) => setLine(i, { unitPrice: v })} />
                  </td>
                  <td>
                    <MoneyField currency={me.settings.currency} value={l.discount} onChange={(v) => setLine(i, { discount: v })} disabled={!can('discounts.apply')} />
                  </td>
                  <td className="num">{fmt.money(Math.max(0, l.quantity * (l.unitPrice || 0) - (l.discount || 0)))}</td>
                  <td>
                    <Button size="xs" variant="ghost" icon={<Trash2 size={14} />} aria-label={t('common.remove')} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <Button size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => setLines((ls) => [...ls, { serviceId: null, description: '', quantity: 1, unitPrice: null, discount: 0 }])}>
            {t('bill.addLine')}
          </Button>
        </div>
        <div className="grid-2">
          <div className="stack">
            {hasDiscount && <TextField label={t('bill.discountReason')} required value={discountReason} onChange={(e) => setDiscountReason(e.target.value)} />}
            <TextArea label={t('common.notes')} hint={t('common.optional')} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <dl className="kv" style={{ gridTemplateColumns: '1fr auto', alignSelf: 'start' }}>
            <dt>{t('bill.subtotal')}</dt>
            <dd className="num" style={{ textAlign: 'end' }}>{fmt.money(totals.subtotal)}</dd>
            <dt>{t('bill.discounts')}</dt>
            <dd className="num" style={{ textAlign: 'end' }}>−{fmt.money(totals.discountTotal)}</dd>
            {totals.tax > 0 && (
              <>
                <dt>{t('bill.tax', { rate: me.settings.taxRatePercent })}</dt>
                <dd className="num" style={{ textAlign: 'end' }}>{fmt.money(totals.tax)}</dd>
              </>
            )}
            <dt className="strong" style={{ color: 'var(--text)' }}>{t('common.total')}</dt>
            <dd className="num strong" style={{ textAlign: 'end' }}>{fmt.money(totals.total)}</dd>
          </dl>
        </div>
      </div>
    </Dialog>
  );
}
