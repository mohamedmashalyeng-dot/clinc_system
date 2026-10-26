import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, CheckCircle2, ChevronDown, ChevronUp, FileText, Plus, Save, ShieldCheck, ShieldOff, Stethoscope, Trash2 } from 'lucide-react';
import { api, ApiError, newKey } from '@/lib/api';
import { useAction, useErrorText, useForm, useToast } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, ErrorState, KV, Loading, Panel, SelectField, StatusBadge, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { UnsavedChangesGuard } from '@/components/pickers';
import { useActions } from '@/layout/actions';
import { PhotoGallery } from '@/pages/photos/PhotoGallery';
import { SessionCard, type SessionRecord } from '@/pages/patients/tabs/TreatmentTab';
import { sessionDraftSchema } from '@shared/schemas';
import { BODY_AREAS } from '@shared/domain';
import { ageFrom } from '@shared/time';
import type { Alert, Appointment, Batch } from '@/lib/types';
import type { TKey } from '@/i18n/en';

interface WsSession extends Omit<SessionRecord, 'consumables' | 'startAt' | 'restricted' | 'packageEn' | 'packageAr' | 'completedBy'> {
  purchasedPackageId: number | null;
  treatmentPlanId: number | null;
  updatedAt: string;
  updatedBy: string | null;
  completedBy: string | null;
  consumables: { id: number; itemId: number; batchId: number; quantity: number; name: string; unit: string; batchNumber: string; expiryDate: string | null; deducted: boolean }[];
}

interface WorkspaceData {
  appointment: Appointment;
  patient: { id: number; code: string; firstName: string; lastName: string; dob: string | null; gender: string; phone: string };
  medical: { medicalHistory: string | null; allergies: string | null; medications: string | null; skinType: string | null; pregnant: string; precautions: string | null } | null;
  alerts: { alerts: Alert[]; allergies: string | null; precautions: string | null; pregnant: string };
  consents: { treatment: boolean; clinicalPhotography: boolean; marketingPhotography: boolean };
  session: WsSession | null;
  history: (WsSession & { startAt: string })[];
  packages: { id: number; nameEn: string; nameAr: string; expiryDate: string; remaining: number }[];
  plans: { id: number; title: string; plannedSessions: number; status: string }[];
  inventory: { id: number; sku: string; name: string; unit: string; category: string; batches: Batch[] }[];
  aftercareTemplates: { id: number; name: string; bodyEn: string; bodyAr: string }[];
  canOverrideStock: boolean;
}

interface StockProblem {
  type: 'expired' | 'insufficient';
  itemName: string;
  batchNumber: string;
  expiryDate: string | null;
  onHand: number;
  requested: number;
  unit: string;
}

type Draft = {
  bodyAreas: string[];
  assessment: string;
  treatmentNotes: string;
  deviceId: number | null;
  deviceSettings: { label: string; value: string }[];
  consumables: { itemId: number | null; batchId: number | null; quantity: number | '' }[];
  aftercare: string;
  followUpPlan: string;
  followUpDate: string;
  purchasedPackageId: number | null;
  treatmentPlanId: number | null;
};

function draftFrom(s: WsSession | null, a: Appointment): Draft {
  return {
    bodyAreas: s?.bodyAreas ?? [],
    assessment: s?.assessment ?? '',
    treatmentNotes: s?.treatmentNotes ?? '',
    deviceId: s?.deviceId ?? a.deviceId ?? null,
    deviceSettings: s?.deviceSettings ?? [],
    consumables: s?.consumables.map((c) => ({ itemId: c.itemId, batchId: c.batchId, quantity: c.quantity })) ?? [],
    aftercare: s?.aftercare ?? '',
    followUpPlan: s?.followUpPlan ?? '',
    followUpDate: s?.followUpDate ?? '',
    purchasedPackageId: s ? s.purchasedPackageId : a.purchasedPackageId,
    treatmentPlanId: s?.treatmentPlanId ?? null,
  };
}

