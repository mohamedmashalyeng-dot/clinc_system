import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, FilePlus2, Plus, Printer, Search } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, EmptyState, ErrorState, Loading, MoneyField, Pagination, Panel, SelectField, Tabs, TextField } from '@/components/ui';
import { ConfirmDialog, Dialog } from '@/components/overlays';
import { useActions } from '@/layout/actions';
import { InvoiceStatusBadge } from './InvoiceDrawer';
import { NewInvoiceDialog } from './NewInvoiceDialog';
import { DayClose } from './DayClose';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS } from '@shared/domain';
import type { Paged } from '@/lib/types';
import type { TKey } from '@/i18n/en';

type Tab = 'invoices' | 'payments' | 'expenses' | 'close';

export function BillingPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [s, set] = useUrlState({ tab: 'invoices', status: '', kind: '', from: '', to: '', q: '', page: '1', method: '', category: '' });
  const [newInvoice, setNewInvoice] = useState(false);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'invoices', label: t('bill.invoices') },
    { id: 'payments', label: t('bill.payments') },
    ...(can('expenses.manage') ? [{ id: 'expenses' as Tab, label: t('bill.expenses') }] : []),
    ...(can('payments.record') || can('reports.financial') ? [{ id: 'close' as Tab, label: t('dc.tab') }] : []),
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('bill.title')}</h1>
        {can('payments.record') && (
          <Button variant="primary" icon={<FilePlus2 size={16} />} onClick={() => setNewInvoice(true)}>
            {t('bill.newInvoice')}
          </Button>
        )}
      </div>
      <Callout tone="info">{t('bill.recordingOnly')}</Callout>
      <Tabs label={t('bill.title')} tabs={tabs} value={s.tab as Tab} onChange={(v) => set({ tab: v, page: '1' })} />
      {s.tab === 'invoices' && <Invoices s={s} set={set} />}
      {s.tab === 'payments' && <Payments s={s} set={set} />}
      {s.tab === 'expenses' && can('expenses.manage') && <Expenses s={s} set={set} />}
      {s.tab === 'close' && (can('payments.record') || can('reports.financial')) && <DayClose />}
      {newInvoice && <NewInvoiceDialog onClose={() => setNewInvoice(false)} />}
    </div>
  );
}

type S = Record<string, string>;
type Set = (p: Partial<S>) => void;

function DateFilters({ s, set }: { s: S; set: Set }) {
  const { t } = useI18n();
  return (
    <>
      <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.from')} value={s.from} onChange={(e) => set({ from: e.target.value, page: '1' })} />
      <span className="muted">–</span>
      <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.to')} value={s.to} min={s.from} onChange={(e) => set({ to: e.target.value, page: '1' })} />
    </>
  );
}

