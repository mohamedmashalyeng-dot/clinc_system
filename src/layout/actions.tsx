// App-wide actions (book, add patient, collect payment, open a record) so every page opens
// the same dialogs and drawers for the same records.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Appointment, Patient } from '@/lib/types';
import type { PatientRef } from '@/components/pickers';
import { PatientFormDialog } from '@/pages/patients/PatientFormDialog';
import { AppointmentFormDialog, type BookingPrefill } from '@/pages/appointments/AppointmentFormDialog';
import { AppointmentDrawer } from '@/pages/appointments/AppointmentDrawer';
import { InvoiceDrawer } from '@/pages/billing/InvoiceDrawer';
import { PaymentDialog, type PaymentTarget } from '@/pages/billing/PaymentDialog';
import { CollectPaymentDialog } from '@/pages/billing/CollectPaymentDialog';
import { SellPackageDialog } from '@/pages/services/SellPackageDialog';
import { WaitlistDialog, type WaitlistPrefill } from '@/pages/appointments/Waitlist';

interface Actions {
  newPatient: (onCreated?: (id: number) => void) => void;
  editPatient: (p: Patient) => void;
  book: (prefill?: BookingPrefill) => void;
  reschedule: (a: Appointment) => void;
  openAppointment: (id: number) => void;
  openInvoice: (id: number) => void;
  recordPayment: (target: PaymentTarget) => void;
  collectPayment: (patient?: PatientRef) => void;
  sellPackage: (patient: PatientRef) => void;
  addToWaitlist: (prefill?: WaitlistPrefill) => void;
}

const Ctx = createContext<Actions | null>(null);

export function ActionsProvider({ children }: { children: ReactNode }) {
  const [patientDlg, setPatientDlg] = useState<{ patient?: Patient; onCreated?: (id: number) => void } | null>(null);
  const [booking, setBooking] = useState<{ prefill?: BookingPrefill; appointment?: Appointment } | null>(null);
  const [apptId, setApptId] = useState<number | null>(null);
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  const [payment, setPayment] = useState<PaymentTarget | null>(null);
  const [collect, setCollect] = useState<{ patient?: PatientRef } | null>(null);
  const [sell, setSell] = useState<PatientRef | null>(null);
  const [waitlist, setWaitlist] = useState<{ prefill?: WaitlistPrefill } | null>(null);

  const actions = useMemo<Actions>(
    () => ({
      newPatient: (onCreated) => setPatientDlg({ onCreated }),
      editPatient: (patient) => setPatientDlg({ patient }),
      book: (prefill) => setBooking({ prefill }),
      reschedule: (appointment) => setBooking({ appointment }),
      openAppointment: (id) => setApptId(id),
      openInvoice: (id) => setInvoiceId(id),
      recordPayment: (target) => setPayment(target),
      collectPayment: (patient) => setCollect({ patient }),
      sellPackage: (patient) => setSell(patient),
      addToWaitlist: (prefill) => setWaitlist({ prefill }),
    }),
    [],
  );

  return (
    <Ctx.Provider value={actions}>
      {children}
      {patientDlg && <PatientFormDialog patient={patientDlg.patient} onCreated={patientDlg.onCreated} onClose={() => setPatientDlg(null)} />}
      {booking && <AppointmentFormDialog prefill={booking.prefill} appointment={booking.appointment} onClose={() => setBooking(null)} />}
      {apptId !== null && <AppointmentDrawer id={apptId} onClose={() => setApptId(null)} />}
      {invoiceId !== null && <InvoiceDrawer id={invoiceId} onClose={() => setInvoiceId(null)} />}
      {payment && <PaymentDialog target={payment} onClose={() => setPayment(null)} />}
      {collect && <CollectPaymentDialog patient={collect.patient} onClose={() => setCollect(null)} />}
      {sell && <SellPackageDialog patient={sell} onClose={() => setSell(null)} />}
      {waitlist && <WaitlistDialog prefill={waitlist.prefill} onClose={() => setWaitlist(null)} />}
    </Ctx.Provider>
  );
}

export function useActions(): Actions {
  const c = useContext(Ctx);
  if (!c) throw new Error('useActions outside provider');
  return c;
}
