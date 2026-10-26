// Write-payload schemas. The server validates every write with these; the UI reuses
// them so a form shows the same validation the API would apply.
import { z } from 'zod';
import { addDays, isValidDateString } from './time.js';
import {
  APPOINTMENT_STATUSES,
  BODY_AREAS,
  CONSENT_TYPES,
  DOCUMENT_CATEGORIES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  PHOTO_KINDS,
  TEMPLATE_KINDS,
  TIME_OFF_KINDS,
} from './domain.js';
import { ROLES } from './permissions.js';

const required = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const dateStr = z.string().refine(isValidDateString, { message: 'invalid_date' });
const optionalDate = z
  .union([dateStr, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalid_time');
const id = z.number().int().positive();
const optionalId = z
  .union([id, z.null()])
  .optional()
  .transform((v) => v ?? null);
const money = z.number().int().min(0).max(1_000_000_000); // minor units
const phone = z
  .string()
  .trim()
  .min(7)
  .max(25)
  .regex(/^[+\d\s()-]+$/, 'invalid_phone');
const idempotencyKey = z.string().min(8).max(100);

export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });

export const patientSchema = z.object({
  firstName: required(80),
  lastName: required(80),
  phone,
  altPhone: z.union([phone, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  email: z.union([z.string().trim().email().max(150), z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  dob: optionalDate,
  gender: z.enum(['female', 'male', 'unspecified']).default('unspecified'),
  address: optionalText(300),
  emergencyName: optionalText(120),
  emergencyPhone: z.union([phone, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  emergencyRelation: optionalText(60),
  preferredLanguage: z.enum(['ar', 'en']).default('ar'),
  contactChannel: z.enum(['whatsapp', 'sms', 'email', 'phone', 'none']).default('whatsapp'),
  allowReminders: z.boolean().default(true),
  allowMarketing: z.boolean().default(false),
  primaryPractitionerId: optionalId,
  adminNotes: optionalText(1000),
});
export type PatientInput = z.infer<typeof patientSchema>;

export const alertSchema = z.object({
  text: required(300),
  severity: z.enum(['high', 'medium', 'low']),
});

export const medicalSchema = z.object({
  medicalHistory: optionalText(4000),
  allergies: optionalText(1000),
  medications: optionalText(1000),
  skinType: z.enum(['', 'I', 'II', 'III', 'IV', 'V', 'VI']).optional().transform((v) => v || null),
  pregnant: z.enum(['unknown', 'no', 'yes']).default('unknown'),
  precautions: optionalText(2000),
  alerts: z.array(alertSchema).max(20).default([]),
});
export type MedicalInput = z.infer<typeof medicalSchema>;

export const appointmentSchema = z.object({
  patientId: id,
  serviceId: id,
  practitionerId: id,
  roomId: id,
  deviceId: optionalId,
  date: dateStr,
  time: timeStr,
  purchasedPackageId: optionalId,
  notes: optionalText(500),
  status: z.enum(['booked', 'confirmed']).default('booked'),
});
export type AppointmentInput = z.infer<typeof appointmentSchema>;

export const availabilityCheckSchema = appointmentSchema
  .pick({ serviceId: true, practitionerId: true, roomId: true, deviceId: true, date: true, time: true })
  .extend({ excludeAppointmentId: optionalId, patientId: optionalId });

export const statusChangeSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES),
  reason: optionalText(300),
  depositAction: z.enum(['none', 'refund', 'retain']).optional(),
});

export const deviceSettingSchema = z.object({ label: required(60), value: required(60) });
export const consumableLineSchema = z.object({
  itemId: id,
  batchId: id,
  quantity: z.number().positive().max(10000),
});

export const sessionDraftSchema = z.object({
  bodyAreas: z.array(z.enum(BODY_AREAS)).max(15).default([]),
  assessment: optionalText(4000),
  treatmentNotes: optionalText(4000),
  deviceId: optionalId,
  deviceSettings: z.array(deviceSettingSchema).max(20).default([]),
  consumables: z.array(consumableLineSchema).max(30).default([]),
  aftercare: optionalText(3000),
  followUpPlan: optionalText(1000),
  followUpDate: optionalDate,
  purchasedPackageId: optionalId,
  treatmentPlanId: optionalId,
});
export type SessionDraftInput = z.infer<typeof sessionDraftSchema>;

export const completeSessionSchema = z.object({
  idempotencyKey,
  overrideReason: optionalText(300),
});

export const amendSessionSchema = z.object({
  reason: required(300),
  changes: z
    .object({
      assessment: optionalText(4000),
      treatmentNotes: optionalText(4000),
      aftercare: optionalText(3000),
      followUpPlan: optionalText(1000),
    })
    .partial(),
});

export const reverseSessionSchema = z.object({
  reason: required(300),
  restock: z.boolean().default(false),
  idempotencyKey,
});

export const treatmentPlanSchema = z.object({
  title: required(150),
  serviceId: optionalId,
  bodyAreas: z.array(z.enum(BODY_AREAS)).max(15).default([]),
  plannedSessions: z.number().int().min(1).max(50),
  intervalWeeks: z.number().int().min(0).max(52).default(4),
  goals: optionalText(2000),
  notes: optionalText(2000),
  status: z.enum(['active', 'completed', 'stopped']).default('active'),
});

export const sellPackageSchema = z.object({
  patientId: id,
  templateId: id,
  startDate: dateStr,
  discount: money.default(0),
  discountReason: optionalText(200),
  installments: z.number().int().min(1).max(12).default(1),
  initialPayment: z
    .object({ amount: money, method: z.enum(PAYMENT_METHODS), reference: optionalText(100) })
    .optional()
    .nullable(),
  idempotencyKey,
});

export const packageAdjustSchema = z.object({
  serviceId: id,
  delta: z.number().int().min(-50).max(50).refine((v) => v !== 0, 'non_zero'),
  reason: required(300),
  idempotencyKey,
});

export const paymentSchema = z.object({
  amount: money.refine((v) => v > 0, 'positive'),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(100),
  kind: z.enum(['payment', 'deposit']).default('payment'),
  idempotencyKey,
});

export const refundSchema = z.object({
  amount: money.refine((v) => v > 0, 'positive'),
  method: z.enum(PAYMENT_METHODS),
  reason: required(300),
  idempotencyKey,
});

export const invoiceLineSchema = z.object({
  description: required(200),
  serviceId: optionalId,
  quantity: z.number().int().min(1).max(1000),
  unitPrice: money,
  discount: money.default(0),
});

export const invoiceSchema = z.object({
  patientId: id,
  appointmentId: optionalId,
  lines: z.array(invoiceLineSchema).min(1).max(50),
  discountReason: optionalText(200),
  notes: optionalText(500),
  idempotencyKey,
});

export const adjustmentSchema = z.object({
  amount: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((v) => v !== 0, 'non_zero'),
  reason: required(300),
});

export const voidSchema = z.object({ reason: required(300) });

export const expenseSchema = z.object({
  date: dateStr,
  category: z.enum(EXPENSE_CATEGORIES),
  description: required(200),
  vendor: optionalText(120),
  amount: money.refine((v) => v > 0, 'positive'),
  method: z.enum(PAYMENT_METHODS),
  idempotencyKey,
});

export const inventoryItemSchema = z.object({
  sku: required(40),
  name: required(120),
  category: required(60),
  unit: required(20),
  supplier: optionalText(120),
  reorderThreshold: z.number().min(0).max(100000),
  unitCost: money.default(0),
  active: z.boolean().default(true),
});

export const receiveStockSchema = z.object({
  itemId: id,
  batchNumber: required(60),
  expiryDate: optionalDate,
  quantity: z.number().positive().max(100000),
  unitCost: money.default(0),
  reference: optionalText(100),
  idempotencyKey,
});

export const stockMovementSchema = z.object({
  batchId: id,
  type: z.enum(['waste', 'adjustment']),
  quantity: z.number().refine((v) => v !== 0, 'non_zero'),
  reason: required(300),
  idempotencyKey,
});

export const serviceSchema = z.object({
  nameEn: required(120),
  nameAr: required(120),
  categoryId: id,
  durationMin: z.number().int().min(5).max(480),
  price: money,
  depositAmount: money.default(0),
  qualification: optionalText(60),
  roomIds: z.array(id).default([]),
  deviceIds: z.array(id).default([]),
  bufferBeforeMin: z.number().int().min(0).max(120),
  bufferAfterMin: z.number().int().min(0).max(120),
  active: z.boolean().default(true),
});

export const categorySchema = z.object({ nameEn: required(80), nameAr: required(80), active: z.boolean().default(true) });

export const packageTemplateSchema = z.object({
  nameEn: required(120),
  nameAr: required(120),
  price: money,
  validityDays: z.number().int().min(1).max(1825),
  termsEn: optionalText(2000),
  termsAr: optionalText(2000),
  active: z.boolean().default(true),
  items: z.array(z.object({ serviceId: id, quantity: z.number().int().min(1).max(100) })).min(1).max(10),
});

const weeklyHoursSchema = z
  .array(z.object({ open: z.boolean(), start: timeStr, end: timeStr }))
  .length(7)
  .refine((days) => days.every((d) => !d.open || d.start < d.end), 'hours_order');

export const roomSchema = z.object({ name: required(60), nameAr: optionalText(60), active: z.boolean().default(true) });
export const deviceSchema = z.object({
  name: required(80),
  nameAr: optionalText(80),
  model: optionalText(80),
  roomId: optionalId,
  active: z.boolean().default(true),
  maintenanceNote: optionalText(200),
});
export const practitionerSchema = z.object({
  displayName: required(80),
  displayNameAr: required(80),
  userId: optionalId,
  qualifications: z.array(z.string().min(1).max(60)).max(10),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  hours: weeklyHoursSchema,
  active: z.boolean().default(true),
});
/** Whole days (start–end inclusive) or part of a single day. */
export const timeOffSchema = z
  .object({
    practitionerId: id,
    kind: z.enum(TIME_OFF_KINDS),
    startDate: dateStr,
    endDate: dateStr,
    allDay: z.boolean().default(true),
    startTime: z.union([timeStr, z.literal(''), z.null()]).optional().transform((v) => v || null),
    endTime: z.union([timeStr, z.literal(''), z.null()]).optional().transform((v) => v || null),
    note: optionalText(200),
    confirmAffected: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.endDate < d.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'end_before_start' });
    else if (d.endDate > addDays(d.startDate, 365)) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'range_too_long' });
    if (d.allDay) return;
    if (d.endDate !== d.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'single_day' });
    if (!d.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'required' });
    if (!d.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'required' });
    if (d.startTime && d.endTime && d.endTime <= d.startTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'time_order' });
  });