export function WorkspacePage() {
  const appointmentId = Number(useParams().appointmentId);
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['workspace', appointmentId], queryFn: () => api.get<WorkspaceData>(`/workspace/${appointmentId}`), refetchOnWindowFocus: false });
  const start = useAction(() => api.post(`/appointments/${appointmentId}/session`), { success: t('ws.started') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <div className="page">
      <WorkspaceHeader d={d} />
      {!d.session ? (
        <Panel>
          <div className="stack" style={{ alignItems: 'flex-start' }}>
            {['booked', 'confirmed'].includes(d.appointment.status) && <Callout tone="warning">{t('ws.notCheckedIn')}</Callout>}
            <Button variant="primary" icon={<Stethoscope size={16} />} loading={start.isPending} disabled={!['arrived', 'in_treatment'].includes(d.appointment.status)} onClick={() => start.mutate(undefined)}>
              {t('appt.startTreatment')}
            </Button>
          </div>
        </Panel>
      ) : (
        <div className="workspace">
          <SidePanel d={d} />
          {d.session.status === 'draft' ? <DraftEditor key={d.session.id} d={d} session={d.session} /> : <CompletedView d={d} session={d.session} />}
        </div>
      )}
    </div>
  );
}

function WorkspaceHeader({ d }: { d: WorkspaceData }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const a = d.appointment;
  return (
    <div className="page-head">
      <div>
        <div className="small muted">{t('ws.title')}</div>
        <h1>
          {d.patient.firstName} {d.patient.lastName}
        </h1>
        <div className="row wrap small muted" style={{ gap: 10 }}>
          <span>{ref.serviceName(a.serviceId)}</span>
          <span>
            {fmt.dateShort(a.startAt)} {fmt.time(a.startAt)}–{fmt.time(a.endAt)}
          </span>
          <span>{ref.practitionerName(a.practitionerId)}</span>
          <span>
            {ref.roomName(a.roomId)}
            {a.deviceId ? ` · ${ref.deviceName(a.deviceId)}` : ''}
          </span>
          {a.startedAt && a.status === 'in_treatment' && <span>{t('ws.inTreatmentSince', { time: fmt.time(a.startedAt) })}</span>}
        </div>
      </div>
      <div className="row">
        <StatusBadge status={a.status} />
        <Link className="btn btn-sm" to={`/patients/${d.patient.id}`}>
          <FileText size={15} /> {t('ws.patientFile')}
        </Link>
      </div>
    </div>
  );
}

