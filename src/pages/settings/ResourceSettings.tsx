import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useForm } from '@/lib/hooks';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, Checkbox, Loading, Panel, SelectField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { consentTemplateSchema, deviceSchema, practitionerSchema, qualificationSchema, roomSchema } from '@shared/schemas';
import { CONSENT_TYPES } from '@shared/domain';
import type { ConsentTemplate, Device, Practitioner, Room } from '@/lib/types';
import type { TKey } from '@/i18n/en';

function DialogFooter({ onClose, onSave, loading }: { onClose: () => void; onSave: () => void; loading: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" loading={loading} onClick={onSave}>
        {t('common.save')}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------- practitioners
export function PractitionersSettings() {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const [edit, setEdit] = useState<Practitioner | 'new' | null>(null);
  const [qual, setQual] = useState(false);
  if (!ref.ready) return <Loading />;
  return (
    <>
      <Panel
        title={t('set.practitioners')}
        flush
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>
            {t('set.newPractitioner')}
          </Button>
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.name')}</th>
                <th>{t('set.qualifications')}</th>
                <th>{t('set.workingHours')}</th>
                <th>{t('set.linkedUser')}</th>
                <th>{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {ref.data!.practitioners.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setEdit(p)} style={{ opacity: p.active ? 1 : 0.6 }}>
                  <td>
                    <span className="row">
                      <span className="color-dot" style={{ background: p.color }} />
                      <strong>{pick(p.displayName, p.displayNameAr)}</strong>
                    </span>
                  </td>
                  <td className="small">{p.qualifications.map((q) => ref.qualificationName(q)).join(', ') || '—'}</td>
                  <td className="small">
                    {p.hours
                      .map((h, i) => (h.open ? `${t(`weekday.${i}` as TKey).slice(0, 3)} ${h.start}–${h.end}` : null))
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td className="small">{p.userId ? ref.userName(p.userId) : '—'}</td>
                  <td>{p.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel
        title={t('set.qualificationsList')}
        actions={
          <Button size="sm" icon={<Plus size={15} />} onClick={() => setQual(true)}>
            {t('set.newQualification')}
          </Button>
        }
      >
        <div className="row wrap">
          {ref.data!.qualifications.map((q) => (
            <Badge key={q.code} tone="accent">
              {pick(q.nameEn, q.nameAr)} <span className="ltr xs">({q.code})</span>
            </Badge>
          ))}
        </div>
      </Panel>
      {edit && <PractitionerDialog p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {qual && <QualificationDialog onClose={() => setQual(false)} />}
    </>
  );
}

function PractitionerDialog({ p, onClose }: { p: Practitioner | null; onClose: () => void }) {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const { me } = useSession();
  const form = useForm(
    {
      displayName: p?.displayName ?? '',
      displayNameAr: p?.displayNameAr ?? '',
      userId: p?.userId ?? (null as number | null),
      qualifications: p?.qualifications ?? ([] as string[]),
      color: p?.color ?? '#6B5B95',
      hours: p?.hours ?? me.settings.openingHours,
      active: p?.active ?? true,
    },
    practitionerSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => (p ? api.put(`/practitioners/${p.id}`, body) : api.post('/practitioners', body)), { success: t('common.saved'), onSuccess: onClose, onError: (e) => form.applyServerError(e) });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog open size="wide" onClose={onClose} dirty={form.dirty} title={p ? t('set.editPractitioner') : t('set.newPractitioner')} onSubmit={submit} footer={<DialogFooter onClose={onClose} onSave={submit} loading={save.isPending} />}>
      <div className="form-grid">
        <TextField label={t('set.displayName')} required value={v.displayName} error={form.errors.displayName} onChange={(e) => form.set('displayName', e.target.value)} />
        <TextField label={t('set.displayNameAr')} required dir="rtl" value={v.displayNameAr} error={form.errors.displayNameAr} onChange={(e) => form.set('displayNameAr', e.target.value)} />
        <SelectField label={t('set.linkedUser')} value={v.userId ?? ''} onChange={(e) => form.set('userId', e.target.value ? Number(e.target.value) : null)}>
          <option value="">{t('common.none')}</option>
          {ref.data!.users
            .filter((u) => u.role === 'practitioner' || u.id === v.userId)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </SelectField>
        <TextField label={t('set.color')} type="color" value={v.color} onChange={(e) => form.set('color', e.target.value)} style={{ height: 36, padding: 2 }} />
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('set.qualifications')}</legend>
          <div className="slot-chips">
            {ref.data!.qualifications.map((q) => (
              <button type="button" key={q.code} className="chip" aria-pressed={v.qualifications.includes(q.code)} onClick={() => form.set('qualifications', v.qualifications.includes(q.code) ? v.qualifications.filter((x) => x !== q.code) : [...v.qualifications, q.code])}>
                {pick(q.nameEn, q.nameAr)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="span-2 stack tight">
          <legend className="field-label">{t('set.workingHours')}</legend>
          {form.errors.hours && <span className="field-error">{form.errors.hours}</span>}
          {[6, 0, 1, 2, 3, 4, 5].map((d) => {
            const h = v.hours[d];
            const setH = (patch: Partial<typeof h>) => form.set('hours', v.hours.map((x, i) => (i === d ? { ...x, ...patch } : x)));
            return (
              <div key={d} className="row wrap">
                <span style={{ width: 110 }}>{t(`weekday.${d}` as TKey)}</span>
                <Checkbox label={h.open ? t('set.open') : t('set.closed')} checked={h.open} onChange={(x) => setH({ open: x })} />
                <input className="input input-sm" type="time" disabled={!h.open} aria-label={t('set.opens')} value={h.start} onChange={(e) => setH({ start: e.target.value })} style={{ width: 110 }} />
                <span className="muted">–</span>
                <input className="input input-sm" type="time" disabled={!h.open} aria-label={t('set.closes')} value={h.end} onChange={(e) => setH({ end: e.target.value })} style={{ width: 110 }} />
              </div>
            );
          })}
        </fieldset>
        <Checkbox label={t('common.active')} checked={v.active} onChange={(x) => form.set('active', x)} />
      </div>
    </Dialog>
  );
}

function QualificationDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const form = useForm({ code: '', nameEn: '', nameAr: '' }, qualificationSchema);
  const save = useAction((body: unknown) => api.post('/qualifications', body), { success: t('common.saved'), onSuccess: onClose, onError: (e) => form.applyServerError(e) });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog open size="narrow" onClose={onClose} dirty={form.dirty} title={t('set.newQualification')} onSubmit={submit} footer={<DialogFooter onClose={onClose} onSave={submit} loading={save.isPending} />}>
      <div className="stack">
        <TextField label={t('set.code')} required dir="ltr" hint="a-z, _" value={form.values.code} error={form.errors.code} onChange={(e) => form.set('code', e.target.value.toLowerCase())} />
        <TextField label={`${t('common.name')} (EN)`} required value={form.values.nameEn} error={form.errors.nameEn} onChange={(e) => form.set('nameEn', e.target.value)} />
        <TextField label={`${t('common.name')} (AR)`} required dir="rtl" value={form.values.nameAr} error={form.errors.nameAr} onChange={(e) => form.set('nameAr', e.target.value)} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- rooms & devices
/** Localized name first, the other language underneath, so both can be checked at a glance. */
function BilingualName({ name, nameAr }: { name: string; nameAr: string | null }) {
  const { lang, pick } = useI18n();
  return (
    <td>
      <strong>{pick(name, nameAr)}</strong>
      {nameAr && <div className="xs muted">{lang === 'ar' ? name : nameAr}</div>}
    </td>
  );
}

export function RoomsDevicesSettings() {
  const { t } = useI18n();
  const ref = useRef_();
  const [room, setRoom] = useState<Room | 'new' | null>(null);
  const [device, setDevice] = useState<Device | 'new' | null>(null);
  if (!ref.ready) return <Loading />;
  return (
    <>
      <Panel
        title={t('appt.room')}
        flush
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setRoom('new')}>
            {t('set.newRoom')}
          </Button>
        }
      >
        <table className="table">
          <tbody>
            {ref.data!.rooms.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setRoom(r)}>
                <BilingualName name={r.name} nameAr={r.nameAr} />
                <td>{r.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel
        title={t('appt.device')}
        flush
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setDevice('new')}>
            {t('set.newDevice')}
          </Button>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>{t('common.name')}</th>
              <th>{t('set.model')}</th>
              <th>{t('set.homeRoom')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {ref.data!.devices.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setDevice(d)}>
                <BilingualName name={d.name} nameAr={d.nameAr} />
                <td className="small">{d.model ?? '—'}</td>
                <td className="small">{d.roomId ? ref.roomName(d.roomId) : '—'}</td>
                <td>
                  {d.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}
                  {d.maintenanceNote && <div className="xs muted">{d.maintenanceNote}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {room && <RoomDialog room={room === 'new' ? null : room} onClose={() => setRoom(null)} />}
      {device && <DeviceDialog device={device === 'new' ? null : device} onClose={() => setDevice(null)} />}
    </>
  );
}

function RoomDialog({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const { t } = useI18n();
  const form = useForm({ name: room?.name ?? '', nameAr: room?.nameAr ?? '', active: room?.active ?? true }, roomSchema);
  const save = useAction((body: unknown) => (room ? api.put(`/rooms/${room.id}`, body) : api.post('/rooms', body)), { success: t('common.saved'), onSuccess: onClose });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog open size="narrow" onClose={onClose} dirty={form.dirty} title={room ? t('set.editRoom') : t('set.newRoom')} onSubmit={submit} footer={<DialogFooter onClose={onClose} onSave={submit} loading={save.isPending} />}>
      <div className="stack">
        <TextField label={t('set.nameEn')} required value={form.values.name} error={form.errors.name} onChange={(e) => form.set('name', e.target.value)} />
        <TextField label={t('set.nameAr')} dir="rtl" hint={t('set.nameArHint')} value={form.values.nameAr ?? ''} error={form.errors.nameAr} onChange={(e) => form.set('nameAr', e.target.value)} />
        <Checkbox label={t('common.active')} checked={form.values.active} onChange={(x) => form.set('active', x)} />
      </div>
    </Dialog>
  );
}

function DeviceDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef_();
  const form = useForm({ name: device?.name ?? '', nameAr: device?.nameAr ?? '', model: device?.model ?? '', roomId: device?.roomId ?? (null as number | null), active: device?.active ?? true, maintenanceNote: device?.maintenanceNote ?? '' }, deviceSchema);
  const v = form.values;
  const save = useAction((body: unknown) => (device ? api.put(`/devices/${device.id}`, body) : api.post('/devices', body)), { success: t('common.saved'), onSuccess: onClose });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} title={device ? t('set.editDevice') : t('set.newDevice')} onSubmit={submit} footer={<DialogFooter onClose={onClose} onSave={submit} loading={save.isPending} />}>
      <div className="form-grid">
        <TextField label={t('set.nameEn')} required value={v.name} error={form.errors.name} onChange={(e) => form.set('name', e.target.value)} />
        <TextField label={t('set.nameAr')} dir="rtl" hint={t('set.nameArHint')} value={v.nameAr ?? ''} error={form.errors.nameAr} onChange={(e) => form.set('nameAr', e.target.value)} />
        <TextField label={t('set.model')} value={v.model ?? ''} onChange={(e) => form.set('model', e.target.value)} />
        <SelectField label={t('set.homeRoom')} value={v.roomId ?? ''} onChange={(e) => form.set('roomId', e.target.value ? Number(e.target.value) : null)}>
          <option value="">—</option>
          {ref.data!.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {ref.roomName(r.id)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('set.maintenance')} value={v.maintenanceNote ?? ''} onChange={(e) => form.set('maintenanceNote', e.target.value)} />
        <Checkbox label={t('common.active')} checked={v.active} onChange={(x) => form.set('active', x)} hint={!v.active ? t('issue.DEVICE_INACTIVE', { device: v.name }) : undefined} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- consent templates
export function ConsentTemplatesSettings() {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const [edit, setEdit] = useState<ConsentTemplate | 'new' | null>(null);
  if (!ref.ready) return <Loading />;
  return (
    <Panel
      title={t('set.consents')}
      flush
      actions={
        <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>
          {t('set.newConsent')}
        </Button>
      }
    >
      <div style={{ padding: 12 }}>
        <Callout tone="info">{t('con.separateNote')}</Callout>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('set.consentType')}</th>
            <th>{t('common.status')}</th>
          </tr>
        </thead>
        <tbody>
          {ref.data!.consentTemplates.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => setEdit(c)}>
              <td>
                <strong>{pick(c.titleEn, c.titleAr)}</strong> <span className="xs muted">{t('set.version', { n: c.version })}</span>
              </td>
              <td>{t(`con.type.${c.type}` as TKey)}</td>
              <td>{c.active ? <Badge tone="success">{t('common.active')}</Badge> : <Badge>{t('common.inactive')}</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <ConsentTemplateDialog tpl={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function ConsentTemplateDialog({ tpl, onClose }: { tpl: ConsentTemplate | null; onClose: () => void }) {
  const { t } = useI18n();
  const form = useForm(
    { type: tpl?.type ?? 'treatment', titleEn: tpl?.titleEn ?? '', titleAr: tpl?.titleAr ?? '', bodyEn: tpl?.bodyEn ?? '', bodyAr: tpl?.bodyAr ?? '', active: tpl?.active ?? true },
    consentTemplateSchema,
  );
  const v = form.values;
  const save = useAction((body: unknown) => (tpl ? api.put(`/consent-templates/${tpl.id}`, body) : api.post('/consent-templates', body)), { success: t('common.saved'), onSuccess: onClose, onError: (e) => form.applyServerError(e) });
  const submit = () => {
    const d = form.validate();
    if (d) save.mutate(d);
  };
  return (
    <Dialog open size="wide" onClose={onClose} dirty={form.dirty} title={tpl ? t('set.editConsent') : t('set.newConsent')} onSubmit={submit} footer={<DialogFooter onClose={onClose} onSave={submit} loading={save.isPending} />}>
      <div className="form-grid">
        <SelectField label={t('set.consentType')} value={v.type} disabled={!!tpl} onChange={(e) => form.set('type', e.target.value)}>
          {CONSENT_TYPES.map((c) => (
            <option key={c} value={c}>
              {t(`con.type.${c}` as TKey)}
            </option>
          ))}
        </SelectField>
        <Checkbox label={t('common.active')} checked={v.active} onChange={(x) => form.set('active', x)} />
        <TextField label={t('set.titleEn')} required value={v.titleEn} error={form.errors.titleEn} onChange={(e) => form.set('titleEn', e.target.value)} />
        <TextField label={t('set.titleAr')} required dir="rtl" value={v.titleAr} error={form.errors.titleAr} onChange={(e) => form.set('titleAr', e.target.value)} />
        <TextArea className="span-2" label={t('set.bodyEn')} required rows={6} value={v.bodyEn} error={form.errors.bodyEn} onChange={(e) => form.set('bodyEn', e.target.value)} />
        <TextArea className="span-2" label={t('set.bodyAr')} required dir="rtl" rows={6} value={v.bodyAr} error={form.errors.bodyAr} onChange={(e) => form.set('bodyAr', e.target.value)} />
        {tpl && (
          <div className="span-2">
            <Callout tone="info">{t('set.versionNote')}</Callout>
          </div>
        )}
      </div>
    </Dialog>
  );
}
