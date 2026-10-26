import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, Columns2, ImagePlus, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, EmptyState, ErrorState, Loading, Panel, SelectField, TextArea, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { BODY_AREAS, PHOTO_KINDS } from '@shared/domain';
import type { TKey } from '@/i18n/en';

export interface Photo {
  id: number;
  sessionId: number | null;
  bodyArea: string;
  kind: 'before' | 'after' | 'progress';
  takenOn: string;
  notes: string | null;
  mime: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  uploadedByName: string | null;
  serviceId: number | null;
}

interface PhotoResponse {
  items: Photo[];
  consents: { treatment: boolean; clinicalPhotography: boolean; marketingPhotography: boolean };
}

export function PhotoGallery({ patientId, sessionId, defaultArea, compact }: { patientId: number; sessionId?: number | null; defaultArea?: string; compact?: boolean }) {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const [selected, setSelected] = useState<number[]>([]);
  const [compare, setCompare] = useState(false);
  const [upload, setUpload] = useState(false);
  const q = useQuery({ queryKey: ['photos', patientId], queryFn: () => api.get<PhotoResponse>(`/patients/${patientId}/photos`) });
  const items = useMemo(() => (q.data?.items ?? []).filter((p) => !sessionId || p.sessionId === sessionId), [q.data, sessionId]);
  const groups = useMemo(() => {
    const byArea = new Map<string, Map<string, Photo[]>>();
    for (const p of items) {
      const area = byArea.get(p.bodyArea) ?? new Map<string, Photo[]>();
      area.set(p.takenOn, [...(area.get(p.takenOn) ?? []), p]);
      byArea.set(p.bodyArea, area);
    }
    return [...byArea.entries()].map(([area, dates]) => ({ area, dates: [...dates.entries()].sort((a, b) => a[0].localeCompare(b[0])) }));
  }, [items]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const consents = q.data!.consents;
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s.slice(-1), id]));
  const pair = selected.map((id) => items.find((p) => p.id === id)!).filter(Boolean).sort((a, b) => a.takenOn.localeCompare(b.takenOn));

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 8 }}>
        <Badge tone={consents.clinicalPhotography ? 'success' : 'danger'}>
          {consents.clinicalPhotography ? <ShieldCheck size={12} /> : <ShieldOff size={12} />} {t('con.type.clinical_photography')}: {consents.clinicalPhotography ? t('ws.consentOk') : t('ws.consentMissing')}
        </Badge>
        <Badge tone={consents.marketingPhotography ? 'success' : 'outline'}>
          {t('con.type.marketing_photography')}: {consents.marketingPhotography ? t('ws.consentOk') : t('ws.consentMissing')}
        </Badge>
        <span className="grow" />
        <Button size="sm" icon={<Columns2 size={15} />} disabled={pair.length !== 2} onClick={() => setCompare(true)} title={pair.length !== 2 ? t('ph.compareSelect') : undefined}>
          {t('ph.compare')} {selected.length ? `(${selected.length}/2)` : ''}
        </Button>
        {can('photos.upload') && (
          <Button size="sm" variant="primary" icon={<ImagePlus size={15} />} disabled={!consents.clinicalPhotography} onClick={() => setUpload(true)}>
            {t('ph.upload')}
          </Button>
        )}
      </div>
      {!consents.clinicalPhotography && can('photos.upload') && <Callout tone="warning">{t('ws.photoNeedsConsent')}</Callout>}
      {!compact && <p className="xs muted">{t('ph.consentNote')}</p>}
      {!items.length && <EmptyState icon={<Camera size={30} />} title={t('ph.empty')} />}
      {groups.map((g) => (
        <div key={g.area} className="stack tight">
          <h3 className="section-title">{tx(`area.${g.area}`)}</h3>
          {g.dates.map(([date, photos]) => (
            <div key={date} className="stack tight" style={{ gap: 6 }}>
              <div className="small muted">
                {fmt.day(date)}
                {photos[0].serviceId ? ` · ${ref.serviceName(photos[0].serviceId)}` : ''}
              </div>
              <div className="photo-grid">
                {photos.map((p) => (
                  <PhotoTile key={p.id} p={p} selected={selected.includes(p.id)} onToggle={() => toggle(p.id)} marketing={consents.marketingPhotography} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      {compare && pair.length === 2 && <CompareDialog pair={pair as [Photo, Photo]} onClose={() => setCompare(false)} />}
      {upload && <PhotoUploadDialog patientId={patientId} sessionId={sessionId ?? null} defaultArea={defaultArea} onClose={() => setUpload(false)} />}
    </div>
  );
}

function PhotoTile({ p, selected, onToggle, marketing }: { p: Photo; selected: boolean; onToggle: () => void; marketing: boolean }) {
  const { t } = useI18n();
  return (
    <button className="photo-tile" aria-pressed={selected} onClick={onToggle} title={p.notes ?? undefined}>
      <div className="photo-frame">
        <img src={`/api/photos/${p.id}/file`} alt={`${t(`ph.kind.${p.kind}` as TKey)} ${p.takenOn}`} loading="lazy" />
      </div>
      <div className="photo-caption">
        <span className="strong">{t(`ph.kind.${p.kind}` as TKey)}</span>
        {marketing && <span className="muted">{t('ph.marketingOk')}</span>}
      </div>
    </button>
  );
}

function CompareDialog({ pair, onClose }: { pair: [Photo, Photo]; onClose: () => void }) {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  return (
    <Dialog open size="xwide" onClose={onClose} title={t('ph.compareTitle')} subtitle={t('ph.compareNote')} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="compare">
        {pair.map((p) => (
          <figure key={p.id}>
            <div className="photo-frame">
              <img src={`/api/photos/${p.id}/file`} alt={`${tx(`area.${p.bodyArea}`)} ${p.takenOn}`} />
            </div>
            <figcaption>
              <strong>
                {t(`ph.kind.${p.kind}` as TKey)} · {fmt.day(p.takenOn)}
              </strong>
              <span className="muted">{tx(`area.${p.bodyArea}`)}</span>
            </figcaption>
            <div className="xs muted ltr" style={{ overflowWrap: 'anywhere' }}>
              {t('ph.integrity', { hash: p.sha256.slice(0, 16) + '…' })}
            </div>
          </figure>
        ))}
      </div>
    </Dialog>
  );
}

export function PhotoUploadDialog({ patientId, sessionId, defaultArea, onClose }: { patientId: number; sessionId: number | null; defaultArea?: string; onClose: () => void }) {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<(typeof PHOTO_KINDS)[number]>('before');
  const [area, setArea] = useState(defaultArea ?? 'face');
  const [takenOn, setTakenOn] = useState(fmt.today());
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const up = useAction(() => api.upload(`/patients/${patientId}/photos`, file!, { bodyArea: area, kind, takenOn, sessionId, notes: notes || undefined }), {
    success: t('ph.uploaded'),
    onSuccess: onClose,
  });
  const submit = () => {
    if (!file) return setError(t('v.required'));
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setError(t('err.UNSUPPORTED_FILE'));
    if (file.size > 12 * 1024 * 1024) return setError(t('err.FILE_TOO_LARGE'));
    up.mutate(undefined);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={!!file}
      title={t('ph.uploadTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={up.isPending} onClick={submit}>
            {t('ph.upload')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Callout tone="danger">{error}</Callout>}
        <TextField label={t('ph.file')} type="file" accept="image/jpeg,image/png,image/webp" required onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
        <div className="form-grid">
          <SelectField label={t('ph.kind')} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {PHOTO_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`ph.kind.${k}` as TKey)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('ph.area')} value={area} onChange={(e) => setArea(e.target.value)}>
            {BODY_AREAS.map((a) => (
              <option key={a} value={a}>
                {tx(`area.${a}`)}
              </option>
            ))}
          </SelectField>
          <TextField label={t('ph.takenOn')} type="date" value={takenOn} max={fmt.today()} onChange={(e) => setTakenOn(e.target.value)} />
        </div>
        <TextArea label={t('common.notes')} hint={t('common.optional')} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="xs muted">{t('ph.compareNote')}</p>
      </div>
    </Dialog>
  );
}

export function PhotosPanel({ patientId }: { patientId: number }) {
  const { t } = useI18n();
  return (
    <Panel title={t('ph.title')}>
      <PhotoGallery patientId={patientId} />
    </Panel>
  );
}
