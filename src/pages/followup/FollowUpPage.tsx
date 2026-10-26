import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, Check, Copy, MessageSquare, Plus, PlugZap, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useToast, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, EmptyState, ErrorState, Loading, Panel, Segmented, SelectField, Tabs, TextArea, TextField } from '@/components/ui';
import { ConfirmDialog, Dialog } from '@/components/overlays';
import { useActions } from '@/layout/actions';
import { fillTemplate, TEMPLATE_KINDS, TEMPLATE_VARIABLES } from '@shared/domain';
import { addDays } from '@shared/time';
import type { PackageSummary, Paged } from '@/lib/types';
import type { TKey } from '@/i18n/en';

interface Template {
  id: number;
  kind: string;
  name: string;
  bodyEn: string;
  bodyAr: string;
  active: boolean;
  approvedBy: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
}

interface Contactable {
  patientId: number;
  patientName: string;
  phone: string;
  contactChannel: string;
  allowReminders: number | boolean;
  preferredLanguage: string;
}

type Compose = { who: Contactable; kind: string; vars: Record<string, string>; followUpId?: number; appointmentId?: number };

export function FollowUpPage() {
  const { t } = useI18n();
  const [s, set] = useUrlState({ tab: 'due', until: '' });
  const [compose, setCompose] = useState<Compose | null>(null);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('fu.title')}</h1>
      </div>
      <IntegrationStatus />
      <Tabs
        label={t('fu.title')}
        tabs={[
          { id: 'due', label: t('fu.due') },
          { id: 'reminders', label: t('fu.reminders') },
          { id: 'packages', label: t('fu.packages') },
          { id: 'templates', label: t('fu.templates') },
        ]}
        value={s.tab as 'due' | 'reminders' | 'packages' | 'templates'}
        onChange={(v) => set({ tab: v })}
      />
      {s.tab === 'due' && <DueList onCompose={setCompose} />}
      {s.tab === 'reminders' && <Reminders onCompose={setCompose} />}
      {s.tab === 'packages' && <ExpiringPackages until={s.until} onCompose={setCompose} />}
      {s.tab === 'templates' && <Templates />}
      {compose && <ComposeDialog c={compose} onClose={() => setCompose(null)} />}
    </div>
  );
}

function IntegrationStatus() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<{ integrations: Record<string, string> }>('/followup/integrations') });
  const channels = ['whatsapp', 'sms', 'email'];
  return (
    <div className="callout callout-neutral">
      <PlugZap size={16} />
      <div className="grow stack tight">
        <div className="row wrap" style={{ gap: 8 }}>
          <strong>{t('fu.integrations')}:</strong>
          {channels.map((c) => (
            <Badge key={c} tone={q.data?.integrations[c] === 'connected' ? 'success' : 'outline'}>
              {t(`set.int.${c}` as TKey)} · {q.data?.integrations[c] === 'connected' ? t('set.connected') : t('set.notConnected')}
            </Badge>
          ))}
        </div>
        <span className="small">{t('fu.integrationNote')}</span>
      </div>
    </div>
  );
}

function ContactCell({ c }: { c: Contactable }) {
  const { t, tx } = useI18n();
  const opted = !c.allowReminders || c.contactChannel === 'none';
  return (
    <div>
      <Link to={`/patients/${c.patientId}`} className="strong">
        {c.patientName}
      </Link>
      <div className="xs muted">
        <span className="ltr">{c.phone}</span> · {tx(`pat.channel.${c.contactChannel}`)}
      </div>
      {opted && <Badge tone="warning">{c.contactChannel === 'none' ? t('fu.noContact') : t('fu.optedOut')}</Badge>}
    </div>
  );
}

function LastContact({ lc }: { lc: { channel: string; outcome: string; created_at: string } | null }) {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  if (!lc) return <span className="xs muted">{t('fu.never')}</span>;
  return (
    <span className="xs">
      {fmt.dateTime(lc.created_at)} · {tx(`pat.channel.${lc.channel}`)} · {tx(`fu.outcome.${lc.outcome}`)}
    </span>
  );
}

