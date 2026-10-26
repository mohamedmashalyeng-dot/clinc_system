import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, FilePenLine, Plus, Stethoscope, Undo2 } from 'lucide-react';
import { api, newKey } from '@/lib/api';
import { useAction, useForm } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, EmptyState, ErrorState, KV, Loading, Panel, Progress, SelectField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { treatmentPlanSchema } from '@shared/schemas';
import { BODY_AREAS } from '@shared/domain';
import type { TKey } from '@/i18n/en';

export interface SessionRecord {
  id: number;
  appointmentId: number;
  practitionerId: number;
  serviceId: number;
  status: 'draft' | 'completed' | 'reversed';
  startAt: string;
  completedAt: string | null;
  completedBy: string | null;
  packageEn: string | null;
  packageAr: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  restricted: boolean;
  bodyAreas?: string[];
  assessment?: string | null;
  treatmentNotes?: string | null;
  deviceId?: number | null;
  deviceSettings?: { label: string; value: string }[];
  aftercare?: string | null;
  followUpPlan?: string | null;
  followUpDate?: string | null;
  consumables?: { quantity: number; name: string; unit: string; batchNumber: string }[];
  amendments?: { id: number; reason: string; changes: { field: string; from: string | null; to: string | null }[]; createdAt: string; author: string | null }[];
}

interface Plan {
  id: number;
  title: string;
  serviceId: number | null;
  bodyAreas: string[];
  plannedSessions: number;
  intervalWeeks: number;
  goals: string | null;
  notes: string | null;
  status: 'active' | 'completed' | 'stopped';
  createdByName: string | null;
  createdAt: string;
  completedSessions: number;
}

