import { useQuery } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, EmptyState, ErrorState, Loading } from '@/components/ui';
import { useActions } from '@/layout/actions';
import { PackageCard } from '@/pages/services/PackageCard';
import type { LedgerEntry, PackageSummary } from '@/lib/types';
import type { PatientRef } from '@/components/pickers';

export function PackagesTab({ patientId, patient }: { patientId: number; patient: PatientRef }) {
  const { t } = useI18n();
  const { can } = useSession();
  const actions = useActions();
  const q = useQuery({ queryKey: ['patient-packages', patientId], queryFn: () => api.get<{ items: (PackageSummary & { ledger: LedgerEntry[] })[] }>(`/patients/${patientId}/packages`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="stack">
      <div className="row between">
        <h2>{t('tab.packages')}</h2>
        {can('packages.sell') && (
          <Button variant="primary" icon={<Package size={16} />} onClick={() => actions.sellPackage(patient)}>
            {t('pkg.sell')}
          </Button>
        )}
      </div>
      {!q.data!.items.length && <EmptyState title={t('pkg.none')} />}
      {q.data!.items.map((p) => (
        <PackageCard key={p.id} pkg={p} ledger={p.ledger} patient={patient} />
      ))}
    </div>
  );
}