function DueList({ onCompose }: { onCompose: (c: Compose) => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const [closing, setClosing] = useState<{ id: number; status: 'done' | 'dismissed' } | null>(null);
  const q = useQuery({ queryKey: ['followups'], queryFn: () => api.get<{ items: any[] }>('/followup/due') });
  const close = useAction((v: { id: number; status: string; note: string }) => api.post(`/followup/due/${v.id}`, { status: v.status, note: v.note || null }), { success: t('fu.closed'), onSuccess: () => setClosing(null) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Panel flush>
      {!q.data!.items.length && <EmptyState title={t('fu.empty')} />}
      {q.data!.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('fu.dueDate')}</th>
                <th>{t('appt.patient')}</th>
                <th>{t('fu.service')}</th>
                <th>{t('pat.nextVisit')}</th>
                <th>{t('fu.lastContact')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((f) => {
                const who: Contactable = { patientId: f.patientId, patientName: f.patientName, phone: f.phone, contactChannel: f.contactChannel, allowReminders: f.allowReminders, preferredLanguage: f.preferredLanguage };
                const svc = ref.services.get(f.serviceId);
                return (
                  <tr key={f.id}>
                    <td className="nowrap">
                      {fmt.day(f.dueDate)} {f.overdue && <Badge tone="danger">{t('fu.overdue')}</Badge>}
                    </td>
                    <td>
                      <ContactCell c={who} />
                    </td>
                    <td className="small">
                      {ref.serviceName(f.serviceId)}
                      <div className="xs muted">{ref.practitionerName(f.practitionerId)}</div>
                    </td>
                    <td className="small nowrap">{f.nextVisit ? fmt.dateTime(f.nextVisit) : '—'}</td>
                    <td>
                      <LastContact lc={f.lastContact} />
                    </td>
                    <td className="nowrap" style={{ textAlign: 'end' }}>
                      {can('followup.manage') && (
                        <>
                          <Button size="xs" variant="soft" icon={<MessageSquare size={13} />} onClick={() => onCompose({ who, kind: 'followup', vars: { service: svc ? pick(svc.nameEn, svc.nameAr) : '' }, followUpId: f.id })}>
                            {t('fu.prepare')}
                          </Button>
                          <Button size="xs" variant="ghost" icon={<Check size={13} />} onClick={() => setClosing({ id: f.id, status: 'done' })}>
                            {t('fu.markDone')}
                          </Button>
                          <Button size="xs" variant="ghost" icon={<X size={13} />} onClick={() => setClosing({ id: f.id, status: 'dismissed' })}>
                            {t('fu.dismiss')}
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!closing}
        title={closing?.status === 'done' ? t('fu.markDone') : t('fu.dismiss')}
        reasonLabel={t('common.notes')}
        loading={close.isPending}
        onCancel={() => setClosing(null)}
        onConfirm={(note) => closing && close.mutate({ id: closing.id, status: closing.status, note })}
      />
    </Panel>
  );
}

function Reminders({ onCompose }: { onCompose: (c: Compose) => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const [win, setWin] = useState<'3' | '7'>('3');
  const today = fmt.today();
  const q = useQuery({ queryKey: ['reminders', win], queryFn: () => api.get<{ items: any[] }>('/followup/reminders', { from: addDays(today, 1), to: addDays(today, Number(win)) }) });
  return (
    <Panel
      flush
      title={t('fu.reminders')}
      actions={
        <Segmented
          label={t('fu.window')}
          value={win}
          onChange={setWin}
          options={[
            { id: '3', label: t('fu.next3') },
            { id: '7', label: t('fu.next7') },
          ]}
        />
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('fu.remindersEmpty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('appt.patient')}</th>
                <th>{t('appt.service')}</th>
                <th>{t('common.status')}</th>
                <th>{t('fu.lastContact')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((a) => {
                const who: Contactable = { patientId: a.patientId, patientName: a.patientName, phone: a.phone, contactChannel: a.contactChannel, allowReminders: a.allowReminders, preferredLanguage: a.preferredLanguage };
                const svc = ref.services.get(a.serviceId);
                const p = ref.practitioners.get(a.practitionerId);
                return (
                  <tr key={a.id}>
                    <td className="nowrap">{fmt.dateTime(a.startAt)}</td>
                    <td>
                      <ContactCell c={who} />
                    </td>
                    <td className="small">
                      {ref.serviceName(a.serviceId)}
                      <div className="xs muted">{ref.practitionerName(a.practitionerId)}</div>
                    </td>
                    <td>
                      <Badge tone={a.status === 'confirmed' ? 'accent' : 'neutral'}>{t(`status.${a.status}` as TKey)}</Badge>
                    </td>
                    <td>
                      <LastContact lc={a.lastContact} />
                    </td>
                    <td style={{ textAlign: 'end' }}>
                      {can('followup.manage') && (
                        <Button
                          size="xs"
                          variant="soft"
                          icon={<MessageSquare size={13} />}
                          onClick={() =>
                            onCompose({
                              who,
                              kind: 'reminder',
                              appointmentId: a.id,
                              vars: { service: svc ? pick(svc.nameEn, svc.nameAr) : '', date: fmt.date(a.startAt), time: fmt.time(a.startAt), practitioner: p ? pick(p.displayName, p.displayNameAr) : '' },
                            })
                          }
                        >
                          {t('fu.prepare')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ExpiringPackages({ until, onCompose }: { until: string; onCompose: (c: Compose) => void }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const actions = useActions();
  const q = useQuery({
    queryKey: ['packages-expiring', until],
    queryFn: () => api.get<Paged<PackageSummary & { patientName: string; patientCode: string; patientPhone: string; daysToExpiry: number }>>('/packages', { state: 'expiring', until, pageSize: 100 }),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Panel flush>
      {!q.data!.items.length && <EmptyState title={t('fu.packagesEmpty')} />}
      {q.data!.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('pkg.expiry')}</th>
                <th>{t('appt.patient')}</th>
                <th>{t('pkg.template')}</th>
                <th className="num">{t('pkg.remaining')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((p) => {
                const who: Contactable = { patientId: p.patientId, patientName: p.patientName, phone: p.patientPhone, contactChannel: 'whatsapp', allowReminders: true, preferredLanguage: 'ar' };
                return (
                  <tr key={p.id}>
                    <td className="nowrap">
                      {fmt.day(p.expiryDate)}
                      <div className="xs" style={{ color: 'var(--warning)' }}>{t('pkg.daysLeft', { n: p.daysToExpiry })}</div>
                    </td>
                    <td>
                      <Link to={`/patients/${p.patientId}?tab=packages`} className="strong">
                        {p.patientName}
                      </Link>
                      <div className="xs muted ltr">{p.patientPhone}</div>
                    </td>
                    <td>{pick(p.nameEn, p.nameAr)}</td>
                    <td className="num strong">
                      {p.remainingSessions}/{p.totalSessions}
                    </td>
                    <td className="nowrap" style={{ textAlign: 'end' }}>
                      {can('followup.manage') && (
                        <Button size="xs" variant="soft" icon={<MessageSquare size={13} />} onClick={() => onCompose({ who, kind: 'package_expiry', vars: { package: pick(p.nameEn, p.nameAr), expiry_date: fmt.day(p.expiryDate), remaining: String(p.remainingSessions) } })}>
                          {t('fu.prepare')}
                        </Button>
                      )}
                      {can('appointments.manage') && (
                        <Button size="xs" variant="ghost" icon={<CalendarPlus size={13} />} onClick={() => actions.book({ patient: { id: p.patientId, fullName: p.patientName, phone: p.patientPhone }, serviceId: p.items.find((i) => i.remaining > 0)?.serviceId, purchasedPackageId: p.id })}>
                          {t('pat.book')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ComposeDialog({ c, onClose }: { c: Compose; onClose: () => void }) {
  const { t, tx } = useI18n();
  const { me } = useSession();
  const toast = useToast();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ items: Template[] }>('/followup/templates') });
  const patientDetail = useQuery({ queryKey: ['patient', c.who.patientId], queryFn: () => api.get<{ patient: { contactChannel: string; allowReminders: boolean; preferredLanguage: string } }>(`/patients/${c.who.patientId}`) });
  const pref = patientDetail.data?.patient ?? c.who;
  const list = (templates.data?.items ?? []).filter((x) => x.kind === c.kind && x.active);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [lang, setLang] = useState<'ar' | 'en' | null>(null);
  const effectiveLang = lang ?? ((pref.preferredLanguage as 'ar' | 'en') || 'ar');
  const tpl = list.find((x) => x.id === templateId) ?? list[0];
  const filled = useMemo(
    () => (tpl ? fillTemplate(effectiveLang === 'ar' ? tpl.bodyAr : tpl.bodyEn, { patient_name: c.who.patientName.split(' ')[0], clinic_name: effectiveLang === 'ar' ? me.settings.clinicNameAr : me.settings.clinicName, ...c.vars }) : ''),
    [tpl, effectiveLang, c, me.settings],
  );
  const [body, setBody] = useState<string | null>(null);
  const text = body ?? filled;
  const defaultChannel = ['whatsapp', 'sms', 'email', 'phone'].includes(pref.contactChannel) ? pref.contactChannel : 'phone';
  const [channel, setChannel] = useState<string | null>(null);
  const ch = channel ?? defaultChannel;
  const [outcome, setOutcome] = useState('contacted_manually');
  const optedOut = !pref.allowReminders || pref.contactChannel === 'none';
  const log = useAction(() => api.post('/followup/communications', { patientId: c.who.patientId, channel: ch, templateId: tpl?.id ?? null, followUpId: c.followUpId ?? null, appointmentId: c.appointmentId ?? null, body: text, outcome }), {
    success: t('fu.logged'),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      title={t('fu.composeTitle', { name: c.who.patientName })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={<Copy size={15} />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast.success(t('common.copied'));
              } catch {
                toast.error(t('common.error'));
              }
            }}
          >
            {t('fu.copyText')}
          </Button>
          <Button variant="primary" disabled={!text.trim()} loading={log.isPending} onClick={() => log.mutate(undefined)}>
            {t('fu.log')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {optedOut && <Callout tone="warning">{t('fu.preferenceWarning', { pref: pref.contactChannel === 'none' ? t('fu.noContact') : t('fu.optedOut') })}</Callout>}
        <div className="form-grid">
          <SelectField label={t('fu.template')} value={tpl?.id ?? ''} onChange={(e) => { setTemplateId(Number(e.target.value)); setBody(null); }}>
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('fu.messageLanguage')} value={effectiveLang} onChange={(e) => { setLang(e.target.value as 'ar' | 'en'); setBody(null); }}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </SelectField>
          <SelectField label={t('fu.channel')} value={ch} onChange={(e) => setChannel(e.target.value)}>
            {['whatsapp', 'sms', 'email', 'phone', 'in_person'].map((x) => (
              <option key={x} value={x}>
                {tx(`pat.channel.${x}`)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('fu.outcome')} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {['contacted_manually', 'no_answer', 'prepared_only'].map((x) => (
              <option key={x} value={x}>
                {tx(`fu.outcome.${x}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <TextArea label={t('fu.message')} rows={6} dir={effectiveLang === 'ar' ? 'rtl' : 'ltr'} value={text} onChange={(e) => setBody(e.target.value)} />
        {['whatsapp', 'sms', 'email'].includes(ch) && <Callout tone="info">{t('fu.notSentNote', { channel: tx(`pat.channel.${ch}`) })}</Callout>}
        {!list.length && <p className="small muted">{t('fu.noTemplate')}</p>}
      </div>
    </Dialog>
  );
}

function Templates() {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const [edit, setEdit] = useState<Template | 'new' | null>(null);
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ items: Template[] }>('/followup/templates') });
  const canEdit = (tpl: Template | null) => (tpl?.kind === 'aftercare' ? can('aftercare.approve') : can('templates.manage') || can('aftercare.approve'));
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Panel
      flush
      title={t('fu.templates')}
      actions={
        (can('templates.manage') || can('aftercare.approve')) && (
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>
            {t('fu.newTemplate')}
          </Button>
        )
      }
    >
      <div style={{ padding: 12 }}>
        <Callout tone="neutral">{t('fu.aftercareRule')}</Callout>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('fu.templateKind')}</th>
              <th>{t('common.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data!.items.map((x) => (
              <tr key={x.id} style={{ opacity: x.active ? 1 : 0.6 }}>
                <td>
                  <div className="strong">{x.name}</div>
                  <div className="xs muted truncate" style={{ maxWidth: 420 }}>
                    {x.bodyEn}
                  </div>
                </td>
                <td>{tx(`fu.kind.${x.kind}`)}</td>
                <td>
                  {x.kind === 'aftercare' ? (
                    x.approvedBy ? (
                      <Badge tone="success">{t('fu.approvedBy', { who: x.approvedByName ?? '' })}</Badge>
                    ) : (
                      <Badge tone="warning">{t('fu.pendingApproval')}</Badge>
                    )
                  ) : x.active ? (
                    <Badge tone="success">{t('common.active')}</Badge>
                  ) : (
                    <Badge>{t('common.inactive')}</Badge>
                  )}
                  {x.approvedAt && <div className="xs muted">{fmt.date(x.approvedAt)}</div>}
                </td>
                <td style={{ textAlign: 'end' }}>
                  {canEdit(x) && (
                    <Button size="xs" variant="ghost" onClick={() => setEdit(x)}>
                      {t('common.edit')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <TemplateDialog tpl={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function TemplateDialog({ tpl, onClose }: { tpl: Template | null; onClose: () => void }) {
  const { t, tx } = useI18n();
  const { can } = useSession();
  const kinds = TEMPLATE_KINDS.filter((k) => (k === 'aftercare' ? can('aftercare.approve') : can('templates.manage')));
  const [kind, setKind] = useState<string>(tpl?.kind ?? kinds[0]);
  const [name, setName] = useState(tpl?.name ?? '');
  const [bodyEn, setBodyEn] = useState(tpl?.bodyEn ?? '');
  const [bodyAr, setBodyAr] = useState(tpl?.bodyAr ?? '');
  const [active, setActive] = useState(tpl?.active ?? true);
  const valid = name.trim() && bodyEn.trim() && bodyAr.trim();
  const save = useAction(() => (tpl ? api.put(`/followup/templates/${tpl.id}`, { kind, name, bodyEn, bodyAr, active }) : api.post('/followup/templates', { kind, name, bodyEn, bodyAr, active })), {
    success: t('fu.templateSaved'),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      dirty={name !== (tpl?.name ?? '') || bodyEn !== (tpl?.bodyEn ?? '') || bodyAr !== (tpl?.bodyAr ?? '')}
      title={tpl ? t('fu.editTemplate') : t('fu.newTemplate')}
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
        <SelectField label={t('fu.templateKind')} value={kind} disabled={!!tpl} onChange={(e) => setKind(e.target.value)}>
          {(tpl ? [tpl.kind] : kinds).map((k) => (
            <option key={k} value={k}>
              {tx(`fu.kind.${k}`)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('common.name')} required value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea className="span-2" label={t('fu.bodyEn')} required rows={4} dir="ltr" value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />
        <TextArea className="span-2" label={t('fu.bodyAr')} required rows={4} dir="rtl" value={bodyAr} onChange={(e) => setBodyAr(e.target.value)} />
        <p className="span-2 xs muted ltr">{t('fu.variables', { vars: TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(' ') })}</p>
        {kind === 'aftercare' && (
          <div className="span-2">
            <Callout tone="info">{t('fu.aftercareRule')}</Callout>
          </div>
        )}
        <Checkbox label={t('common.active')} checked={active} onChange={setActive} />
      </div>
    </Dialog>
  );
}