export type TimeOffInput = z.infer<typeof timeOffSchema>;
export const timeOffCancelSchema = z.object({ reason: required(300) });

export const qualificationSchema = z.object({ code: z.string().regex(/^[a-z_]{2,40}$/, 'invalid_code'), nameEn: required(80), nameAr: required(80) });

export const consentTemplateSchema = z.object({
  type: z.enum(CONSENT_TYPES),
  titleEn: required(150),
  titleAr: required(150),
  bodyEn: required(6000),
  bodyAr: required(6000),
  active: z.boolean().default(true),
});

export const recordConsentSchema = z.object({
  templateId: id,
  method: z.enum(['paper_signed', 'in_clinic_acknowledgement']),
  notes: optionalText(300),
});

export const messageTemplateSchema = z.object({
  kind: z.enum(TEMPLATE_KINDS),
  name: required(100),
  bodyEn: required(2000),
  bodyAr: required(2000),
  active: z.boolean().default(true),
});

export const communicationLogSchema = z.object({
  patientId: id,
  channel: z.enum(['whatsapp', 'sms', 'email', 'phone', 'in_person']),
  templateId: optionalId,
  followUpId: optionalId,
  appointmentId: optionalId,
  body: required(2000),
  outcome: z.enum(['contacted_manually', 'no_answer', 'prepared_only']),
});

