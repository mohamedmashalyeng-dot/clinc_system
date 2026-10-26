import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useForm, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Checkbox, EmptyState, ErrorState, Loading, MoneyField, Pagination, Panel, SelectField, Tabs, TextArea, TextField } from '@/components/ui';
import { Dialog, Drawer } from '@/components/overlays';
import { categorySchema, packageTemplateSchema, serviceSchema } from '@shared/schemas';
import type { Category, LedgerEntry, PackageSummary, PackageTemplate, Paged, Service } from '@/lib/types';
import { PackageCard } from './PackageCard';
import type { TKey } from '@/i18n/en';

type Tab = 'services' | 'templates' | 'sold';

export function ServicesPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [s, set] = useUrlState({ tab: can('packages.view') ? 'sold' : 'services' });
  const tabs: { id: Tab; label: string }[] = [
    ...(can('packages.view') ? [{ id: 'sold' as Tab, label: t('pkg.soldList') }] : []),
    { id: 'services', label: t('svc.title') },
    { id: 'templates', label: t('pkg.templates') },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('nav.services')}</h1>
      </div>
      <Tabs label={t('nav.services')} tabs={tabs} value={s.tab as Tab} onChange={(v) => set({ tab: v })} />
      {s.tab === 'services' && <ServicesConfig />}
      {s.tab === 'templates' && <PackageTemplatesConfig />}
      {s.tab === 'sold' && can('packages.view') && <SoldPackages />}
    </div>
  );
}

