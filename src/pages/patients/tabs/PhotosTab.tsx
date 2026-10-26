import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, EmptyState, ErrorState, Loading, Panel, Restricted, SelectField, TextField } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { PhotosPanel } from '@/pages/photos/PhotoGallery';
import { CLINICAL_DOCUMENT_CATEGORIES, DOCUMENT_CATEGORIES } from '@shared/domain';
import type { TKey } from '@/i18n/en';

interface Doc {
  id: number;
  title: string;
  category: string;
  clinical: boolean;
  mime: string;
  size: number;
  uploadedAt: string;
  uploadedByName: string | null;
}

export function PhotosTab({ patientId }: { patientId: number }) {
  const { can } = useSession();
  return (
    <div className="stack loose">
      {can('photos.view') ? <PhotosPanel patientId={patientId} /> : <Restricted perm="photos.view" clinical />}
      <DocumentsPanel patientId={patientId} />
    </div>
  );
}

function DocumentsPanel({ patientId }: { patientId: number }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const [upload, setUpload] = useState(false);
  const q = useQuery({ queryKey: ['documents', patientId], queryFn: () => api.get<{ items: Doc[]; restrictedCount: number }>(`/patients/${patientId}/documents`) });
  return (
    <Panel
      title={t('doc.title')}
      flush
      actions={
        (can('patients.edit') || can('medical.edit')) && (
          <Button size="sm" icon={<Upload size={15} />} onClick={() => setUpload(true)}>
            {t('doc.upload')}
          </Button>
        )
      }
    >
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.restrictedCount > 0 && (
        <div style={{ padding: 12 }}>
          <Callout tone="neutral">{t('doc.restricted', { n: q.data.restrictedCount })}</Callout>
        </div>
      )}
      {q.data && !q.data.items.length && <EmptyState title={t('doc.empty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('doc.docTitle')}</th>
                <th>{t('doc.category')}</th>
                <th>{t('common.date')}</th>
                <th>{t('common.by')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className="row">
                      <FileText size={15} aria-hidden /> {d.title}
                    </span>
                  </td>
                  <td>
                    {t(`doc.cat.${d.category}` as TKey)} {d.clinical && <Badge tone="accent">{t('doc.clinical')}</Badge>}
                  </td>
                  <td className="nowrap">{fmt.date(d.uploadedAt)}</td>
                  <td className="small">{d.uploadedByName}</td>
                  <td>
                    <a className="btn btn-sm btn-ghost" href={`/api/documents/${d.id}/file`} target="_blank" rel="noopener">
                      {t('common.open')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {upload && <DocumentUploadDialog patientId={patientId} onClose={() => setUpload(false)} />}
    </Panel>
  );
}

function DocumentUploadDialog({ patientId, onClose }: { patientId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const allowed = DOCUMENT_CATEGORIES.filter((c) => (CLINICAL_DOCUMENT_CATEGORIES.includes(c) ? can('medical.edit') && can('clinical_documents.view') : can('patients.edit')));
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(allowed[0] ?? 'other_admin');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const up = useAction(() => api.upload(`/patients/${patientId}/documents`, file!, { title, category, fileName: file!.name }), { success: t('doc.uploaded'), onSuccess: onClose });
  const submit = () => {
    if (!title.trim() || !file) return setError(t('v.required'));
    if (file.size > 12 * 1024 * 1024) return setError(t('err.FILE_TOO_LARGE'));
    up.mutate(undefined);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dirty={!!file || !!title}
      title={t('doc.upload')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={up.isPending} onClick={submit}>
            {t('doc.upload')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Callout tone="danger">{error}</Callout>}
        <TextField label={t('doc.docTitle')} required value={title} onChange={(e) => setTitle(e.target.value)} />
        <SelectField label={t('doc.category')} value={category} onChange={(e) => setCategory(e.target.value)}>
          {allowed.map((c) => (
            <option key={c} value={c}>
              {t(`doc.cat.${c}` as TKey)}
            </option>
          ))}
        </SelectField>
        <TextField label={t('doc.file')} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
    </Dialog>
  );
}