export const settingsSchema = z.object({
  clinicName: required(100),
  clinicNameAr: required(100),
  address: optionalText(300),
  phone: optionalText(40),
  email: z.union([z.string().email(), z.literal(''), z.null()]).optional().transform((v) => (v ? v : null)),
  taxRegistration: optionalText(60),
  defaultLanguage: z.enum(['ar', 'en']),
  currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(3).max(60).refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'invalid_timezone'),
  taxRatePercent: z.number().min(0).max(50),
  slotMinutes: z.number().int().refine((v) => [5, 10, 15, 20, 30].includes(v)),
  openingHours: weeklyHoursSchema,
  cancellation: z.object({
    minNoticeHours: z.number().int().min(0).max(168),
    lateCancelDeposit: z.enum(['retain', 'refund']),
    noShowDeposit: z.enum(['retain', 'refund']),
    policyTextEn: optionalText(1000),
    policyTextAr: optionalText(1000),
  }),
  packageExpiryWarningDays: z.number().int().min(1).max(180),
  expiryWarningDays: z.number().int().min(1).max(365),
});
export type SettingsInput = z.infer<typeof settingsSchema>;

export const staffSchema = z.object({
  name: required(100),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES),
  active: z.boolean().default(true),
  extraPermissions: z.array(z.string()).max(60).default([]),
  password: z.string().min(8).max(200).optional().or(z.literal('')),
});

export const rolePermissionsSchema = z.object({
  role: z.enum(ROLES),
  permissions: z.array(z.string()).max(60),
  reason: required(300),
});

export const photoMetaSchema = z.object({
  bodyArea: z.enum(BODY_AREAS),
  kind: z.enum(PHOTO_KINDS),
  takenOn: dateStr,
  sessionId: optionalId,
  notes: optionalText(300),
});

export const documentMetaSchema = z.object({
  title: required(150),
  category: z.enum(DOCUMENT_CATEGORIES),
});

export const followUpUpdateSchema = z.object({ status: z.enum(['done', 'dismissed']), note: optionalText(300) });
