import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useForm } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, EmptyState, ErrorState, Loading, Pagination, Panel, SelectField, TextField } from '@/components/ui';
import { ConfirmDialog, Dialog } from '@/components/overlays';
import { staffSchema } from '@shared/schemas';
import { CLINICAL_PERMISSIONS, PERMISSION_GROUPS, ROLES, type Permission, type Role } from '@shared/permissions';
import type { TKey } from '@/i18n/en';

interface StaffRow {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  extraPermissions: string[];
  lastLoginAt: string | null;
  practitionerId: number | null;
}

export function StaffSettings() {
  const { t } = useI18n();
  const fmt = useFmt();
  const [edit, setEdit] = useState<StaffRow | 'new' | null>(null);
  const q = useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ items: StaffRow[] }>('/staff') });
  return (
    <Panel
      title={t('set.staff')}
      flush
      actions={
        <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>
          {t('set.newStaff')}
        </Button>
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('set.role')}</th>
                <th>{t('set.extraPerms')}</th>
                <th>{t('set.lastLogin')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((u) => (
                <tr key={u.id} className="clickable" onClick={() => setEdit(u)} style={{ opacity: u.active ? 1 : 0.6 }}>
                  <td>
                    <div className="strong">{u.name}</div>
                    <div className="xs muted ltr">{u.email}</div>
                  </td>
                  <td>{t(`role.${u.role}` as TKey)}</td>
                  <td className="small">
                    {u.extraPermissions.length
                      ? u.extraPermissions.map((p) => (
                          <Badge key={p} tone={CLINICAL_PERMISSIONS.includes(p as Permission) ? 'warning' : 'neutral'}>
                            {t(`perm.${p}` as TKey)}
                          </Badge>
                        ))
                      : '—'}
                  </td>
                  <td className="small nowrap">{u.lastLoginAt ? fmt.dateTime(u.lastLoginAt) : '—'}</td>
                  <td>{u.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <StaffDialog user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function StaffDialog({ user, onClose }: { user: StaffRow | null; onClose: () => void }) {
  const { t } = useI18n();
  const { me } = useSession();
  const form = useForm({ name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? ('receptionist' as Role), active: user?.active ?? true, extraPermissions: user?.extraPermissions ?? ([] as string[]), password: '' }, staffSchema);
  const v = form.values;
  const save = useAction((body: unknown) => (user ? api.put(`/staff/${user.id}`, body) : api.post('/staff', body)), { success: t('common.saved'), onSuccess: onClose, onError: (e) => form.applyServerError(e) });
  const submit = () => {
    if (!user && !v.password) return form.setErrors({ password: t('v.required') });
    const d = form.validate();
    if (d) save.mutate(d);
  };
  const self = user?.id === me.user.id;
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      dirty={form.dirty}
      title={user ? t('set.editStaff') : t('set.newStaff')}
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
        <TextField label={t('common.name')} required value={v.name} error={form.errors.name} onChange={(e) => form.set('name', e.target.value)} />
        <TextField label={t('login.email')} required type="email" dir="ltr" value={v.email} error={form.errors.email} onChange={(e) => form.set('email', e.target.value)} />
        <SelectField label={t('set.role')} value={v.role} disabled={self} onChange={(e) => form.set('role', e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`role.${r}` as TKey)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('set.password')} type="password" autoComplete="new-password" dir="ltr" hint={t('set.passwordHint')} value={v.password} error={form.errors.password} onChange={(e) => form.set('password', e.target.value)} />
        <Checkbox label={t('common.active')} checked={v.active} disabled={self} onChange={(x) => form.set('active', x)} />
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('set.extraPerms')}</legend>
          <span className="field-hint">{t('set.extraPermsHint')}</span>
          <div className="grid-2" style={{ gap: 6 }}>
            {PERMISSION_GROUPS.flatMap((g) => g.permissions).map((p) => (
              <Checkbox
                key={p}
                label={
                  <span>
                    {t(`perm.${p}` as TKey)} {CLINICAL_PERMISSIONS.includes(p) && <Badge tone="warning">{t('set.clinicalPerm')}</Badge>}
                  </span>
                }
                checked={v.extraPermissions.includes(p)}
                onChange={(x) => form.set('extraPermissions', x ? [...v.extraPermissions, p] : v.extraPermissions.filter((y) => y !== p))}
              />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

export function PermissionsSettings() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<{ roles: Record<Role, string[]> }>('/permissions') });
  const [draft, setDraft] = useState<Record<Role, string[]> | null>(null);
  const [confirmRole, setConfirmRole] = useState<Role | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data.roles);
  }, [q.data]);
  const save = useAction((v: { role: Role; reason: string }) => api.put('/permissions', { role: v.role, permissions: draft![v.role], reason: v.reason }), { success: t('set.permSaved'), onSuccess: () => setConfirmRole(null) });
  if (q.isLoading || !draft) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const changed = (r: Role) => JSON.stringify([...draft[r]].sort()) !== JSON.stringify([...q.data!.roles[r]].sort());
  const added = confirmRole ? draft[confirmRole].filter((p) => !q.data!.roles[confirmRole].includes(p)) : [];
  return (
    <Panel title={t('set.permissions')} flush>
      <div style={{ padding: 12 }}>
        <Callout tone="info">{t('set.permIntro')}</Callout>
      </div>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th />
              {ROLES.map((r) => (
                <th key={r} style={{ textAlign: 'center' }}>
                  {t(`role.${r}` as TKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.map((g) => (
              <Fragment key={g.key}>
                <tr>
                  <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                    <strong>{t(`permgroup.${g.key}` as TKey)}</strong>
                  </td>
                </tr>
                {g.permissions.map((p) => (
                  <tr key={p}>
                    <td className="small">
                      {t(`perm.${p}` as TKey)} {CLINICAL_PERMISSIONS.includes(p) && <ShieldAlert size={13} aria-label={t('set.clinicalPerm')} style={{ color: 'var(--warning)', verticalAlign: 'middle' }} />}
                    </td>
                    {ROLES.map((r) => (
                      <td key={r} style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          aria-label={`${t(`role.${r}` as TKey)}: ${t(`perm.${p}` as TKey)}`}
                          checked={draft[r].includes(p)}
                          style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                          onChange={(e) => setDraft({ ...draft, [r]: e.target.checked ? [...draft[r], p] : draft[r].filter((x) => x !== p) })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr>
              <td />
              {ROLES.map((r) => (
                <td key={r} style={{ textAlign: 'center' }}>
                  <Button size="xs" variant="primary" disabled={!changed(r)} onClick={() => setConfirmRole(r)}>
                    {t('common.save')}
                  </Button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={!!confirmRole}
        title={confirmRole ? `${t('set.permissions')} — ${t(`role.${confirmRole}` as TKey)}` : ''}
        reasonLabel={t('set.permReason')}
        loading={save.isPending}
        onCancel={() => setConfirmRole(null)}
        onConfirm={(reason) => confirmRole && save.mutate({ role: confirmRole, reason })}
      >
        {added.some((p) => CLINICAL_PERMISSIONS.includes(p as Permission)) && <Callout tone="warning">{t('common.restrictedClinical')}</Callout>}
      </ConfirmDialog>
    </Panel>
  );
}

interface AuditRow {
  id: number;
  at: string;
  userName: string | null;
  action: string;
  entityType: string | null;
  entityId: number | null;
  patientCode: string | null;
  patientId: number | null;
  summary: string | null;
  sensitive: boolean;
}

export function AuditLog() {
  const { t } = useI18n();
  const fmt = useFmt();
  const [sensitive, setSensitive] = useState(false);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', sensitive, action, page],
    queryFn: () => api.get<{ items: AuditRow[]; total: number; page: number; pageSize: number }>('/audit', { sensitive: sensitive ? 1 : undefined, action, page, pageSize: 30 }),
    placeholderData: (p) => p,
  });
  return (
    <Panel title={t('set.audit')} flush>
      <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 12 }}>
        <Checkbox label={t('set.auditSensitive')} checked={sensitive} onChange={(x) => { setSensitive(x); setPage(1); }} />
        <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('set.auditAction')} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
          <option value="">{t('common.all')}</option>
          {['auth', 'patient', 'medical', 'clinical_notes', 'photo', 'session', 'appointment', 'payment', 'refund', 'invoice', 'package', 'inventory', 'consent', 'permissions', 'staff', 'settings'].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      {q.isLoading && <Loading />}
      {q.data && !q.data.items.length && <EmptyState title={t('rep.noData')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>{t('set.auditWhen')}</th>
                <th>{t('set.auditWho')}</th>
                <th>{t('set.auditAction')}</th>
                <th>{t('set.auditPatient')}</th>
                <th>{t('set.auditSummary')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap small">{fmt.dateTime(e.at)}</td>
                  <td className="small">{e.userName ?? '—'}</td>
                  <td className="small ltr">
                    {e.action} {e.sensitive && <Badge tone="warning">{t('set.clinicalPerm')}</Badge>}
                  </td>
                  <td className="small">{e.patientCode ?? '—'}</td>
                  <td className="small">{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
    </Panel>
  );
}
