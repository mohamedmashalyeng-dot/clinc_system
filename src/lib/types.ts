// Shapes returned by the API (kept in one place so pages reference shared records consistently).
import type { WeeklyHours } from '@shared/domain';
import type { Role } from '@shared/permissions';
import type { Preferences } from '@shared/schemas';
import type { AppointmentStatus, PatientSegment } from '@shared/domain';

export interface Settings {
  clinicName: string;
  clinicNameAr: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxRegistration: string | null;
  defaultLanguage: 'en' | 'ar';
  currency: string;
  timezone: string;
  taxRatePercent: number;
  slotMinutes: number;
  openingHours: WeeklyHours;
  cancellation: {
    minNoticeHours: number;
    lateCancelDeposit: 'retain' | 'refund';
    noShowDeposit: 'retain' | 'refund';
    policyTextEn: string | null;
    policyTextAr: string | null;
  };
  packageExpiryWarningDays: number;
  expiryWarningDays: number;
  integrations: Record<string, 'connected' | 'not_connected'>;
  hasLogo: boolean;
  brandColor?: string | null;
}

export interface Me {
  user: { id: number; name: string; email: string; role: Role; practitionerId: number | null };
  preferences: Preferences;
  permissions: string[];
  demoMode: boolean;
  settings: Settings;
}

export interface Service {
  id: number;
  nameEn: string;
  nameAr: string;
  categoryId: number;
  durationMin: number;
  price: number;
  depositAmount: number;
  qualification: string | null;
  roomIds: number[];
  deviceIds: number[];
  bufferBeforeMin: number;
  bufferAfterMin: number;
  active: boolean;
}
export interface Practitioner {
  id: number;
  userId: number | null;
  displayName: string;
  displayNameAr: string;
  qualifications: string[];
  color: string;
  hours: WeeklyHours;
  active: boolean;
}
export interface Room {
  id: number;
  name: string;
  nameAr: string | null;
  active: boolean;
}
export interface Device {
  id: number;
  name: string;
  nameAr: string | null;
  model: string | null;
  roomId: number | null;
  active: boolean;
  maintenanceNote: string | null;
}
/** Practitioner leave, sickness or training. `kind`/`note` are null for viewers without scheduling rights. */
export interface TimeOff {
  id: number;
  practitionerId: number;
  kind: string | null;
  note: string | null;
  allDay: boolean;
  startAt: string;
  endAt: string;
  /** Clinic-local, end date inclusive. */
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  status: 'active' | 'cancelled';
  createdByName: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  affectedCount: number;
}
export interface Category {
  id: number;
  nameEn: string;
  nameAr: string;
  active: boolean;
}
export interface PackageTemplate {
  id: number;
  nameEn: string;
  nameAr: string;
  price: number;
  validityDays: number;
  termsEn: string | null;
  termsAr: string | null;
  active: boolean;
  items: { serviceId: number; quantity: number }[];
}
export interface ConsentTemplate {
  id: number;
  type: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  version: number;
  active: boolean;
}
export interface Reference {
  services: Service[];
  categories: Category[];
  practitioners: Practitioner[];
  rooms: Room[];
  devices: Device[];
  qualifications: { code: string; nameEn: string; nameAr: string }[];
  packageTemplates: PackageTemplate[];
  consentTemplates: ConsentTemplate[];
  users: { id: number; name: string; role: string; active: boolean }[];
}

export interface PaymentState {
  state: 'package' | 'paid' | 'deposit_paid' | 'partially_paid' | 'unpaid' | 'deposit_due';
  invoiceId: number | null;
  balance: number;
  paid: number;
}

export interface Appointment {
  id: number;
  patientId: number | null;
  patientName: string | null;
  patientPhone: string | null;
  patientCode: string | null;
  masked: boolean;
  serviceId: number;
  practitionerId: number;
  roomId: number;
  deviceId: number | null;
  startAt: string;
  endAt: string;
  blockStart: string;
  blockEnd: string;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  status: AppointmentStatus;
  notes: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  purchasedPackageId: number | null;
  packageEn: string | null;
  packageAr: string | null;
  sessionId: number | null;
  sessionStatus: string | null;
  payment: PaymentState | null;
  depositAmount: number;
  /** Only on upcoming bookings with a medium or high risk. */
  noShowRisk?: NoShowRisk | null;
}

export interface NoShowRisk {
  level: 'low' | 'medium' | 'high';
  reasons: { code: 'no_shows' | 'late_cancellations' | 'first_visit'; n?: number }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PatientListItem {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  email: string | null;
  dob: string | null;
  age: number | null;
  lastVisit: string | null;
  nextVisit: string | null;
  outstanding: number | null;
  activePackages: number;
  segment: PatientSegment | null;
  lapsed: boolean;
}

export interface Patient {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  altPhone: string | null;
  email: string | null;
  dob: string | null;
  age: number | null;
  gender: 'female' | 'male' | 'unspecified';
  address: string | null;
  emergencyName: string | null;
  emergencyPhone: string | null;
  emergencyRelation: string | null;
  preferredLanguage: 'ar' | 'en';
  contactChannel: string;
  allowReminders: boolean;
  allowMarketing: boolean;
  primaryPractitionerId: number | null;
  adminNotes: string | null;
  source: string | null;
  referredByPatientId: number | null;
  /** Present on the profile response. */
  referredByName?: string | null;
  createdAt: string;
}

export interface PatientInsights {
  segment: PatientSegment;
  lapsed: boolean;
  daysSinceLastVisit: number | null;
  completedVisits: number;
  noShows: number;
  cancellations: number;
  lateCancellations: number;
  firstVisit: string | null;
  lastVisit: string | null;
  avgIntervalDays: number | null;
  attendanceRate: number | null;
  lifetimeValue: number | null;
  avgPerVisit: number | null;
  noShowRisk: NoShowRisk;
  referrals: number;
}

export interface Alert {
  id?: number;
  text: string;
  severity: 'high' | 'medium' | 'low';
}

export interface PackageItem {
  serviceId: number;
  serviceNameEn: string;
  serviceNameAr: string;
  quantity: number;
  consumed: number;
  reversed: number;
  adjusted: number;
  used: number;
  remaining: number;
}

export interface PackageSummary {
  id: number;
  patientId: number;
  templateId: number;
  nameEn: string;
  nameAr: string;
  price: number;
  discount: number;
  purchaseDate: string;
  startDate: string;
  expiryDate: string;
  status: 'active' | 'cancelled';
  state: 'active' | 'expired' | 'used_up' | 'cancelled';
  invoiceId: number | null;
  invoiceNumber: string | null;
  invoiceTotal: number;
  paid: number;
  balance: number;
  items: PackageItem[];
  totalSessions: number;
  usedSessions: number;
  remainingSessions: number;
  termsEn: string | null;
  termsAr: string | null;
}

export interface LedgerEntry {
  id: number;
  serviceId: number;
  delta: number;
  kind: 'consume' | 'reversal' | 'adjustment';
  sessionId: number | null;
  appointmentId: number | null;
  reason: string | null;
  createdAt: string;
  byName: string | null;
  startAt: string | null;
}

export interface Batch {
  id: number;
  itemId: number;
  batchNumber: string;
  expiryDate: string | null;
  onHand: number;
  expired: boolean;
  expiringSoon: boolean;
}

export interface Notification {
  key: string;
  kind: string;
  severity: 'high' | 'medium' | 'low';
  params: Record<string, string | number>;
  link: string;
}
