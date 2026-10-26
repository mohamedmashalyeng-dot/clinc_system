import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PackagePlus, Pencil, Plus, Search, SlidersHorizontal, Trash } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction, useForm, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, EmptyState, ErrorState, Loading, MoneyField, Pagination, Panel, SelectField, Tabs, TextArea, TextField } from '@/components/ui';
import { Dialog, Drawer } from '@/components/overlays';
import { inventoryItemSchema } from '@shared/schemas';
import type { Batch, Paged } from '@/lib/types';
import type { TKey } from '@/i18n/en';

interface Item {
  id: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  supplier: string | null;
  reorderThreshold: number;
  unitCost: number;
  active: boolean;
  onHand: number;
  usableOnHand: number;
  lowStock: boolean;
  expiringBatches: number;
  expiredBatchesWithStock: number;
  nextExpiry: string | null;
}

interface Movement {
  id: number;
  itemId: number;
  batchId: number;
  type: 'purchase' | 'usage' | 'waste' | 'adjustment';
  quantity: number;
  reason: string | null;
  reference: string | null;
  sessionId: number | null;
  overrideReason: string | null;
  createdAt: string;
  createdByName: string | null;
  batchNumber: string;
  itemName?: string;
  unit?: string;
  sku?: string;
}

const TYPE_TONE = { purchase: 'success', usage: 'accent', waste: 'danger', adjustment: 'info' } as const;

export function InventoryPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [s, set] = useUrlState({ tab: 'items', filter: 'active', q: '', page: '1', type: '', from: '', to: '' });
  const [receive, setReceive] = useState<number | 'any' | null>(null);
  const [itemDlg, setItemDlg] = useState<Item | 'new' | null>(null);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('inv.title')}</h1>
        {can('inventory.manage') && (
          <div className="toolbar">
            <Button icon={<Plus size={16} />} onClick={() => setItemDlg('new')}>
              {t('inv.newItem')}
            </Button>
            <Button variant="primary" icon={<PackagePlus size={16} />} onClick={() => setReceive('any')}>
              {t('inv.receive')}
            </Button>
          </div>
        )}
      </div>
      <Tabs
        label={t('inv.title')}
        tabs={[
          { id: 'items', label: t('inv.items') },
          { id: 'movements', label: t('inv.movements') },
        ]}
        value={s.tab as 'items' | 'movements'}
        onChange={(v) => set({ tab: v, page: '1' })}
      />
      {s.tab === 'items' ? <Items s={s} set={set} onReceive={(id) => setReceive(id)} onEdit={(i) => setItemDlg(i)} /> : <Movements s={s} set={set} />}
      {receive !== null && <ReceiveDialog itemId={receive === 'any' ? null : receive} onClose={() => setReceive(null)} />}
      {itemDlg && <ItemDialog item={itemDlg === 'new' ? null : itemDlg} onClose={() => setItemDlg(null)} />}
    </div>
  );
}

type S = Record<string, string>;

