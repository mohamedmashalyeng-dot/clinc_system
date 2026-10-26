// Domain constants and rules shared by the API and the UI.

export const APPOINTMENT_STATUSES = ['booked', 'confirmed', 'arrived', 'in_treatment', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy practitioner/room/device time. */
export const BLOCKING_STATUSES: AppointmentStatus[] = ['booked', 'confirmed', 'arrived', 'in_treatment', 'completed'];

/**
 * Allowed manual status changes. `completed` is intentionally absent as a target:
 * an appointment only becomes completed when its treatment session is completed.
 */
export const STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['booked', 'arrived', 'cancelled', 'no_show'],
  arrived: ['confirmed', 'in_treatment', 'cancelled'],
  in_treatment: ['arrived'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export const TIME_OFF_KINDS = ['leave', 'sick', 'training', 'other'] as const;
export type TimeOffKind = (typeof TIME_OFF_KINDS)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const STOCK_MOVEMENT_TYPES = ['purchase', 'usage', 'waste', 'adjustment'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const CONSENT_TYPES = ['treatment', 'clinical_photography', 'marketing_photography', 'data_processing'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const TEMPLATE_KINDS = ['reminder', 'aftercare', 'followup', 'package_expiry'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const EXPENSE_CATEGORIES = ['supplies', 'rent', 'utilities', 'salaries', 'maintenance', 'marketing', 'other'] as const;

export const DOCUMENT_CATEGORIES = ['identity', 'referral', 'lab_result', 'consent_scan', 'other_clinical', 'other_admin'] as const;
export const CLINICAL_DOCUMENT_CATEGORIES = ['referral', 'lab_result', 'other_clinical'];

export const PHOTO_KINDS = ['before', 'after', 'progress'] as const;

export const BODY_AREAS = [
  'face',
  'upper_lip',
  'chin',
  'neck',
  'underarms',
  'arms',
  'hands',
  'chest',
  'abdomen',
  'back',
  'bikini',
  'full_legs',
  'half_legs',
  'feet',
  'full_body',
] as const;

/** Normalise a phone number so the same Egyptian number written differently matches. */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('20') && digits.length === 12) digits = '0' + digits.slice(2);
  if (digits.length === 10 && digits.startsWith('1')) digits = '0' + digits;
  return digits;
}

export interface WorkingDay {
  open: boolean;
  start: string; // HH:mm
  end: string; // HH:mm
}
/** Index 0 = Sunday … 6 = Saturday */
export type WeeklyHours = WorkingDay[];

export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}

export const TEMPLATE_VARIABLES = ['patient_name', 'clinic_name', 'service', 'date', 'time', 'practitioner', 'package', 'expiry_date', 'remaining'];
