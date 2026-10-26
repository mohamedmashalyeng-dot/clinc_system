import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileSignature } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, Callout, EmptyState, ErrorState, Loading, Panel, SelectField, TextArea } from '@/components/ui';
import { ConfirmDialog, Dialog } from '@/components/overlays';
import { CONSENT_TYPES } from '@shared/domain';
import type { TKey } from '@/i18n/en';

interface ConsentRow {
  id: number;
  type: string;
  templateVersion: number;
  titleEn: string;
  titleAr: string;
  status: 'granted' | 'withdrawn';
  method: string;
  notes: string | null;
  recordedAt: string;
  recordedByName: string | null;
  withdrawnAt: string | null;
  withdrawnByName: string | null;
  withdrawReason: string | null;
}

export function ConsentsTab({ patientId }: { patientId: number }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const [record, setRecord] = useState<string | null>(null);
  const [withdraw, setWithdraw] = useState<ConsentRow | null>(null);
  const q = useQuery({ queryKey: ['consents', patientId], queryFn: () => api.get<{ items: ConsentRow[] }>(`/patients/${patientId}/consents`) });
  const wd = useAction((v: { id: number; reason: string }) => api.post(`/consents/${v.id}/withdraw`, { reason: v.reason }), { success: t('con.withdrawn_ok'), onSuccess: () => setWithdraw(null) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data!.items;
  const latest = (type: string) => items.find((c) => c.type === type);
  return (
    <div className="stack loose">
      <Callout tone="info">{t('con.separateNote')}</Callout>
      <div className="summary-cards">
        {CONSENT_TYPES.map((type) => {
          const c = latest(type);
          return (
            <div key={type} className="summary-card">
              <span className="label">{t(`con.type.${type}` as TKey)}</span>
              {c ? (
                <>
                  <Badge tone={c.status === 'granted' ? 'success' : 'danger'}>{c.status === 'granted' ? t('con.granted') : t('con.withdrawn')}</Badge>
                  <span className="xs muted">
                    {fmt.date(c.status === 'granted' ? c.recordedAt : c.withdrawnAt!)} · {t('con.version', { n: c.templateVersion })}
                  </span>
                </>
              ) : (
                <Badge tone="outline">{t('con.notRecorded')}</Badge>
              )}
              {can('consents.manage') && (
                <div className="toolbar" style={{ marginTop: 4 }}>
                  {c?.status !== 'granted' && (
                    <Button size="xs" variant="soft" icon={<FileSignature size={13} />} onClick={() => setRecord(type)}>
                      {t('con.record')}
                    </Button>
                  )}
                  {c?.status === 'granted' && (
                    <Button size="xs" variant="ghost" onClick={() => setWithdraw(c)}>
                      {t('con.withdraw')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Panel title={t('con.history')} flush>
        {!items.length ? (
          <EmptyState title={t('con.notRecorded')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.type')}</th>
                  <th>{t('con.template')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('con.method')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.by')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>{t(`con.type.${c.type}` as TKey)}</td>
                    <td className="small">
                      {pick(c.titleEn, c.titleAr)} <span className="muted">· {t('con.version', { n: c.templateVersion })}</span>
                    </td>
                    <td>
                      <Badge tone={c.status === 'granted' ? 'success' : 'danger'}>{c.status === 'granted' ? t('con.granted') : t('con.withdrawn')}</Badge>
                      {c.withdrawReason && <div className="xs muted">{c.withdrawReason}</div>}
                    </td>
                    <td className="small">{t(`con.method.${c.method}` as TKey)}</td>
                    <td className="nowrap small">
                      {fmt.dateTime(c.recordedAt)}
                      {c.withdrawnAt && <div className="xs muted">→ {fmt.dateTime(c.withdrawnAt)}</div>}
                    </td>
                    <td className="small">
                      {c.recordedByName}
                      {c.withdrawnByName && <div className="xs muted">{c.withdrawnByName}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {record && <RecordConsentDialog patientId={patientId} type={record} onClose={() => setRecord(null)} />}
      <ConfirmDialog
        open={!!withdraw}
        title={t('con.withdrawTitle')}
        body={withdraw ? t(`con.type.${withdraw.type}` as TKey) : ''}
        reasonLabel={t('common.reason')}
        confirmLabel={t('con.withdraw')}
        danger
        loading={wd.isPending}
        onCancel={() => setWithdraw(null)}
        onConfirm={(reason) => withdraw && wd.mutate({ id: withdraw.id, reason })}
      />
    </div>
  );
}

function RecordConsentDialog({ patientId, type, onClose }: { patientId: number; type: string; onClose: () => void }) {
  const { t, pick } = useI18n();
  const ref = useRef_();
  const templates = (ref.data?.consentTemplates ?? []).filter((c) => c.type === type && c.active);
  const [templateId, setTemplateId] = useState<number>(templates[0]?.id ?? 0);
  const [method, setMethod] = useState('paper_signed');
  const [notes, setNotes] = useState('');
  const tpl = templates.find((x) => x.id === templateId);
  const save = useAction(() => api.post(`/patients/${patientId}/consents`, { templateId, method, notes: notes || null }), { success: t('con.recorded'), onSuccess: onClose });
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      title={t('con.recordTitle')}
      subtitle={t(`con.type.${type}` as TKey)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!tpl} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {t('con.record')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <SelectField label={t('con.template')} value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))}>
          {templates.map((c) => (
            <option key={c.id} value={c.id}>
              {pick(c.titleEn, c.titleAr)} · {t('con.version', { n: c.version })}
            </option>
          ))}
        </SelectField>
        {tpl && (
          <div className="subtle-box small pre-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {pick(tpl.bodyEn, tpl.bodyAr)}
          </div>
        )}
        <SelectField label={t('con.method')} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="paper_signed">{t('con.method.paper_signed')}</option>
          <option value="in_clinic_acknowledgement">{t('con.method.in_clinic_acknowledgement')}</option>
        </SelectField>
        <TextArea label={t('common.notes')} hint={t('common.optional')} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="xs muted">{t('con.notLegalSignature')}</p>
      </div>
    </Dialog>
  );
}