function Items({ s, set, onReceive, onEdit }: { s: S; set: (p: Partial<S>) => void; onReceive: (id: number) => void; onEdit: (i: Item) => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const [open, setOpen] = useState<number | null>(null);
  const page = Number(s.page) || 1;
  const q = useQuery({ queryKey: ['inventory', s.filter, s.q, page], queryFn: () => api.get<Paged<Item>>('/inventory/items', { filter: s.filter, q: s.q, page, pageSize: 25 }), placeholderData: (p) => p });
  return (
    <Panel flush>
      <div className="row wrap between" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <div className="input-group" style={{ width: 280 }}>
          <Search size={15} aria-hidden />
          <input className="input input-sm" type="search" placeholder={t('common.search')} aria-label={t('common.search')} value={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} />
        </div>
        <div className="row wrap">
          {(['active', 'low', 'expiring', 'inactive', 'all'] as const).map((f) => (
            <button key={f} className="chip" aria-pressed={s.filter === f} onClick={() => set({ filter: f, page: '1' })}>
              {f === 'all' ? t('common.all') : t(`inv.filter.${f}` as TKey)}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('inv.empty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('inv.name')}</th>
                <th>{t('inv.category')}</th>
                <th className="num">{t('inv.usable')}</th>
                <th className="num">{t('inv.threshold')}</th>
                <th>{t('inv.nextExpiry')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((i) => (
                <tr key={i.id} className="clickable" tabIndex={0} onClick={() => setOpen(i.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(i.id)} style={{ opacity: i.active ? 1 : 0.6 }}>
                  <td>
                    <div className="strong">{i.name}</div>
                    <div className="xs muted ltr">{i.sku}</div>
                  </td>
                  <td className="small">{i.category}</td>
                  <td className="num strong" style={{ color: i.lowStock ? 'var(--danger)' : undefined }}>
                    {fmt.num(i.usableOnHand)} <span className="xs muted">{i.unit}</span>
                    {i.onHand !== i.usableOnHand && <div className="xs muted">{t('inv.onHand')}: {fmt.num(i.onHand)}</div>}
                  </td>
                  <td className="num">{fmt.num(i.reorderThreshold)}</td>
                  <td className="nowrap">{i.nextExpiry ? fmt.day(i.nextExpiry) : '—'}</td>
                  <td>
                    <div className="row wrap" style={{ gap: 4 }}>
                      {i.lowStock && <Badge tone="danger">{t('inv.lowBadge')}</Badge>}
                      {i.expiredBatchesWithStock > 0 && <Badge tone="danger">{t('inv.expiredBadge', { n: i.expiredBatchesWithStock })}</Badge>}
                      {i.expiringBatches > 0 && <Badge tone="warning">{t('inv.expiringBadge', { n: i.expiringBatches })}</Badge>}
                      {!i.active && <Badge>{t('common.inactive')}</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
      {open !== null && <ItemDrawer id={open} onClose={() => setOpen(null)} onReceive={onReceive} onEdit={onEdit} />}
    </Panel>
  );
}

function ItemDrawer({ id, onClose, onReceive, onEdit }: { id: number; onClose: () => void; onReceive: (id: number) => void; onEdit: (i: Item) => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const [movement, setMovement] = useState<{ batch: Batch; type: 'waste' | 'adjustment' } | null>(null);
  const q = useQuery({ queryKey: ['inventory-item', id], queryFn: () => api.get<{ item: Item; batches: Batch[]; movements: Movement[] }>(`/inventory/items/${id}`) });
  const d = q.data;
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={d?.item.name ?? t('common.loading')}
      subtitle={d ? `${d.item.sku} · ${d.item.category} · ${d.item.supplier ?? ''}` : undefined}
      actions={
        d &&
        can('inventory.manage') && (
          <>
            <Button size="sm" icon={<Pencil size={14} />} onClick={() => onEdit(d.item)}>
              {t('common.edit')}
            </Button>
            <Button size="sm" variant="primary" icon={<PackagePlus size={14} />} onClick={() => onReceive(d.item.id)}>
              {t('inv.receive')}
            </Button>
          </>
        )
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <div className="stack loose">
          <div className="summary-cards">
            <div className="summary-card">
              <span className="label">{t('inv.usable')}</span>
              <span className="value" style={{ color: d.item.lowStock ? 'var(--danger)' : undefined }}>
                {fmt.num(d.item.usableOnHand)} {d.item.unit}
              </span>
            </div>
            <div className="summary-card">
              <span className="label">{t('inv.threshold')}</span>
              <span className="value">{fmt.num(d.item.reorderThreshold)}</span>
            </div>
            <div className="summary-card">
              <span className="label">{t('inv.unitCost')}</span>
              <span className="value">{fmt.money(d.item.unitCost)}</span>
            </div>
          </div>
          <div className="stack tight">
            <h3 className="section-title">{t('inv.batches')}</h3>
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('inv.batch')}</th>
                    <th>{t('inv.expiry')}</th>
                    <th className="num">{t('inv.onHand')}</th>
                    <th>{t('common.status')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.batches.map((b) => (
                    <tr key={b.id} style={{ opacity: b.onHand <= 0 ? 0.55 : 1 }}>
                      <td className="ltr">{b.batchNumber}</td>
                      <td className="nowrap">{b.expiryDate ? fmt.day(b.expiryDate) : t('inv.noExpiry')}</td>
                      <td className="num">{fmt.num(b.onHand)}</td>
                      <td>
                        {b.expired && b.onHand > 0 && <Badge tone="danger">{t('inv.batchExpired')}</Badge>}
                        {b.expiringSoon && b.onHand > 0 && <Badge tone="warning">{t('inv.batchExpiring')}</Badge>}
                      </td>
                      <td className="nowrap" style={{ textAlign: 'end' }}>
                        {can('inventory.manage') && b.onHand > 0 && (
                          <Button size="xs" variant="ghost" icon={<Trash size={12} />} onClick={() => setMovement({ batch: b, type: 'waste' })}>
                            {t('inv.waste')}
                          </Button>
                        )}
                        {can('inventory.manage') && (
                          <Button size="xs" variant="ghost" icon={<SlidersHorizontal size={12} />} onClick={() => setMovement({ batch: b, type: 'adjustment' })}>
                            {t('inv.adjustment')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="stack tight">
            <h3 className="section-title">{t('inv.movements')}</h3>
            <MovementTable rows={d.movements} unit={d.item.unit} />
          </div>
        </div>
      )}
      {movement && d && <MovementDialog batch={movement.batch} type={movement.type} unit={d.item.unit} onClose={() => setMovement(null)} />}
    </Drawer>
  );
}

function MovementTable({ rows, unit, showItem }: { rows: Movement[]; unit?: string; showItem?: boolean }) {
  const { t } = useI18n();
  const fmt = useFmt();
  if (!rows.length) return <EmptyState title={t('inv.movementsEmpty')} />;
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th>{t('common.date')}</th>
            {showItem && <th>{t('inv.name')}</th>}
            <th>{t('inv.batch')}</th>
            <th>{t('common.type')}</th>
            <th className="num">{t('common.quantity')}</th>
            <th>{t('common.details')}</th>
            <th>{t('common.by')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="nowrap small">{fmt.dateTime(m.createdAt)}</td>
              {showItem && (
                <td className="small">
                  {m.itemName} <span className="xs muted ltr">{m.sku}</span>
                </td>
              )}
              <td className="ltr small">{m.batchNumber}</td>
              <td>
                <Badge tone={TYPE_TONE[m.type]}>{t(`inv.type.${m.type}` as TKey)}</Badge>
              </td>
              <td className="num strong">
                {m.quantity > 0 ? '+' : ''}
                {fmt.num(m.quantity)} <span className="xs muted">{m.unit ?? unit}</span>
              </td>
              <td className="small">
                {m.sessionId ? t('inv.session', { id: m.sessionId }) : m.reason}
                {m.reference && <div className="xs muted ltr">{m.reference}</div>}
                {m.overrideReason && <div className="xs" style={{ color: 'var(--danger)' }}>{t('inv.override', { reason: m.overrideReason })}</div>}
              </td>
              <td className="small nowrap">{m.createdByName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Movements({ s, set }: { s: S; set: (p: Partial<S>) => void }) {
  const { t } = useI18n();
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['movements', s.type, s.from, s.to, page],
    queryFn: () => api.get<Paged<Movement>>('/inventory/movements', { type: s.type, from: s.from, to: s.to, page, pageSize: 25 }),
    placeholderData: (p) => p,
  });
  return (
    <Panel flush>
      <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('common.type')} value={s.type} onChange={(e) => set({ type: e.target.value, page: '1' })}>
          <option value="">{t('inv.allTypes')}</option>
          {(['purchase', 'usage', 'waste', 'adjustment'] as const).map((x) => (
            <option key={x} value={x}>
              {t(`inv.type.${x}` as TKey)}
            </option>
          ))}
        </select>
        <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.from')} value={s.from} onChange={(e) => set({ from: e.target.value, page: '1' })} />
        <span className="muted">–</span>
        <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.to')} value={s.to} min={s.from} onChange={(e) => set({ to: e.target.value, page: '1' })} />
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && <MovementTable rows={q.data.items} showItem />}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
    </Panel>
  );
}

function ReceiveDialog({ itemId, onClose }: { itemId: number | null; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { me } = useSession();
  const items = useQuery({ queryKey: ['inventory', 'all-items'], queryFn: () => api.get<Paged<Item>>('/inventory/items', { filter: 'all', pageSize: 100 }) });
  const [item, setItem] = useState<number | ''>(itemId ?? '');
  const [batch, setBatch] = useState('');
  const [expiry, setExpiry] = useState('');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const selected = items.data?.items.find((i) => i.id === item);
  const save = useAction(
    () => api.post('/inventory/receive', { itemId: item, batchNumber: batch, expiryDate: expiry || null, quantity: Number(qty), unitCost: cost ?? selected?.unitCost ?? 0, reference: reference || null, idempotencyKey: key }),
    { success: t('inv.received'), onSuccess: onClose, onError: () => false },
  );
  const submit = () => {
    setError(null);
    if (!item || !batch.trim() || !(Number(qty) > 0)) return setError(t('common.fixFields'));
    if (expiry && expiry < fmt.today()) return setError(t('inv.batchExpired'));
    save.mutate(undefined);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={!!batch || !!qty}
      title={t('inv.receive')}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('inv.receive')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        {error && (
          <div className="span-2">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}
        <SelectField className="span-2" label={t('inv.name')} required value={item} onChange={(e) => setItem(e.target.value ? Number(e.target.value) : '')} placeholder={t('common.select')}>
          {items.data?.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.sku})
            </option>
          ))}
        </SelectField>
        <TextField label={t('inv.batch')} required dir="ltr" value={batch} onChange={(e) => setBatch(e.target.value)} />
        <TextField label={t('inv.expiry')} type="date" min={fmt.today()} value={expiry} onChange={(e) => setExpiry(e.target.value)} hint={t('common.optional')} />
        <TextField label={`${t('common.quantity')}${selected ? ` (${selected.unit})` : ''}`} type="number" min={0} step="any" required value={qty} onChange={(e) => setQty(e.target.value)} />
        <MoneyField label={t('inv.unitCost')} currency={me.settings.currency} value={cost ?? selected?.unitCost ?? 0} onChange={setCost} />
        <TextField className="span-2" label={t('common.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
    </Dialog>
  );
}

function MovementDialog({ batch, type, unit, onClose }: { batch: Batch; type: 'waste' | 'adjustment'; unit: string; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const [key] = useState(newKey);
  const n = Number(qty);
  const resulting = batch.onHand + (type === 'waste' ? -Math.abs(n) : n);
  const needsOverride = resulting < 0;
  const valid = n !== 0 && Number.isFinite(n) && !!reason.trim() && (!needsOverride || (can('inventory.override') && !!override.trim()));
  const save = useAction(() => api.post('/inventory/movements', { batchId: batch.id, type, quantity: n, reason, idempotencyKey: key, overrideReason: override || undefined }), { success: t('inv.recorded'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('inv.movementTitle', { batch: batch.batchNumber })}
      subtitle={`${t('inv.onHand')}: ${batch.onHand} ${unit}`}
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
        <TextField label={`${t('inv.movementQty')} (${unit})`} type="number" step="any" required value={qty} onChange={(e) => setQty(e.target.value)} hint={type === 'waste' ? t('inv.movementHintWaste') : t('inv.movementHintAdj')} />
        <TextArea label={t('common.reason')} required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        {needsOverride && (can('inventory.override') ? <TextArea label={t('inv.overrideReason')} required rows={2} value={override} onChange={(e) => setOverride(e.target.value)} /> : <Callout tone="danger">{t('ws.problem.insufficient', { item: '', batch: batch.batchNumber, onHand: batch.onHand, unit, requested: Math.abs(n) })}</Callout>)}
      </div>
    </Dialog>
  );
}

function ItemDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const { t } = useI18n();
  const { me } = useSession();
  const form = useForm(
    {
      sku: item?.sku ?? '',
      name: item?.name ?? '',
      category: item?.category ?? '',
      unit: item?.unit ?? 'pc',
      supplier: item?.supplier ?? '',
      reorderThreshold: item?.reorderThreshold ?? 0,
      unitCost: item?.unitCost ?? 0,
      active: item?.active ?? true,
    },
    inventoryItemSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => (item ? api.put(`/inventory/items/${item.id}`, body) : api.post('/inventory/items', body)), {
    success: t('inv.saved'),
    onSuccess: onClose,
    onError: (e) => form.applyServerError(e),
  });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={form.dirty}
      title={item ? t('inv.editItem') : t('inv.newItem')}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <TextField label={t('inv.sku')} required dir="ltr" value={v.sku} error={form.errors.sku} onChange={(e) => form.set('sku', e.target.value)} />
        <TextField label={t('inv.name')} required value={v.name} error={form.errors.name} onChange={(e) => form.set('name', e.target.value)} />
        <TextField label={t('inv.category')} required value={v.category} error={form.errors.category} onChange={(e) => form.set('category', e.target.value)} />
        <TextField label={t('inv.unit')} required value={v.unit} error={form.errors.unit} onChange={(e) => form.set('unit', e.target.value)} />
        <TextField label={t('inv.supplier')} value={v.supplier ?? ''} onChange={(e) => form.set('supplier', e.target.value)} />
        <TextField label={t('inv.threshold')} type="number" min={0} step="any" value={v.reorderThreshold} error={form.errors.reorderThreshold} onChange={(e) => form.set('reorderThreshold', Number(e.target.value))} />
        <MoneyField label={t('inv.unitCost')} currency={me.settings.currency} value={v.unitCost} onChange={(x) => form.set('unitCost', x ?? 0)} />
        <Checkbox label={t('common.active')} checked={v.active} onChange={(x) => form.set('active', x)} />
      </div>
    </Dialog>
  );
}