export function ServicesConfig() {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const [edit, setEdit] = useState<Service | 'new' | null>(null);
  const [cat, setCat] = useState<Category | 'new' | null>(null);
  if (!ref.ready) return <Loading />;
  const editable = can('settings.manage');
  return (
    <div className="stack">
      <Panel
        title={t('svc.title')}
        flush
        actions={
          editable && (
            <>
              <Button size="sm" icon={<Plus size={15} />} onClick={() => setCat('new')}>
                {t('svc.newCategory')}
              </Button>
              <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>
                {t('svc.new')}
              </Button>
            </>
          )
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('svc.category')}</th>
                <th className="num">{t('appt.duration')}</th>
                <th className="num">{t('svc.price')}</th>
                <th className="num">{t('svc.deposit')}</th>
                <th>{t('svc.qualification')}</th>
                <th>{t('svc.rooms')}</th>
                <th>{t('appt.device')}</th>
                <th className="num">±</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {ref.data!.categories.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td colSpan={10} style={{ background: 'var(--surface-2)' }}>
                      <div className="row between">
                        <strong>{pick(c.nameEn, c.nameAr)}</strong>
                        {editable && (
                          <Button size="xs" variant="ghost" icon={<Pencil size={12} />} onClick={() => setCat(c)}>
                            {t('common.edit')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {ref.data!.services
                    .filter((s) => s.categoryId === c.id)
                    .map((s) => (
                      <tr key={s.id} className={editable ? 'clickable' : ''} onClick={() => editable && setEdit(s)} style={{ opacity: s.active ? 1 : 0.6 }}>
                        <td>
                          <div className="strong">{pick(s.nameEn, s.nameAr)}</div>
                        </td>
                        <td className="small">{ref.categoryName(s.categoryId)}</td>
                        <td className="num">{t('common.minutes', { n: s.durationMin })}</td>
                        <td className="num">{fmt.money(s.price)}</td>
                        <td className="num">{s.depositAmount ? fmt.money(s.depositAmount) : '—'}</td>
                        <td className="small">{s.qualification ? ref.qualificationName(s.qualification) : '—'}</td>
                        <td className="small">{s.roomIds.length ? s.roomIds.map((r) => ref.roomName(r)).join(', ') : t('common.all')}</td>
                        <td className="small">{s.deviceIds.length ? s.deviceIds.map((d) => ref.deviceName(d)).join(', ') : '—'}</td>
                        <td className="num small">
                          {s.bufferBeforeMin}/{s.bufferAfterMin}
                        </td>
                        <td>{s.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {edit && <ServiceDialog service={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {cat && <CategoryDialog category={cat === 'new' ? null : cat} onClose={() => setCat(null)} />}
    </div>
  );
}

function ServiceDialog({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const { me } = useSession();
  const form = useForm(
    {
      nameEn: service?.nameEn ?? '',
      nameAr: service?.nameAr ?? '',
      categoryId: service?.categoryId ?? ref.data!.categories[0]?.id ?? 0,
      durationMin: service?.durationMin ?? 30,
      price: service?.price ?? 0,
      depositAmount: service?.depositAmount ?? 0,
      qualification: service?.qualification ?? '',
      roomIds: service?.roomIds ?? ([] as number[]),
      deviceIds: service?.deviceIds ?? ([] as number[]),
      bufferBeforeMin: service?.bufferBeforeMin ?? 5,
      bufferAfterMin: service?.bufferAfterMin ?? 10,
      active: service?.active ?? true,
    },
    serviceSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => (service ? api.put(`/services/${service.id}`, body) : api.post('/services', body)), {
    success: t('svc.saved'),
    onSuccess: onClose,
    onError: (e) => form.applyServerError(e),
  });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  const toggle = (k: 'roomIds' | 'deviceIds', id: number) => form.set(k, v[k].includes(id) ? v[k].filter((x) => x !== id) : [...v[k], id]);
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      dirty={form.dirty}
      title={service ? t('svc.edit') : t('svc.new')}
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
        <TextField label={t('svc.nameEn')} required value={v.nameEn} error={form.errors.nameEn} onChange={(e) => form.set('nameEn', e.target.value)} />
        <TextField label={t('svc.nameAr')} required dir="rtl" value={v.nameAr} error={form.errors.nameAr} onChange={(e) => form.set('nameAr', e.target.value)} />
        <SelectField label={t('svc.category')} value={v.categoryId} onChange={(e) => form.set('categoryId', Number(e.target.value))}>
          {ref.data!.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {pick(c.nameEn, c.nameAr)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('svc.duration')} type="number" min={5} max={480} step={5} required value={v.durationMin} error={form.errors.durationMin} onChange={(e) => form.set('durationMin', Number(e.target.value))} />
        <MoneyField label={t('svc.price')} required currency={me.settings.currency} value={v.price} error={form.errors.price} onChange={(x) => form.set('price', x ?? 0)} />
        <MoneyField label={t('svc.deposit')} currency={me.settings.currency} value={v.depositAmount} error={form.errors.depositAmount} onChange={(x) => form.set('depositAmount', x ?? 0)} />
        <SelectField label={t('svc.qualification')} value={v.qualification ?? ''} onChange={(e) => form.set('qualification', e.target.value)}>
          <option value="">{t('svc.anyQualification')}</option>
          {ref.data!.qualifications.map((q) => (
            <option key={q.code} value={q.code}>
              {pick(q.nameEn, q.nameAr)}
            </option>
          ))}
        </SelectField>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <TextField label={t('svc.bufferBefore')} type="number" min={0} max={120} value={v.bufferBeforeMin} error={form.errors.bufferBeforeMin} onChange={(e) => form.set('bufferBeforeMin', Number(e.target.value))} />
          <TextField label={t('svc.bufferAfter')} type="number" min={0} max={120} value={v.bufferAfterMin} error={form.errors.bufferAfterMin} onChange={(e) => form.set('bufferAfterMin', Number(e.target.value))} />
        </div>
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('svc.rooms')}</legend>
          <div className="slot-chips">
            {ref.data!.rooms.map((r) => (
              <button type="button" key={r.id} className="chip" aria-pressed={v.roomIds.includes(r.id)} onClick={() => toggle('roomIds', r.id)}>
                {ref.roomName(r.id)}
              </button>
            ))}
          </div>
          <span className="field-hint">{t('svc.roomsHint')}</span>
        </fieldset>
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('svc.devices')}</legend>
          <div className="slot-chips">
            {ref.data!.devices.map((d) => (
              <button type="button" key={d.id} className="chip" aria-pressed={v.deviceIds.includes(d.id)} onClick={() => toggle('deviceIds', d.id)}>
                {ref.deviceName(d.id)}
              </button>
            ))}
          </div>
          <span className="field-hint">{t('svc.devicesHint')}</span>
        </fieldset>
        <Checkbox label={t('common.active')} checked={v.active} onChange={(x) => form.set('active', x)} />
      </div>
    </Dialog>
  );
}

function CategoryDialog({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const { t } = useI18n();
  const form = useForm({ nameEn: category?.nameEn ?? '', nameAr: category?.nameAr ?? '', active: category?.active ?? true }, categorySchema);
  const save = useAction((body: unknown) => (category ? api.put(`/service-categories/${category.id}`, body) : api.post('/service-categories', body)), {
    success: t('common.saved'),
    onSuccess: onClose,
  });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      dirty={form.dirty}
      title={t('svc.categories')}
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
      <div className="stack">
        <TextField label={`${t('set.categoryName')} (EN)`} required value={form.values.nameEn} error={form.errors.nameEn} onChange={(e) => form.set('nameEn', e.target.value)} />
        <TextField label={`${t('set.categoryName')} (AR)`} required dir="rtl" value={form.values.nameAr} error={form.errors.nameAr} onChange={(e) => form.set('nameAr', e.target.value)} />
        <Checkbox label={t('common.active')} checked={form.values.active} onChange={(x) => form.set('active', x)} />
      </div>
    </Dialog>
  );
}

export function PackageTemplatesConfig() {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const [edit, setEdit] = useState<PackageTemplate | 'new' | null>(null);
  if (!ref.ready) return <Loading />;
  return (
    <Panel
      title={t('pkg.templates')}
      flush
      actions={
        can('settings.manage') && (
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>
            {t('pkg.newTemplate')}
          </Button>
        )
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('pkg.items')}</th>
              <th className="num">{t('pkg.price')}</th>
              <th>{t('pkg.validityCol')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {ref.data!.packageTemplates.map((p) => (
              <tr key={p.id} className={can('settings.manage') ? 'clickable' : ''} onClick={() => can('settings.manage') && setEdit(p)} style={{ opacity: p.active ? 1 : 0.6 }}>
                <td className="strong">{pick(p.nameEn, p.nameAr)}</td>
                <td className="small">{p.items.map((i) => `${ref.serviceName(i.serviceId)} × ${i.quantity}`).join(' · ')}</td>
                <td className="num">{fmt.money(p.price)}</td>
                <td>{t('common.days', { n: p.validityDays })}</td>
                <td>{p.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TemplateDialog tpl={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function TemplateDialog({ tpl, onClose }: { tpl: PackageTemplate | null; onClose: () => void }) {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const { me } = useSession();
  const form = useForm(
    {
      nameEn: tpl?.nameEn ?? '',
      nameAr: tpl?.nameAr ?? '',
      price: tpl?.price ?? 0,
      validityDays: tpl?.validityDays ?? 365,
      termsEn: tpl?.termsEn ?? '',
      termsAr: tpl?.termsAr ?? '',
      active: tpl?.active ?? true,
      items: tpl?.items ?? [{ serviceId: ref.data!.services[0]?.id ?? 0, quantity: 6 }],
    },
    packageTemplateSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => (tpl ? api.put(`/package-templates/${tpl.id}`, body) : api.post('/package-templates', body)), {
    success: t('common.saved'),
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
      size="wide"
      onClose={onClose}
      dirty={form.dirty}
      title={tpl ? t('pkg.editTemplate') : t('pkg.newTemplate')}
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
        <TextField label={t('svc.nameEn')} required value={v.nameEn} error={form.errors.nameEn} onChange={(e) => form.set('nameEn', e.target.value)} />
        <TextField label={t('svc.nameAr')} required dir="rtl" value={v.nameAr} error={form.errors.nameAr} onChange={(e) => form.set('nameAr', e.target.value)} />
        <MoneyField label={t('pkg.price')} required currency={me.settings.currency} value={v.price} error={form.errors.price} onChange={(x) => form.set('price', x ?? 0)} />
        <TextField label={t('pkg.validityDays')} type="number" min={1} max={1825} required value={v.validityDays} error={form.errors.validityDays} onChange={(e) => form.set('validityDays', Number(e.target.value))} />
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('pkg.items')}</legend>
          {form.errors.items && <span className="field-error">{form.errors.items}</span>}
          {v.items.map((it, i) => (
            <div key={i} className="row">
              <select className="select grow" aria-label={t('appt.service')} value={it.serviceId} onChange={(e) => form.set('items', v.items.map((x, j) => (j === i ? { ...x, serviceId: Number(e.target.value) } : x)))}>
                {ref.data!.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {pick(s.nameEn, s.nameAr)}
                  </option>
                ))}
              </select>
              <input className="input num" style={{ width: 90 }} type="number" min={1} max={100} aria-label={t('common.quantity')} value={it.quantity} onChange={(e) => form.set('items', v.items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
              <Button variant="ghost" icon={<Trash2 size={16} />} aria-label={t('common.remove')} disabled={v.items.length === 1} onClick={() => form.set('items', v.items.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => form.set('items', [...v.items, { serviceId: ref.data!.services[0].id, quantity: 1 }])}>
              {t('pkg.addService')}
            </Button>
          </div>
        </fieldset>
        <TextArea label={`${t('pkg.terms')} (EN)`} rows={3} value={v.termsEn ?? ''} onChange={(e) => form.set('termsEn', e.target.value)} />
        <TextArea label={`${t('pkg.terms')} (AR)`} rows={3} dir="rtl" value={v.termsAr ?? ''} onChange={(e) => form.set('termsAr', e.target.value)} />
        <Checkbox label={t('common.active')} checked={v.active} onChange={(x) => form.set('active', x)} />
      </div>
    </Dialog>
  );
}

function SoldPackages() {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const [s, set] = useUrlState({ tab: 'sold', state: '', q: '', page: '1' });
  const [open, setOpen] = useState<number | null>(null);
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['packages', s.state, s.q, page],
    queryFn: () => api.get<Paged<PackageSummary & { patientName: string; patientCode: string; daysToExpiry: number }>>('/packages', { state: s.state, q: s.q, page, pageSize: 20 }),
    placeholderData: (p) => p,
  });
  return (
    <Panel flush>
      <div className="row wrap between" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <div className="input-group" style={{ width: 280 }}>
          <Search size={15} aria-hidden />
          <input className="input input-sm" type="search" placeholder={t('common.search')} aria-label={t('common.search')} value={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} />
        </div>
        <div className="row wrap">
          {['', 'active', 'expiring', 'with_balance', 'expired', 'used_up'].map((st) => (
            <button key={st} className="chip" aria-pressed={s.state === st} onClick={() => set({ state: st, page: '1' })}>
              {st === '' ? t('common.all') : st === 'expiring' ? t('pkg.filter.expiring') : st === 'with_balance' ? t('pkg.filter.with_balance') : t(`pkg.state.${st}` as TKey)}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('pkg.none')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('pkg.patient')}</th>
                <th>{t('pkg.template')}</th>
                <th>{t('pkg.purchased')}</th>
                <th>{t('pkg.expiry')}</th>
                <th className="num">{t('pkg.remaining')}</th>
                <th className="num">{t('pkg.balance')}</th>
                <th>{t('pkg.state')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((p) => (
                <tr key={p.id} className="clickable" tabIndex={0} onClick={() => setOpen(p.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(p.id)}>
                  <td>
                    <div className="strong">{p.patientName}</div>
                    <div className="xs muted">{p.patientCode}</div>
                  </td>
                  <td>{pick(p.nameEn, p.nameAr)}</td>
                  <td className="nowrap">{fmt.day(p.purchaseDate)}</td>
                  <td className="nowrap">
                    {fmt.day(p.expiryDate)}
                    {p.state === 'active' && p.daysToExpiry <= 30 && <div className="xs" style={{ color: 'var(--warning)' }}>{t('pkg.daysLeft', { n: p.daysToExpiry })}</div>}
                  </td>
                  <td className="num">
                    {p.remainingSessions}/{p.totalSessions}
                  </td>
                  <td className="num">{p.balance ? fmt.money(p.balance) : '—'}</td>
                  <td>
                    <Badge tone={p.state === 'active' ? 'success' : p.state === 'expired' ? 'danger' : 'neutral'}>{t(`pkg.state.${p.state}` as TKey)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
      {open !== null && <PackageDrawer id={open} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function PackageDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['package', id], queryFn: () => api.get<{ package: PackageSummary; ledger: LedgerEntry[] }>(`/packages/${id}`) });
  return (
    <Drawer open wide onClose={onClose} title={t('pkg.title')}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && <PackageCard pkg={q.data.package} ledger={q.data.ledger} />}
    </Drawer>
  );
}
