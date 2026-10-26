import { useParams, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarPlus, ChevronLeft, CreditCard, Package, Pencil, Phone } from 'lucide-react';
import { api } from '@/lib/api';
import { useUrlState, initials } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, ErrorState, Loading, Tabs, Restricted } from '@/components/ui';
import { useActions } from '@/layout/actions';
import type { Alert, Patient } from '@/lib/types';
import { OverviewTab } from './tabs/OverviewTab';
import { MedicalTab } from './tabs/MedicalTab';
import { AppointmentsTab } from './tabs/AppointmentsTab';
import { TreatmentTab } from './tabs/TreatmentTab';
import { PackagesTab } from './tabs/PackagesTab';
import { PhotosTab } from './tabs/PhotosTab';
import { BillingTab } from './tabs/BillingTab';
import { ConsentsTab } from './tabs/ConsentsTab';
import type { TKey } from '@/i18n/en';

export interface PatientOverview {
  patient: Patient;
  nextAppointment: { id: number; startAt: string; status: string; nameEn: string; nameAr: string; displayName: string; displayNameAr: string } | null;
  packages: { id: number; nameEn: string; nameAr: string; state: string; remainingSessions: number; totalSessions: number; expiryDate: string; balance: number }[] | null;
  outstanding: number | null;
  clinical: { alerts: Alert[]; allergies: string | null; precautions: string | null; pregnant: string } | null;
  consents: Record<string, { status: string; recordedAt: string } | null> | null;
  activity: { at: string; type: string; serviceEn?: string; serviceAr?: string; amount?: number; number?: string; nameEn?: string; nameAr?: string; by?: string }[];
  stats: { completedVisits: number; noShows: number; cancellations: number };
}

type TabId = 'overview' | 'medical' | 'appointments' | 'treatment' | 'packages' | 'photos' | 'billing' | 'consents';

export function PatientProfilePage() {
  const id = Number(useParams().id);
  const { t } = useI18n();
  const fmt = useFmt();
  const { can } = useSession();
  const actions = useActions();
  const [s, set] = useUrlState({ tab: 'overview' });
  const tab = s.tab as TabId;
  const q = useQuery({ queryKey: ['patient', id], queryFn: () => api.get<PatientOverview>(`/patients/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { patient } = q.data;
  const ref = { id: patient.id, fullName: patient.fullName, phone: patient.phone, code: patient.code };
  const highAlerts = q.data.clinical?.alerts.filter((a) => a.severity === 'high').length ?? 0;
  const activePkgs = q.data.packages?.filter((p) => p.state === 'active') ?? [];

  const tabs: { id: TabId; label: string; locked?: boolean }[] = [
    { id: 'overview', label: t('tab.overview') },
    { id: 'medical', label: t('tab.medical'), locked: !can('medical.view') },
    { id: 'appointments', label: t('tab.appointments'), locked: !can('appointments.view') },
    { id: 'treatment', label: t('tab.treatment'), locked: !can('appointments.view') },
    { id: 'packages', label: t('tab.packages'), locked: !can('packages.view') },
    { id: 'photos', label: t('tab.photos') },
    { id: 'billing', label: t('tab.billing'), locked: !can('billing.view') },
    { id: 'consents', label: t('tab.consents'), locked: !can('consents.view') },
  ];

  return (
    <div className="page">
      <div>
        <Link to="/patients" className="small row" style={{ display: 'inline-flex' }}>
          <ChevronLeft size={14} className="flip-rtl" /> {t('pat.title')}
        </Link>
      </div>
      <div className="profile-head">
        <span className="avatar lg" aria-hidden>
          {initials(patient.fullName)}
        </span>
        <div className="who">
          <h1>{patient.fullName}</h1>
          <div className="row wrap small muted" style={{ gap: 12 }}>
            <span>{patient.code}</span>
            {patient.age !== null && <span>{t('pat.yearsOld', { n: patient.age })}</span>}
            <span>{t(`pat.gender.${patient.gender}` as TKey)}</span>
            <a href={`tel:${patient.phone}`} className="row ltr" style={{ gap: 4 }}>
              <Phone size={13} /> {patient.phone}
            </a>
            <span>{t('pat.since', { date: fmt.date(patient.createdAt) })}</span>
          </div>
          <div className="tag-row">
            {highAlerts > 0 && (
              <Badge tone="danger">
                <AlertTriangle size={12} /> {highAlerts} {t('ov.alerts')}
              </Badge>
            )}
            {activePkgs.map((p) => (
              <Badge key={p.id} tone="accent">
                <Package size={12} /> {p.remainingSessions}/{p.totalSessions}
              </Badge>
            ))}
            {q.data.outstanding ? <Badge tone="warning">{t('pat.balance')}: {fmt.money(q.data.outstanding)}</Badge> : null}
            {!patient.allowReminders && <Badge tone="outline">{t('fu.optedOut')}</Badge>}
          </div>
        </div>
        <div className="toolbar">
          {can('appointments.manage') && (
            <Button variant="primary" icon={<CalendarPlus size={16} />} onClick={() => actions.book({ patient: ref })}>
              {t('pat.book')}
            </Button>
          )}
          {can('packages.sell') && (
            <Button icon={<Package size={16} />} onClick={() => actions.sellPackage(ref)}>
              {t('pat.sellPackage')}
            </Button>
          )}
          {can('payments.record') && (
            <Button icon={<CreditCard size={16} />} onClick={() => actions.collectPayment(ref)}>
              {t('pat.collect')}
            </Button>
          )}
          {can('patients.edit') && (
            <Button variant="ghost" icon={<Pencil size={16} />} onClick={() => actions.editPatient(patient)}>
              {t('common.edit')}
            </Button>
          )}
        </div>
      </div>

      <Tabs label={patient.fullName} tabs={tabs} value={tab} onChange={(v) => set({ tab: v })} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' && <OverviewTab data={q.data} onTab={(x) => set({ tab: x })} />}
        {tab === 'medical' && (can('medical.view') ? <MedicalTab patientId={id} /> : <Restricted perm="medical.view" clinical />)}
        {tab === 'appointments' && (can('appointments.view') ? <AppointmentsTab patientId={id} patient={ref} /> : <Restricted perm="appointments.view" />)}
        {tab === 'treatment' && (can('appointments.view') ? <TreatmentTab patientId={id} /> : <Restricted perm="appointments.view" />)}
        {tab === 'packages' && (can('packages.view') ? <PackagesTab patientId={id} patient={ref} /> : <Restricted perm="packages.view" />)}
        {tab === 'photos' && <PhotosTab patientId={id} />}
        {tab === 'billing' && (can('billing.view') ? <BillingTab patientId={id} patient={ref} /> : <Restricted perm="billing.view" />)}
        {tab === 'consents' && (can('consents.view') ? <ConsentsTab patientId={id} /> : <Restricted perm="consents.view" />)}
      </div>
    </div>
  );
}
