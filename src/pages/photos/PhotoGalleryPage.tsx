import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Camera, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useUrlState, initials } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useI18n } from '@/i18n';
import { EmptyState, ErrorState, Loading, Panel } from '@/components/ui';
import { PhotoGallery } from './PhotoGallery';

interface Row {
  id: number;
  code: string;
  fullName: string;
  photos: number;
  lastTaken: string;
  areas: string[];
}

export function PhotoGalleryPage() {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const [s, set] = useUrlState({ patient: '', q: '' });
  const q = useQuery({ queryKey: ['photo-patients', s.q], queryFn: () => api.get<{ items: Row[] }>('/photos/patients', { q: s.q }), placeholderData: (p) => p });
  const selected = q.data?.items.find((r) => String(r.id) === s.patient);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('ph.gallery')}</h1>
          <p className="sub">{t('ph.gallerySub')}</p>
        </div>
      </div>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(240px, 320px) minmax(0, 1fr)' }}>
        <Panel title={t('ph.patients')} flush>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
            <div className="input-group">
              <Search size={15} aria-hidden />
              <input className="input input-sm" type="search" placeholder={t('common.search')} aria-label={t('common.search')} value={s.q} onChange={(e) => set({ q: e.target.value })} />
            </div>
          </div>
          {q.isLoading && <Loading />}
          {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
          {q.data && !q.data.items.length && <EmptyState title={t('ph.empty')} />}
          <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
            {q.data?.items.map((r) => (
              <button key={r.id} className="menu-item" data-active={String(r.id) === s.patient} aria-pressed={String(r.id) === s.patient} onClick={() => set({ patient: String(r.id) })}>
                <span className="avatar" aria-hidden>
                  {initials(r.fullName)}
                </span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="strong truncate" style={{ display: 'block' }}>
                    {r.fullName}
                  </span>
                  <span className="xs muted truncate" style={{ display: 'block' }}>
                    {t('ph.count', { n: r.photos })} · {r.areas.map((a) => tx(`area.${a}`)).join(', ')} · {fmt.day(r.lastTaken)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Panel>
        <Panel
          title={selected ? selected.fullName : t('ph.title')}
          actions={
            selected && (
              <Link className="btn btn-sm" to={`/patients/${selected.id}?tab=photos`}>
                {t('ws.patientFile')}
              </Link>
            )
          }
        >
          {selected ? <PhotoGallery key={selected.id} patientId={selected.id} /> : <EmptyState icon={<Camera size={30} />} title={t('ph.patients')} hint={t('ph.gallerySub')} />}
        </Panel>
      </div>
    </div>
  );
}
