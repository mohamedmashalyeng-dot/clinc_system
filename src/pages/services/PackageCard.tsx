import { useState } from 'react';
import { CalendarPlus, CreditCard, FileText, SlidersHorizontal, TimerReset } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Progress, SelectField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { useActions } from '@/layout/actions';
import type { LedgerEntry, PackageSummary } from '@/lib/types';
import type { PatientRef } from '@/components/pickers';
import { diffDays } from '@shared/time';
import type { TKey } from '@/i18n/en';

const STATE_TONE = { active: 'success', expired: 'danger', used_up: 'neutral', cancelled: 'neutral' } as const;

export function PackageCard({ pkg, ledger, patient }: { pkg: PackageSummary; ledger: LedgerEntry[]; patient?: PatientRef }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const [adjust, setAdjust] = useState(false);
  const [extend, setExtend] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const daysLeft = diffDays(fmt.today(), pkg.expiryDate);
  return (
    <div className="pkg-card">
      <div className="panel-head">
        <div>
          <h3>{pick(pkg.nameEn, pkg.nameAr)}</h3>
          <div className="small muted">
            {t('pkg.purchased')} {fmt.day(pkg.purchaseDate)} · {t('pkg.expiry')} {fmt.day(pkg.expiryDate)}
            {pkg.state === 'active' && daysLeft <= 60 && <span style={{ color: 'var(--warning)' }}> · {t('pkg.daysLeft', { n: daysLeft })}</span>}
          </div>
        </div>
        <Badge tone={STATE_TONE[pkg.state]}>{t(`pkg.state.${pkg.state}` as TKey)}</Badge>
      </div>
      <div className="panel-body stack">
        <div className="pkg-items">
          {pkg.items.map((i) => (
            <div key={i.serviceId} className="stack tight" style={{ gap: 4 }}>
              <div className="row between small">
                <span>{pick(i.serviceNameEn, i.serviceNameAr)}</span>
                <span className="strong num">{t('pkg.sessionsUsed', { used: i.used, remaining: i.remaining, total: i.quantity })}</span>
              </div>
              <Progress value={i.used} max={i.quantity} label={pick(i.serviceNameEn, i.serviceNameAr)} />
            </div>
          ))}
        </div>
        <div className="subtle-box row between wrap">
          <div className="small">
            <div>
              {t('pkg.price')}: {fmt.money(pkg.invoiceTotal)}
              {pkg.discount > 0 && <span className="muted"> ({t('pkg.discount')} {fmt.money(pkg.discount)})</span>}
            </div>
            <div>
              {t('bill.paid')}: {fmt.money(pkg.paid)} · {pkg.balance > 0 ? <strong style={{ color: 'var(--warning)' }}>{t('pkg.balance')}: {fmt.money(pkg.balance)}</strong> : <span style={{ color: 'var(--success)' }}>{t('pkg.paidInFull')}</span>}
            </div>
          </div>
          <div className="toolbar">
            {pkg.invoiceId && can('billing.view') && (
              <Button size="xs" variant="ghost" icon={<FileText size={13} />} onClick={() => actions.openInvoice(pkg.invoiceId!)}>
                {pkg.invoiceNumber}
              </Button>
            )}
            {pkg.invoiceId && pkg.balance > 0 && can('payments.record') && (
              <Button size="xs" variant="soft" icon={<CreditCard size={13} />} onClick={() => actions.recordPayment({ invoiceId: pkg.invoiceId! })}>
                {t('bill.recordPayment')}
              </Button>
            )}
          </div>
        </div>
        <div className="toolbar">
          {pkg.state === 'active' && patient && can('appointments.manage') && (
            <Button size="sm" icon={<CalendarPlus size={14} />} onClick={() => actions.book({ patient, serviceId: pkg.items.find((i) => i.remaining > 0)?.serviceId, purchasedPackageId: pkg.id })}>
              {t('pat.book')}
            </Button>
          )}
          {can('packages.adjust') && pkg.status === 'active' && (
            <>
              <Button size="sm" variant="ghost" icon={<SlidersHorizontal size={14} />} onClick={() => setAdjust(true)}>
                {t('pkg.adjust')}
              </Button>
              <Button size="sm" variant="ghost" icon={<TimerReset size={14} />} onClick={() => setExtend(true)}>
                {t('pkg.extend')}
              </Button>
            </>
          )}
          {(pkg.termsEn || pkg.termsAr) && (
            <Button size="sm" variant="ghost" aria-expanded={showTerms} onClick={() => setShowTerms((s) => !s)}>
              {t('pkg.terms')}
            </Button>
          )}
        </div>
        {showTerms && <p className="small muted">{pick(pkg.termsEn, pkg.termsAr)}</p>}
        <div className="stack tight">
          <h4 className="section-title">{t('pkg.ledger')}</h4>
          {!ledger.length ? (
            <p className="small muted">{t('pkg.ledgerEmpty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('appt.service')}</th>
                    <th className="num">±</th>
                    <th>{t('common.details')}</th>
                    <th>{t('common.by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((l) => (
                    <tr key={l.id}>
                      <td className="nowrap">{fmt.dateTime(l.createdAt)}</td>
                      <td>
                        <Badge tone={l.kind === 'consume' ? 'accent' : l.kind === 'reversal' ? 'warning' : 'info'}>{t(`pkg.ledger.${l.kind}` as TKey)}</Badge>
                      </td>
                      <td className="small">{ref.serviceName(l.serviceId)}</td>
                      <td className="num strong" style={{ color: l.delta < 0 ? 'var(--text)' : 'var(--success)' }}>
                        {l.delta > 0 ? `+${l.delta}` : l.delta}
                      </td>
                      <td className="small">
                        {l.startAt && <div>{t('bill.forAppointment', { date: fmt.date(l.startAt) })}</div>}
                        {l.sessionId && <div className="xs muted">{t('inv.session', { id: l.sessionId })}</div>}
                        {l.reason && <div className="xs muted">{l.reason}</div>}
                      </td>
                      <td className="small nowrap">{l.byName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {adjust && <AdjustDialog pkg={pkg} onClose={() => setAdjust(false)} />}
      {extend && <ExtendDialog pkg={pkg} onClose={() => setExtend(false)} />}
    </div>
  );
}

function AdjustDialog({ pkg, onClose }: { pkg: PackageSummary; onClose: () => void }) {
  const { t, pick } = useI18n();
  const [serviceId, setServiceId] = useState(pkg.items[0]?.serviceId ?? 0);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(newKey);
  const n = Number(delta);
  const valid = Number.isInteger(n) && n !== 0 && !!reason.trim();
  const save = useAction(() => api.post(`/packages/${pkg.id}/adjust`, { serviceId, delta: n, reason, idempotencyKey: key }), { success: t('pkg.adjusted'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('pkg.adjustTitle')}
      subtitle={pick(pkg.nameEn, pkg.nameAr)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">{t('pkg.adjustHint')}</p>
        <SelectField label={t('appt.service')} value={serviceId} onChange={(e) => setServiceId(Number(e.target.value))}>
          {pkg.items.map((i) => (
            <option key={i.serviceId} value={i.serviceId}>
              {pick(i.serviceNameEn, i.serviceNameAr)} ({t('pkg.remaining')}: {i.remaining})
            </option>
          ))}
        </SelectField>
        <TextField label={t('pkg.delta')} type="number" required value={delta} onChange={(e) => setDelta(e.target.value)} error={delta && !Number.isInteger(n) ? t('v.invalid') : undefined} />
        <TextArea label={t('common.reason')} required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

function ExtendDialog({ pkg, onClose }: { pkg: PackageSummary; onClose: () => void }) {
  const { t, pick } = useI18n();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const save = useAction(() => api.post(`/packages/${pkg.id}/extend`, { expiryDate: date, reason }), { success: t('pkg.extended'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('pkg.extendTitle')}
      subtitle={pick(pkg.nameEn, pkg.nameAr)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!date || date <= pkg.expiryDate || !reason.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label={t('pkg.newExpiry')} type="date" required min={pkg.expiryDate} value={date} onChange={(e) => setDate(e.target.value)} />
        <TextArea label={t('common.reason')} required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}
