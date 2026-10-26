import { Navigate, Outlet, createBrowserRouter, useRouteError } from 'react-router';
import { useMeQuery, SessionProvider, useSession } from './lib/session';
import { Loading, ErrorState } from './components/ui';
import { AppShell } from './layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { AppointmentsPage } from './pages/appointments/AppointmentsPage';
import { PatientsPage } from './pages/patients/PatientsPage';
import { PatientProfilePage } from './pages/patients/PatientProfilePage';
import { WorkspacePage } from './pages/workspace/WorkspacePage';
import { ServicesPage } from './pages/services/ServicesPage';
import { BillingPage } from './pages/billing/BillingPage';
import { PrintInvoicePage, PrintReceiptPage } from './pages/billing/PrintPages';
import { InventoryPage } from './pages/inventory/InventoryPage';
import { FollowUpPage } from './pages/followup/FollowUpPage';
import { PhotoGalleryPage } from './pages/photos/PhotoGalleryPage';
import { ReportsPage } from './pages/reports/ReportsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import type { Permission } from '@shared/permissions';

function Root() {
  const me = useMeQuery();
  if (me.isLoading) return <Loading />;
  if (!me.data) return <LoginPage onSignedIn={() => me.refetch()} />;
  return (
    <SessionProvider me={me.data}>
      <Outlet />
    </SessionProvider>
  );
}

function RouteError() {
  const err = useRouteError();
  return <ErrorState error={err} onRetry={() => window.location.reload()} />;
}

/** Page-level permission gate; the API enforces the same rules independently. */
function Gate({ any, children }: { any: Permission[]; children: React.ReactNode }) {
  const { canAny } = useSession();
  if (!canAny(...any)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Home() {
  const { can } = useSession();
  if (can('dashboard.view')) return <DashboardPage />;
  if (can('appointments.view')) return <Navigate to="/appointments" replace />;
  return <Navigate to="/patients" replace />;
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Home /> },
          { path: 'appointments', element: <Gate any={['appointments.view']}><AppointmentsPage /></Gate> },
          { path: 'patients', element: <Gate any={['patients.view']}><PatientsPage /></Gate> },
          { path: 'patients/:id', element: <Gate any={['patients.view']}><PatientProfilePage /></Gate> },
          { path: 'workspace/:appointmentId', element: <Gate any={['treatment.perform']}><WorkspacePage /></Gate> },
          { path: 'services', element: <Gate any={['packages.view', 'settings.manage']}><ServicesPage /></Gate> },
          { path: 'billing', element: <Gate any={['billing.view']}><BillingPage /></Gate> },
          { path: 'inventory', element: <Gate any={['inventory.view']}><InventoryPage /></Gate> },
          { path: 'follow-up', element: <Gate any={['followup.view']}><FollowUpPage /></Gate> },
          { path: 'photos', element: <Gate any={['photos.view']}><PhotoGalleryPage /></Gate> },
          { path: 'reports', element: <Gate any={['reports.financial', 'reports.operational']}><ReportsPage /></Gate> },
          { path: 'settings', element: <Gate any={['settings.manage', 'staff.manage', 'permissions.manage', 'audit.view']}><SettingsPage /></Gate> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
      { path: 'print/invoice/:id', element: <Gate any={['billing.view']}><PrintInvoicePage /></Gate> },
      { path: 'print/receipt/:id', element: <Gate any={['billing.view']}><PrintReceiptPage /></Gate> },
    ],
  },
]);