function SidePanel({ d }: { d: WorkspaceData }) {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const [openHistory, setOpenHistory] = useState<number | null>(null);
  const al = d.alerts;
  const age = ageFrom(d.patient.dob, fmt.today());
  return (
    <aside className="workspace-side" aria-label={t('ws.patient')}>
      <Panel title={t('ws.alerts')}>
        <div className="stack tight">
          <div className="small muted">
            {d.patient.code} · {age !== null ? t('pat.yearsOld', { n: age }) : '—'} · {tx(`pat.gender.${d.patient.gender}`)}
            {d.medical?.skinType && ` · ${t('med.skinType')}: ${d.medical.skinType}`}
          </div>
          {al.alerts.length === 0 && !al.allergies && !al.precautions && <p className="small muted">{t('ws.noAlerts')}</p>}
          {al.alerts.map((a, i) => (
            <div key={i} className={`alert-item ${a.severity}`}>
              <AlertTriangle size={14} aria-hidden /> {a.text}
            </div>
          ))}
          {d.medical && (
            <KV
              stacked
              items={[
                [t('ws.allergies'), d.medical.allergies],
                [t('ws.medications'), d.medical.medications],
                [t('med.precautions'), d.medical.precautions],
                [t('med.pregnant'), tx(`med.pregnant.${d.medical.pregnant}`)],
                [t('med.history'), d.medical.medicalHistory],
              ]}
            />
          )}
        </div>
      </Panel>
      <Panel title={t('ws.consents')}>
        <div className="stack tight">
          {(
            [
              ['ws.consent.treatment', d.consents.treatment],
              ['ws.consent.clinicalPhoto', d.consents.clinicalPhotography],
              ['ws.consent.marketingPhoto', d.consents.marketingPhotography],
            ] as [TKey, boolean][]
          ).map(([k, ok]) => (
            <div key={k} className="row between small">
              <span>{t(k)}</span>
              <Badge tone={ok ? 'success' : k === 'ws.consent.marketingPhoto' ? 'outline' : 'danger'}>
                {ok ? <ShieldCheck size={12} /> : <ShieldOff size={12} />} {ok ? t('ws.consentOk') : t('ws.consentMissing')}
              </Badge>
            </div>
          ))}
          {!d.consents.treatment && (
            <Link className="small" to={`/patients/${d.patient.id}?tab=consents`}>
              {t('con.record')} →
            </Link>
          )}
        </div>
      </Panel>
      <Panel title={t('ws.history')} flush>
        {!d.history.length && <p className="small muted" style={{ padding: 14 }}>{t('ws.noHistory')}</p>}
        {d.history.length > 0 && <p className="xs muted" style={{ padding: '10px 14px 0' }}>{t('ws.readOnlyHistory')}</p>}
        {d.history.map((h) => (
          <div key={h.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <button className="menu-item" aria-expanded={openHistory === h.id} onClick={() => setOpenHistory(openHistory === h.id ? null : h.id)}>
              <span className="grow">
                <span className="strong small">{fmt.date(h.startAt)}</span> <span className="xs muted">· {ref.serviceName(h.serviceId)}</span>
              </span>
              {openHistory === h.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {openHistory === h.id && (
              <div className="small stack tight" style={{ padding: '0 14px 12px' }}>
                {h.bodyAreas?.length ? <div>{h.bodyAreas.map((a) => tx(`area.${a}`)).join(', ')}</div> : null}
                {h.treatmentNotes && <div className="pre-wrap">{h.treatmentNotes}</div>}
                {h.deviceSettings?.length ? (
                  <div className="muted">
                    {ref.deviceName(h.deviceId)} — {h.deviceSettings.map((s) => `${s.label}: ${s.value}`).join(' · ')}
                  </div>
                ) : null}
                {h.aftercare && <div className="muted">{h.aftercare}</div>}
              </div>
            )}
          </div>
        ))}
      </Panel>
    </aside>
  );
}

function DraftEditor({ d, session }: { d: WorkspaceData; session: WsSession }) {
  const { t, tx, pick, lang } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const toast = useToast();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const actions = useActions();
  const service = ref.services.get(d.appointment.serviceId);
  const form = useForm<Draft>(draftFrom(session, d.appointment));
  const v = form.values;
  const [lastSaved, setLastSaved] = useState<string | null>(session.updatedAt);
  const [confirm, setConfirm] = useState(false);
  const [completeKey, setCompleteKey] = useState(newKey);
  const [problems, setProblems] = useState<StockProblem[] | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);

  const devices = service?.deviceIds.length ? (ref.data?.devices ?? []).filter((x) => service.deviceIds.includes(x.id)) : ref.data?.devices.filter((x) => x.id === v.deviceId) ?? [];
  const itemById = useMemo(() => new Map(d.inventory.map((i) => [i.id, i])), [d.inventory]);

  const payload = () => {
    const parsed = sessionDraftSchema.safeParse({
      ...v,
      consumables: v.consumables.map((c) => ({ itemId: c.itemId, batchId: c.batchId, quantity: c.quantity === '' ? 0 : Number(c.quantity) })),
      followUpDate: v.followUpDate || null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[i.path.join('.')] = i.code === 'invalid_type' ? t('v.required') : t('v.invalid');
      form.setErrors(errs);
      toast.error(t('common.fixFields'));
      return null;
    }
    return parsed.data;
  };

  const save = useAction((body: unknown) => api.put(`/sessions/${session.id}`, body), {
    invalidate: false,
    onSuccess: () => {
      form.markClean();
      setLastSaved(new Date().toISOString());
    },
  });

  const saveDraft = async (silent = false) => {
    const body = payload();
    if (!body) return false;
    try {
      await save.mutateAsync(body);
      if (!silent) toast.success(t('ws.draftSaved'));
      return true;
    } catch {
      return false;
    }
  };

  const complete = useAction(
    (override: string | null) => api.post<{ alreadyCompleted: boolean }>(`/sessions/${session.id}/complete`, { idempotencyKey: completeKey, overrideReason: override }),
    {
      success: t('ws.completed'),
      onSuccess: () => {
        setConfirm(false);
        qc.invalidateQueries();
      },
      onError: (e) => {
        if (e instanceof ApiError && (e.code === 'STOCK_BLOCKED' || e.code === 'OVERRIDE_NOT_ALLOWED')) {
          setProblems(e.details?.problems ?? []);
          setBlockError(errorText(e) + (e.code === 'STOCK_BLOCKED' ? '' : ''));
          setCompleteKey(newKey());
          return true;
        }
        setBlockError(errorText(e));
        setCompleteKey(newKey());
        return true;
      },
    },
  );

  const openComplete = async () => {
    setProblems(null);
    setBlockError(null);
    setOverrideReason('');
    if (form.dirty || !lastSaved) {
      const ok = await saveDraft(true);
      if (!ok) return;
    }
    setConfirm(true);
  };

  const pkg = d.packages.find((p) => p.id === v.purchasedPackageId);
  const setConsumable = (i: number, patch: Partial<Draft['consumables'][number]>) => form.set('consumables', v.consumables.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="panel" style={{ overflow: 'visible' }}>
      <UnsavedChangesGuard when={form.dirty} />
      <div className="panel-body stack loose">
        {!d.consents.treatment && <Callout tone="danger">{t('err.TREATMENT_CONSENT_MISSING')}</Callout>}
        {d.appointment.status === 'arrived' && <Callout tone="info">{t('ws.notCheckedIn')}</Callout>}

        <section className="ws-section">
          <h3>
            <span className="ws-step">1</span> {t('ws.step.treatment')}
          </h3>
          <div className="form-grid">
            <TextField label={t('appt.service')} value={ref.serviceName(d.appointment.serviceId)} readOnly disabled />
            <SelectField label={t('ws.packageUse')} value={v.purchasedPackageId ?? ''} onChange={(e) => form.set('purchasedPackageId', e.target.value ? Number(e.target.value) : null)} hint={t('appt.packageHint')}>
              <option value="">{t('ws.packageNone')}</option>
              {d.packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {pick(p.nameEn, p.nameAr)} · {t('pkg.remaining')}: {p.remaining}
                </option>
              ))}
            </SelectField>
            {d.plans.length > 0 && (
              <SelectField label={t('tp.plans')} value={v.treatmentPlanId ?? ''} onChange={(e) => form.set('treatmentPlanId', e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {d.plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
          <fieldset className="stack tight">
            <legend className="field-label">{t('ws.bodyAreas')}</legend>
            <div className="slot-chips">
              {BODY_AREAS.map((a) => (
                <button type="button" key={a} className="chip" aria-pressed={v.bodyAreas.includes(a)} onClick={() => form.set('bodyAreas', v.bodyAreas.includes(a) ? v.bodyAreas.filter((x) => x !== a) : [...v.bodyAreas, a])}>
                  {tx(`area.${a}`)}
                </button>
              ))}
            </div>
          </fieldset>
        </section>

        <section className="ws-section">
          <h3>
            <span className="ws-step">2</span> {t('ws.step.assessment')}
          </h3>
          <TextArea aria-label={t('ws.step.assessment')} rows={3} value={v.assessment} onChange={(e) => form.set('assessment', e.target.value)} maxLength={4000} />
        </section>

        <section className="ws-section">
          <h3>
            <span className="ws-step">3</span> {t('ws.step.device')}
          </h3>
          <SelectField label={t('ws.deviceUsed')} value={v.deviceId ?? ''} onChange={(e) => form.set('deviceId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t('appt.noDevice')}</option>
            {devices.map((x) => (
              <option key={x.id} value={x.id}>
                {ref.deviceName(x.id)}
              </option>
            ))}
          </SelectField>
          <p className="small muted">{t('ws.settingsHint')}</p>
          {v.deviceSettings.map((s, i) => (
            <div key={i} className="settings-row">
              <input className="input" aria-label={t('ws.settingLabel')} placeholder={t('ws.settingLabel')} value={s.label} aria-invalid={!!form.errors[`deviceSettings.${i}.label`]} onChange={(e) => form.set('deviceSettings', v.deviceSettings.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input className="input" aria-label={t('ws.settingValue')} placeholder={t('ws.settingValue')} value={s.value} aria-invalid={!!form.errors[`deviceSettings.${i}.value`]} onChange={(e) => form.set('deviceSettings', v.deviceSettings.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Button variant="ghost" icon={<Trash2 size={16} />} aria-label={t('common.remove')} onClick={() => form.set('deviceSettings', v.deviceSettings.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => form.set('deviceSettings', [...v.deviceSettings, { label: '', value: '' }])}>
              {t('ws.addSetting')}
            </Button>
          </div>
        </section>

        <section className="ws-section">
          <h3>
            <span className="ws-step">4</span> {t('ws.step.notes')}
          </h3>
          <TextArea aria-label={t('ws.step.notes')} rows={4} value={v.treatmentNotes} onChange={(e) => form.set('treatmentNotes', e.target.value)} maxLength={4000} />
        </section>

        <section className="ws-section">
          <h3>
            <span className="ws-step">5</span> {t('ws.step.products')}
          </h3>
          <p className="small muted">{t('ws.productsHint')}</p>
          {v.consumables.map((c, i) => {
            const item = c.itemId ? itemById.get(c.itemId) : undefined;
            const batch = item?.batches.find((b) => b.id === c.batchId);
            const qty = Number(c.quantity);
            const short = batch && qty > batch.onHand;
            return (
              <div key={i} className="stack tight" style={{ gap: 4 }}>
                <div className="consumable-row">
                  <select
                    className="select"
                    aria-label={t('ws.product')}
                    aria-invalid={!!form.errors[`consumables.${i}.itemId`]}
                    value={c.itemId ?? ''}
                    onChange={(e) => {
                      const it = e.target.value ? itemById.get(Number(e.target.value)) : undefined;
                      const first = it?.batches.find((b) => !b.expired && b.onHand > 0);
                      setConsumable(i, { itemId: it?.id ?? null, batchId: first?.id ?? null });
                    }}
                  >
                    <option value="">{t('ws.product')}…</option>
                    {d.inventory.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({it.sku})
                      </option>
                    ))}
                  </select>
                  <select className="select" aria-label={t('ws.batch')} aria-invalid={!!form.errors[`consumables.${i}.batchId`]} value={c.batchId ?? ''} disabled={!item} onChange={(e) => setConsumable(i, { batchId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">{t('ws.batch')}…</option>
                    {item?.batches.map((b) => (
                      <option key={b.id} value={b.id} disabled={b.expired}>
                        {b.batchNumber} · {b.expiryDate ? t('ws.exp', { date: fmt.day(b.expiryDate) }) : t('inv.noExpiry')} · {t('ws.onHand', { n: b.onHand, unit: item.unit })}
                        {b.expired ? ` — ${t('ws.batchExpired')}` : ''}
                      </option>
                    ))}
                  </select>
                  <div className="input-group">
                    <input
                      className="input num"
                      type="number"
                      min={0}
                      step="any"
                      aria-label={t('common.quantity')}
                      aria-invalid={!!form.errors[`consumables.${i}.quantity`] || !!short}
                      value={c.quantity}
                      onChange={(e) => setConsumable(i, { quantity: e.target.value === '' ? '' : Number(e.target.value) })}
                      style={{ paddingInlineEnd: 40 }}
                    />
                    <span className="input-addon">{item?.unit}</span>
                  </div>
                  <Button variant="ghost" icon={<Trash2 size={16} />} aria-label={t('common.remove')} onClick={() => form.set('consumables', v.consumables.filter((_, j) => j !== i))} />
                </div>
                {short && <span className="field-error">{t('ws.problem.insufficient', { item: item!.name, batch: batch!.batchNumber, onHand: batch!.onHand, unit: item!.unit, requested: qty })}</span>}
              </div>
            );
          })}
          <div>
            <Button size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => form.set('consumables', [...v.consumables, { itemId: null, batchId: null, quantity: 1 }])}>
              {t('ws.addProduct')}
            </Button>
          </div>
        </section>

        <section className="ws-section">
          <h3>
            <span className="ws-step">6</span> {t('ws.step.photos')}
          </h3>
          <PhotoGallery patientId={d.patient.id} sessionId={session.id} defaultArea={v.bodyAreas[0]} compact />
        </section>

        <section className="ws-section">
          <h3>
            <span className="ws-step">7</span> {t('ws.step.aftercare')}
          </h3>
          {d.aftercareTemplates.length > 0 && (
            <SelectField
              label={t('ws.insertTemplate')}
              value=""
              onChange={(e) => {
                const tpl = d.aftercareTemplates.find((x) => x.id === Number(e.target.value));
                if (tpl) form.set('aftercare', [v.aftercare, lang === 'ar' ? tpl.bodyAr : tpl.bodyEn].filter(Boolean).join('\n'));
              }}
            >
              <option value="">{t('common.select')}</option>
              {d.aftercareTemplates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SelectField>
          )}
          <TextArea label={t('ws.aftercare')} rows={4} value={v.aftercare} onChange={(e) => form.set('aftercare', e.target.value)} maxLength={3000} />
          <div className="form-grid">
            <TextArea label={t('ws.followUpPlan')} rows={2} value={v.followUpPlan} onChange={(e) => form.set('followUpPlan', e.target.value)} />
            <TextField label={t('ws.followUpDate')} type="date" min={fmt.today()} value={v.followUpDate} onChange={(e) => form.set('followUpDate', e.target.value)} />
          </div>
        </section>
      </div>
      <div className="ws-footer">
        <span className="small muted">
          {form.dirty ? <strong style={{ color: 'var(--warning)' }}>{t('ws.unsaved')}</strong> : lastSaved ? t('ws.lastSaved', { time: fmt.time(lastSaved) }) : ''}
        </span>
        <div className="toolbar">
          <Button icon={<Save size={16} />} loading={save.isPending && !confirm} onClick={() => saveDraft()}>
            {t('ws.saveDraft')}
          </Button>
          <Button variant="primary" icon={<CheckCircle2 size={16} />} disabled={save.isPending} onClick={openComplete}>
            {t('ws.complete')}
          </Button>
        </div>
      </div>

      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(false)}
          title={t('ws.completeTitle')}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
              {problems?.length && d.canOverrideStock ? (
                <Button variant="danger" disabled={!overrideReason.trim()} loading={complete.isPending} onClick={() => complete.mutate(overrideReason.trim())}>
                  {t('ws.override')}
                </Button>
              ) : (
                <Button variant="primary" loading={complete.isPending} disabled={!!problems?.length} onClick={() => complete.mutate(null)}>
                  {t('ws.complete')}
                </Button>
              )}
            </>
          }
        >
          <div className="stack">
            <p>{t('ws.completeIntro')}</p>
            <ul className="stack tight" style={{ margin: 0, paddingInlineStart: 18 }}>
              {pkg ? (
                <li>{t('ws.willUsePackage', { name: pick(pkg.nameEn, pkg.nameAr), remaining: pkg.remaining - 1 })}</li>
              ) : (
                service && service.price > 0 && <li>{t('ws.willInvoice', { service: ref.serviceName(service.id), price: fmt.money(service.price) })}</li>
              )}
              {v.consumables.length ? (
                v.consumables.map((c, i) => {
                  const it = c.itemId ? itemById.get(c.itemId) : undefined;
                  const b = it?.batches.find((x) => x.id === c.batchId);
                  return <li key={i}>{t('ws.willDeduct', { qty: String(c.quantity), unit: it?.unit ?? '', item: it?.name ?? '', batch: b?.batchNumber ?? '' })}</li>;
                })
              ) : (
                <li className="muted">{t('ws.noDeduct')}</li>
              )}
              {v.followUpDate && <li>{t('ws.willFollowUp', { date: fmt.day(v.followUpDate) })}</li>}
            </ul>
            {blockError && !problems?.length && <Callout tone="danger">{blockError}</Callout>}
            {problems && problems.length > 0 && (
              <Callout tone="danger" title={t('ws.stockBlocked')}>
                <ul>
                  {problems.map((p, i) => (
                    <li key={i}>
                      {p.type === 'expired'
                        ? t('ws.problem.expired', { item: p.itemName, batch: p.batchNumber, date: p.expiryDate ? fmt.day(p.expiryDate) : '' })
                        : t('ws.problem.insufficient', { item: p.itemName, batch: p.batchNumber, onHand: p.onHand, unit: p.unit, requested: p.requested })}
                    </li>
                  ))}
                </ul>
                <p className="small" style={{ marginTop: 6 }}>{blockError}</p>
              </Callout>
            )}
            {problems && problems.length > 0 && d.canOverrideStock && <TextArea label={t('ws.overrideReason')} required rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />}
          </div>
        </Dialog>
      )}
      {complete.isSuccess && (
        <Dialog
          open
          size="narrow"
          onClose={() => navigate('/')}
          title={t('ws.completed')}
          footer={
            <>
              <Button
                icon={<CalendarPlus size={15} />}
                onClick={() => actions.book({ patient: { id: d.patient.id, fullName: `${d.patient.firstName} ${d.patient.lastName}`, phone: d.patient.phone }, serviceId: d.appointment.serviceId, practitionerId: d.appointment.practitionerId })}
              >
                {t('appt.bookNext')}
              </Button>
              <Button variant="primary" onClick={() => navigate('/')}>
                {t('common.done')}
              </Button>
            </>
          }
        >
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <CheckCircle2 size={36} style={{ color: 'var(--success)' }} />
            {pkg && <p>{t('ws.willUsePackage', { name: pick(pkg.nameEn, pkg.nameAr), remaining: pkg.remaining - 1 })}</p>}
          </div>
        </Dialog>
      )}
    </div>
  );
}

function CompletedView({ d, session }: { d: WorkspaceData; session: WsSession }) {
  const { t } = useI18n();
  const { can } = useSession();
  const actions = useActions();
  const record: SessionRecord = {
    ...session,
    startAt: d.appointment.startAt,
    restricted: false,
    packageEn: d.appointment.packageEn,
    packageAr: d.appointment.packageAr,
    consumables: session.consumables.map((c) => ({ quantity: c.quantity, name: c.name, unit: c.unit, batchNumber: c.batchNumber })),
  };
  useEffect(() => window.scrollTo(0, 0), []);
  return (
    <div className="stack">
      {session.status === 'completed' && <Callout tone="success">{t('ws.locked')}</Callout>}
      <SessionCard s={record} defaultOpen />
      <Panel title={t('ws.step.photos')}>
        <PhotoGallery patientId={d.patient.id} sessionId={session.id} compact />
      </Panel>
      {can('appointments.manage') && (
        <div>
          <Button
            icon={<CalendarPlus size={15} />}
            onClick={() => actions.book({ patient: { id: d.patient.id, fullName: `${d.patient.firstName} ${d.patient.lastName}`, phone: d.patient.phone }, serviceId: d.appointment.serviceId, practitionerId: d.appointment.practitionerId })}
          >
            {t('appt.bookNext')}
          </Button>
        </div>
      )}
    </div>
  );
}