export function TreatmentTab({ patientId }: { patientId: number }) {
  const { t } = useI18n();
  const { can } = useSession();
  const [planDlg, setPlanDlg] = useState<Plan | 'new' | null>(null);
  const q = useQuery({ queryKey: ['patient-sessions', patientId], queryFn: () => api.get<{ items: SessionRecord[]; plans: Plan[] | null }>(`/patients/${patientId}/sessions`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { items, plans } = q.data!;
  return (
    <div className="stack loose">
      {plans !== null && (
        <Panel
          title={t('tp.plans')}
          actions={
            can('clinical_notes.edit') && (
              <Button size="sm" icon={<Plus size={15} />} onClick={() => setPlanDlg('new')}>
                {t('tp.newPlan')}
              </Button>
            )
          }
        >
          {!plans.length ? (
            <p className="muted small">{t('tp.noPlans')}</p>
          ) : (
            <div className="stack">
              {plans.map((p) => (
                <div key={p.id} className="subtle-box stack tight">
                  <div className="row between wrap">
                    <strong>{p.title}</strong>
                    <div className="row">
                      <Badge tone={p.status === 'active' ? 'accent' : p.status === 'completed' ? 'success' : 'neutral'}>{t(`tp.status.${p.status}` as TKey)}</Badge>
                      {can('clinical_notes.edit') && (
                        <Button size="xs" variant="ghost" onClick={() => setPlanDlg(p)}>
                          {t('common.edit')}
                        </Button>
                      )}
                    </div>
                  </div>
                  <Progress value={p.completedSessions} max={p.plannedSessions} />
                  <div className="small muted">
                    {t('tp.progress', { done: p.completedSessions, total: p.plannedSessions })} · {t('tp.interval')}: {p.intervalWeeks} · {p.createdByName}
                  </div>
                  {p.goals && <div className="small">{p.goals}</div>}
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
      <Panel title={t('tp.sessions')}>
        {items.some((s) => s.restricted) && (
          <div style={{ marginBottom: 12 }}>
            <Callout tone="neutral">{t('tp.restrictedNotes')}</Callout>
          </div>
        )}
        {!items.length ? <EmptyState title={t('tp.noSessions')} /> : <div className="stack">{items.map((s) => <SessionCard key={s.id} s={s} />)}</div>}
      </Panel>
      {planDlg && <PlanDialog patientId={patientId} plan={planDlg === 'new' ? null : planDlg} onClose={() => setPlanDlg(null)} />}
    </div>
  );
}

export function SessionCard({ s, defaultOpen }: { s: SessionRecord; defaultOpen?: boolean }) {
  const { t, tx, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(!!defaultOpen);
  const [amend, setAmend] = useState(false);
  const [reverse, setReverse] = useState(false);
  const tone = s.status === 'completed' ? 'success' : s.status === 'reversed' ? 'warning' : 'neutral';
  return (
    <div className="subtle-box stack tight" style={{ background: 'var(--surface)' }}>
      <div className="row between wrap">
        <div>
          <div className="strong">
            {fmt.date(s.startAt)} · {ref.serviceName(s.serviceId)}
          </div>
          <div className="small muted">
            {ref.practitionerName(s.practitionerId)}
            {s.packageEn && ` · ${t('pay.package')}: ${pick(s.packageEn, s.packageAr)}`}
            {s.completedBy && ` · ${t('tp.completedBy', { who: s.completedBy })}`}
          </div>
        </div>
        <div className="row wrap">
          <Badge tone={tone}>{t(`tp.sessionStatus.${s.status}` as TKey)}</Badge>
          {s.status === 'draft' && can('treatment.perform') && (
            <Button size="xs" variant="primary" icon={<Stethoscope size={13} />} onClick={() => navigate(`/workspace/${s.appointmentId}`)}>
              {t('appt.openWorkspace')}
            </Button>
          )}
          {s.status === 'completed' && can('clinical_notes.edit') && !s.restricted && (
            <Button size="xs" icon={<FilePenLine size={13} />} onClick={() => setAmend(true)}>
              {t('tp.amend')}
            </Button>
          )}
          {s.status === 'completed' && can('sessions.reverse') && (
            <Button size="xs" variant="ghost" icon={<Undo2 size={13} />} onClick={() => setReverse(true)}>
              {t('tp.reverse')}
            </Button>
          )}
          {!s.restricted && (
            <Button size="xs" variant="ghost" icon={open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} aria-expanded={open} aria-label={t('common.details')} onClick={() => setOpen((o) => !o)} />
          )}
        </div>
      </div>
      {s.status === 'reversed' && <Callout tone="warning">{t('ws.reversedNote', { reason: s.reversalReason ?? '' })}</Callout>}
      {open && !s.restricted && (
        <div className="stack" style={{ paddingTop: 8 }}>
          <KV
            items={[
              [t('tp.areas'), s.bodyAreas?.length ? s.bodyAreas.map((a) => tx(`area.${a}`)).join(', ') : '—'],
              [t('tp.assessment'), <span className="pre-wrap">{s.assessment ?? '—'}</span>],
              [t('tp.notes'), <span className="pre-wrap">{s.treatmentNotes ?? '—'}</span>],
              [t('appt.device'), s.deviceId ? ref.deviceName(s.deviceId) : '—'],
              [t('tp.settings'), s.deviceSettings?.length ? s.deviceSettings.map((d) => `${d.label}: ${d.value}`).join(' · ') : '—'],
              [t('tp.consumables'), s.consumables?.length ? s.consumables.map((c) => `${c.name} ${c.quantity} ${c.unit} (${c.batchNumber})`).join(' · ') : '—'],
              [t('tp.aftercare'), <span className="pre-wrap">{s.aftercare ?? '—'}</span>],
              [t('tp.followUp'), `${s.followUpPlan ?? '—'}${s.followUpDate ? ` (${fmt.day(s.followUpDate)})` : ''}`],
            ]}
          />
          {!!s.amendments?.length && (
            <div className="stack tight">
              <h4 className="section-title">{t('tp.amendments')}</h4>
              {s.amendments.map((a) => (
                <div key={a.id} className="small" style={{ borderInlineStart: '3px solid var(--accent-soft-2)', paddingInlineStart: 10 }}>
                  <div className="muted xs">
                    {fmt.dateTime(a.createdAt)} · {a.author} — {a.reason}
                  </div>
                  {a.changes.map((c, i) => (
                    <div key={i}>{t('tp.changed', { field: tx(`tp.${c.field === 'treatmentNotes' ? 'notes' : c.field === 'followUpPlan' ? 'followUp' : c.field}`, undefined, c.field), from: c.from ?? '—', to: c.to ?? '—' })}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {amend && <AmendDialog s={s} onClose={() => setAmend(false)} />}
      {reverse && <ReverseDialog s={s} onClose={() => setReverse(false)} />}
    </div>
  );
}

function AmendDialog({ s, onClose }: { s: SessionRecord; onClose: () => void }) {
  const { t } = useI18n();
  const init = { assessment: s.assessment ?? '', treatmentNotes: s.treatmentNotes ?? '', aftercare: s.aftercare ?? '', followUpPlan: s.followUpPlan ?? '', reason: '' };
  const form = useForm(init);
  const v = form.values;
  const save = useAction((body: unknown) => api.post(`/sessions/${s.id}/amend`, body), { success: t('tp.amended'), onSuccess: onClose, onError: (e) => form.applyServerError(e) });
  const submit = () => {
    if (!v.reason.trim()) return form.setErrors({ reason: t('v.required') });
    const changes: Record<string, string | null> = {};
    for (const k of ['assessment', 'treatmentNotes', 'aftercare', 'followUpPlan'] as const) if (v[k] !== init[k]) changes[k] = v[k] || null;
    save.mutate({ reason: v.reason, changes });
  };
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      dirty={form.dirty}
      title={t('tp.amend')}
      subtitle={t('ws.locked')}
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
        <TextArea label={t('tp.assessment')} rows={3} value={v.assessment} onChange={(e) => form.set('assessment', e.target.value)} />
        <TextArea label={t('tp.notes')} rows={3} value={v.treatmentNotes} onChange={(e) => form.set('treatmentNotes', e.target.value)} />
        <TextArea label={t('tp.aftercare')} rows={2} value={v.aftercare} onChange={(e) => form.set('aftercare', e.target.value)} />
        <TextArea label={t('tp.followUp')} rows={2} value={v.followUpPlan} onChange={(e) => form.set('followUpPlan', e.target.value)} />
        <TextArea label={t('tp.amendReason')} required rows={2} value={v.reason} error={form.errors.reason} onChange={(e) => form.set('reason', e.target.value)} />
      </div>
    </Dialog>
  );
}

function ReverseDialog({ s, onClose }: { s: SessionRecord; onClose: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(false);
  const [key] = useState(newKey);
  const save = useAction(() => api.post(`/sessions/${s.id}/reverse`, { reason, restock, idempotencyKey: key }), { success: t('tp.reversed'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="narrow"
      onClose={onClose}
      title={t('tp.reverseTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={!reason.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('tp.reverse')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Callout tone="warning">{t('tp.reverseBody')}</Callout>
        <TextArea label={t('common.reason')} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        <Checkbox label={t('tp.restock')} checked={restock} onChange={setRestock} />
      </div>
    </Dialog>
  );
}

function PlanDialog({ patientId, plan, onClose }: { patientId: number; plan: Plan | null; onClose: () => void }) {
  const { t, tx, pick } = useI18n();
  const ref = useRef_();
  const form = useForm(
    {
      title: plan?.title ?? '',
      serviceId: plan?.serviceId ?? (null as number | null),
      bodyAreas: plan?.bodyAreas ?? ([] as string[]),
      plannedSessions: plan?.plannedSessions ?? 6,
      intervalWeeks: plan?.intervalWeeks ?? 4,
      goals: plan?.goals ?? '',
      notes: plan?.notes ?? '',
      status: plan?.status ?? 'active',
    },
    treatmentPlanSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => (plan ? api.put(`/patients/${patientId}/plans/${plan.id}`, body) : api.post(`/patients/${patientId}/plans`, body)), {
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
      title={plan ? t('tp.editPlan') : t('tp.newPlan')}
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
        <TextField className="span-2" label={t('tp.title')} required value={v.title} error={form.errors.title} onChange={(e) => form.set('title', e.target.value)} />
        <SelectField label={t('tp.service')} value={v.serviceId ?? ''} onChange={(e) => form.set('serviceId', e.target.value ? Number(e.target.value) : null)}>
          <option value="">—</option>
          {ref.data?.services.map((s) => (
            <option key={s.id} value={s.id}>
              {pick(s.nameEn, s.nameAr)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('common.status')} value={v.status} onChange={(e) => form.set('status', e.target.value as Plan['status'])}>
          {(['active', 'completed', 'stopped'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`tp.status.${s}` as TKey)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('tp.planned')} type="number" min={1} max={50} value={v.plannedSessions} error={form.errors.plannedSessions} onChange={(e) => form.set('plannedSessions', Number(e.target.value))} />
        <TextField label={t('tp.interval')} type="number" min={0} max={52} value={v.intervalWeeks} error={form.errors.intervalWeeks} onChange={(e) => form.set('intervalWeeks', Number(e.target.value))} />
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('tp.areas')}</legend>
          <div className="slot-chips">
            {BODY_AREAS.map((a) => (
              <button
                type="button"
                key={a}
                className="chip"
                aria-pressed={v.bodyAreas.includes(a)}
                onClick={() => form.set('bodyAreas', v.bodyAreas.includes(a) ? v.bodyAreas.filter((x) => x !== a) : [...v.bodyAreas, a])}
              >
                {tx(`area.${a}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <TextArea className="span-2" label={t('tp.goals')} rows={2} value={v.goals} onChange={(e) => form.set('goals', e.target.value)} />
        <TextArea className="span-2" label={t('common.notes')} rows={2} value={v.notes} onChange={(e) => form.set('notes', e.target.value)} />
      </div>
    </Dialog>
  );
}
