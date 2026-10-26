import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useFmt } from '@/lib/format';
import { useI18n } from '@/i18n';
import { Button, EmptyState, Loading } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { PatientPicker, type PatientRef } from '@/components/pickers';
import { useActions } from '@/layout/actions';
import type { Paged } from '@/lib/types';
import type { TKey } from '@/i18n/en';

interface InvoiceRow {
  id: number;
  number: string;
  issueDate: string;
  kind: string;
  total: number;
  balance: number;
}

/** Pick a patient, then one of their open invoices, then record the payment against it. */
export function CollectPaymentDialog({ patient: initial, onClose }: { patient?: PatientRef; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const actions = useActions();
  const [patient, setPatient] = useState<PatientRef | null>(initial ?? null);
  const q = useQuery({
    queryKey: ['open-invoices', patient?.id],
    queryFn: () => api.get<Paged<InvoiceRow>>('/invoices', { patientId: patient!.id, status: 'outstanding', pageSize: 50 }),
    enabled: !!patient,
  });
  return (
    <Dialog open onClose={onClose} title={t('dash.collect')} subtitle={t('bill.choosePatient')} footer={<Button onClick={onClose}>{t('common.cancel')}</Button>}>
      <div className="stack">
        <PatientPicker label={t('appt.patient')} value={patient} onChange={setPatient} />
        {patient && q.isLoading && <Loading />}
        {patient && q.data && !q.data.items.length && <EmptyState title={t('bill.noOutstanding')} />}
        {patient && q.data && q.data.items.length > 0 && (
          <div className="stack tight">
            <span className="field-label">{t('bill.selectInvoice')}</span>
            {q.data.items.map((i) => (
              <button
                key={i.id}
                className="menu-item subtle-box"
                style={{ justifyContent: 'space-between' }}
                onClick={() => {
                  onClose();
                  actions.recordPayment({ invoiceId: i.id });
                }}
              >
                <span>
                  <span className="strong ltr">{i.number}</span> <span className="xs muted">· {t(`bill.kind.${i.kind}` as TKey)} · {fmt.day(i.issueDate)}</span>
                </span>
                <span className="strong num" style={{ color: 'var(--warning)' }}>
                  {fmt.money(i.balance)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