function Invoices({ s, set }: { s: S; set: Set }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const actions = useActions();
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['invoices', s.status, s.kind, s.from, s.to, s.q, page],
    queryFn: () => api.get<Paged<any> & { sums: { total: number; balance: number } }>('/invoices', { status: s.status, kind: s.kind, from: s.from, to: s.to, q: s.q, page, pageSize: 20 }),
    placeholderData: (p) => p,
  });
  return (
    <Panel flush>
      <div className="row wrap between" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <div className="row wrap">
          <div className="input-group">
            <Search size={15} aria-hidden />
            <input className="input input-sm" type="search" style={{ width: 220 }} placeholder={t('common.search')} aria-label={t('common.search')} value={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} />
          </div>
          <DateFilters s={s} set={set} />
        </div>
        <div className="row wrap">
          {['', 'outstanding', 'unpaid', 'partially_paid', 'paid', 'void'].map((st) => (
            <button key={st} className="chip" aria-pressed={s.status === st} onClick={() => set({ status: st, page: '1' })}>
              {st ? t(`bill.status.${st}` as TKey) : t('common.all')}
            </button>
          ))}
          <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('bill.kind')} value={s.kind} onChange={(e) => set({ kind: e.target.value, page: '1' })}>
            <option value="">{t('common.all')}</option>
            {['service', 'package', 'custom'].map((k) => (
              <option key={k} value={k}>
                {t(`bill.kind.${k}` as TKey)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {q.data && <div className="small muted" style={{ padding: '8px 14px' }}>{t('bill.sumTotal', { total: fmt.money(q.data.sums.total), balance: fmt.money(q.data.sums.balance) })}</div>}
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('bill.empty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('bill.number')}</th>
                <th>{t('bill.issueDate')}</th>
                <th>{t('appt.patient')}</th>
                <th>{t('bill.kind')}</th>
                <th className="num">{t('common.total')}</th>
                <th className="num">{t('bill.paid')}</th>
                <th className="num">{t('bill.balance')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((i: any) => (
                <tr key={i.id} className="clickable" tabIndex={0} onClick={() => actions.openInvoice(i.id)} onKeyDown={(e) => e.key === 'Enter' && actions.openInvoice(i.id)}>
                  <td className="ltr strong nowrap">{i.number}</td>
                  <td className="nowrap">{fmt.day(i.issueDate)}</td>
                  <td>
                    {i.patientName} <span className="xs muted">{i.patientCode}</span>
                  </td>
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
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
    </Panel>
  );
}

function Payments({ s, set }: { s: S; set: Set }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const actions = useActions();
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['payments', s.from, s.to, s.method, s.q, page],
    queryFn: () => api.get<Paged<any> & { sum: number }>('/payments', { from: s.from, to: s.to, method: s.method, q: s.q, page, pageSize: 25 }),
    placeholderData: (p) => p,
  });
  return (
    <Panel flush>
      <div className="row wrap between" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <div className="row wrap">
          <div className="input-group">
            <Search size={15} aria-hidden />
            <input className="input input-sm" type="search" style={{ width: 220 }} placeholder={t('common.search')} aria-label={t('common.search')} value={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} />
          </div>
          <DateFilters s={s} set={set} />
        </div>
        <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('common.method')} value={s.method} onChange={(e) => set({ method: e.target.value, page: '1' })}>
          <option value="">{t('common.all')}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`method.${m}` as TKey)}
            </option>
          ))}
        </select>
      </div>
      {q.data && <div className="small muted" style={{ padding: '8px 14px' }}>{t('bill.sumPayments', { total: fmt.money(q.data.sum) })}</div>}
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('bill.paymentsEmpty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('bill.receipt')}</th>
                <th>{t('common.date')}</th>
                <th>{t('appt.patient')}</th>
                <th>{t('bill.invoice')}</th>
                <th>{t('common.method')}</th>
                <th className="num">{t('common.amount')}</th>
                <th className="num">{t('bill.refunded')}</th>
                <th>{t('bill.receivedBy')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((p: any) => (
                <tr key={p.id}>
                  <td className="ltr nowrap strong">
                    {p.number}
                    {p.kind === 'deposit' && <div className="xs muted">{t('bill.kindDeposit')}</div>}
                  </td>
                  <td className="nowrap">{fmt.dateTime(p.receivedAt)}</td>
                  <td>{p.patientName}</td>
                  <td>
                    <button className="link-btn ltr" onClick={() => actions.openInvoice(p.invoiceId)}>
                      {p.invoiceNumber}
                    </button>
                  </td>
                  <td>{t(`method.${p.method}` as TKey)}</td>
                  <td className="num">{fmt.money(p.amount)}</td>
                  <td className="num">{p.refunded ? fmt.money(p.refunded) : '—'}</td>
                  <td className="small">{p.receivedByName}</td>
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
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
    </Panel>
  );
}

function Expenses({ s, set }: { s: S; set: Set }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const [add, setAdd] = useState(false);
  const [voiding, setVoiding] = useState<number | null>(null);
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['expenses', s.from, s.to, s.category, page],
    queryFn: () => api.get<Paged<any> & { sum: number }>('/expenses', { from: s.from, to: s.to, category: s.category, page, pageSize: 25 }),
    placeholderData: (p) => p,
  });
  const voidExp = useAction((v: { id: number; reason: string }) => api.post(`/expenses/${v.id}/void`, { reason: v.reason }), { success: t('exp.voided'), onSuccess: () => setVoiding(null) });
  return (
    <Panel
      flush
      actions={
        <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setAdd(true)}>
          {t('exp.new')}
        </Button>
      }
      title={q.data ? t('exp.total', { total: fmt.money(q.data.sum) }) : t('bill.expenses')}
    >
      <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <DateFilters s={s} set={set} />
        <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('common.category')} value={s.category} onChange={(e) => set({ category: e.target.value, page: '1' })}>
          <option value="">{t('common.all')}</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`exp.cat.${c}` as TKey)}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('exp.empty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('common.category')}</th>
                <th>{t('common.description')}</th>
                <th>{t('exp.vendor')}</th>
                <th>{t('common.method')}</th>
                <th className="num">{t('common.amount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((e: any) => (
                <tr key={e.id} style={{ opacity: e.voidedAt ? 0.55 : 1 }}>
                  <td className="nowrap">{fmt.day(e.date)}</td>
                  <td>{t(`exp.cat.${e.category}` as TKey)}</td>
                  <td>
                    {e.description}
                    {e.voidedAt && (
                      <div className="xs">
                        <Badge>{t('exp.voidedLabel')}</Badge> {e.voidReason}
                      </div>
                    )}
                  </td>
                  <td className="small">{e.vendor ?? '—'}</td>
                  <td>{t(`method.${e.method}` as TKey)}</td>
                  <td className="num" style={{ textDecoration: e.voidedAt ? 'line-through' : undefined }}>
                    {fmt.money(e.amount)}
                  </td>
                  <td>
                    {!e.voidedAt && (
                      <Button size="xs" variant="ghost" icon={<Ban size={13} />} onClick={() => setVoiding(e.id)}>
                        {t('exp.void')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
      {add && <ExpenseDialog onClose={() => setAdd(false)} />}
      <ConfirmDialog
        open={voiding !== null}
        title={t('exp.void')}
        reasonLabel={t('common.reason')}
        danger
        confirmLabel={t('exp.void')}
        loading={voidExp.isPending}
        onCancel={() => setVoiding(null)}
        onConfirm={(reason) => voiding && voidExp.mutate({ id: voiding, reason })}
      />
    </Panel>
  );
}

function ExpenseDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { me } = useSession();
  const [date, setDate] = useState(fmt.today());
  const [category, setCategory] = useState<string>('supplies');
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<string>('bank_transfer');
  const [key] = useState(newKey);
  const valid = !!description.trim() && amount !== null && !Number.isNaN(amount) && amount > 0;
  const save = useAction(() => api.post('/expenses', { date, category, description, vendor: vendor || null, amount, method, idempotencyKey: key }), { success: t('exp.recorded'), onSuccess: onClose });
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={!!description || !!amount}
      title={t('exp.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <TextField label={t('common.date')} type="date" required value={date} max={fmt.today()} onChange={(e) => setDate(e.target.value)} />
        <SelectField label={t('common.category')} value={category} onChange={(e) => setCategory(e.target.value)}>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`exp.cat.${c}` as TKey)}
            </option>
          ))}
        </SelectField>
        <TextField className="span-2" label={t('common.description')} required value={description} onChange={(e) => setDescription(e.target.value)} />
        <TextField label={t('exp.vendor')} value={vendor} onChange={(e) => setVendor(e.target.value)} />
        <MoneyField label={t('common.amount')} required currency={me.settings.currency} value={amount} onChange={setAmount} />
        <SelectField label={t('common.method')} value={method} onChange={(e) => setMethod(e.target.value)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {t(`method.${m}` as TKey)}
            </option>
          ))}
        </SelectField>
      </div>
    </Dialog>
  );
}
