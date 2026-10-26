import { all, get, nextNumber, nowIso, run, scalar, tx } from '../db/db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';
import { getSettings, clinicToday } from '../settings.js';
import { computeInvoiceTotals, lineTotal } from '../../shared/money.js';
import type { PaymentMethod } from '../../shared/domain.js';
import { getService } from './reference.js';

export interface InvoiceLine {
  description: string;
  serviceId?: number | null;
  packageTemplateId?: number | null;
  quantity: number;
  unitPrice: number;
  discount: number;
}

export interface InvoiceBalance {
  id: number;
  total: number;
  paid: number;
  refunded: number;
  netPaid: number;
  balance: number;
  status: 'issued' | 'void';
  paymentStatus: 'void' | 'paid' | 'partially_paid' | 'unpaid';
}

export const INVOICE_BALANCE_SQL = `
  i.total
  - COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0)
  + COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0)`;

export function invoiceBalance(invoiceId: number): InvoiceBalance {
  const r = get<{ id: number; total: number; status: 'issued' | 'void'; paid: number; refunded: number }>(
    `SELECT i.id, i.total, i.status,
            COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS paid,
            COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0) AS refunded
       FROM invoices i WHERE i.id = ?`,
    [invoiceId],
  );
  if (!r) throw notFound('Invoice');
  const netPaid = r.paid - r.refunded;
  const balance = r.status === 'void' ? 0 : r.total - netPaid;
  const paymentStatus = r.status === 'void' ? 'void' : balance <= 0 ? 'paid' : netPaid > 0 ? 'partially_paid' : 'unpaid';
  return { ...r, netPaid, balance, paymentStatus };
}

export function createInvoice(
  user: AuthUser,
  input: {
    patientId: number;
    kind: 'service' | 'package' | 'custom';
    appointmentId?: number | null;
    lines: InvoiceLine[];
    discountReason?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
  },
): number {
  return tx(() => {
    if (input.idempotencyKey) {
      const existing = scalar<number | null>('SELECT id FROM invoices WHERE idempotency_key = ?', [input.idempotencyKey]);
      if (existing) return existing;
    }
    const hasDiscount = input.lines.some((l) => l.discount > 0);
    if (hasDiscount && !user.permissions.has('discounts.apply')) {
      throw forbidden('Applying a discount requires the "discounts.apply" permission.', 'DISCOUNT_NOT_ALLOWED');
    }
    if (hasDiscount && !input.discountReason) throw badRequest('DISCOUNT_REASON_REQUIRED', 'Give a reason for the discount.');
    for (const l of input.lines) {
      if (l.discount > l.quantity * l.unitPrice) throw badRequest('DISCOUNT_TOO_LARGE', 'A discount cannot exceed the line amount.');
    }
    const taxRate = getSettings().taxRatePercent;
    const totals = computeInvoiceTotals(input.lines, taxRate);
    const number = nextNumber('invoice', 'INV');
    const { id } = run(
      `INSERT INTO invoices(number, patient_id, appointment_id, kind, status, issue_date, subtotal, discount_total, tax_rate, tax,
                            adjustments_total, total, discount_reason, notes, created_by, created_at, idempotency_key)
       VALUES (?,?,?,?, 'issued', ?,?,?,?,?, 0, ?,?,?,?,?,?)`,
      [
        number,
        input.patientId,
        input.appointmentId ?? null,
        input.kind,
        clinicToday(),
        totals.subtotal,
        totals.discountTotal,
        taxRate,
        totals.tax,
        totals.total,
        hasDiscount ? input.discountReason : null,
        input.notes ?? null,
        user.id,
        nowIso(),
        input.idempotencyKey ?? null,
      ],
    );
    for (const l of input.lines) {
      run(
        'INSERT INTO invoice_items(invoice_id, description, service_id, package_template_id, quantity, unit_price, discount, line_total) VALUES (?,?,?,?,?,?,?,?)',
        [id, l.description, l.serviceId ?? null, l.packageTemplateId ?? null, l.quantity, l.unitPrice, l.discount, lineTotal(l)],
      );
    }
    audit(user, 'invoice.create', { entityType: 'invoice', entityId: id, patientId: input.patientId, summary: `${number} issued`, meta: { total: totals.total } });
    return id;
  });
}

/** The single live invoice for an appointment, created on first need (deposit, checkout or completion). */
export function ensureAppointmentInvoice(user: AuthUser, appointmentId: number): number {
  return tx(() => {
    const existing = scalar<number | null>("SELECT id FROM invoices WHERE appointment_id = ? AND status <> 'void'", [appointmentId]);
    if (existing) return existing;
    const appt = get<{ patient_id: number; service_id: number; purchased_package_id: number | null; status: string }>(
      'SELECT patient_id, service_id, purchased_package_id, status FROM appointments WHERE id = ?',
      [appointmentId],
    );
    if (!appt) throw notFound('Appointment');
    if (appt.purchased_package_id) {
      throw badRequest('PACKAGE_COVERED', 'This appointment is covered by a package, so there is nothing to invoice.');
    }
    const service = getService(appt.service_id)!;
    return createInvoice(user, {
      patientId: appt.patient_id,
      kind: 'service',
      appointmentId,
      lines: [{ description: service.nameEn, serviceId: service.id, quantity: 1, unitPrice: service.price, discount: 0 }],
    });
  });
}

export function recordPayment(
  user: AuthUser,
  invoiceId: number,
  input: { amount: number; method: PaymentMethod; reference: string | null; kind: 'payment' | 'deposit'; idempotencyKey: string },
): { paymentId: number; duplicate: boolean } {
  return tx(() => {
    const existing = get<{ id: number; invoice_id: number }>('SELECT id, invoice_id FROM payments WHERE idempotency_key = ?', [input.idempotencyKey]);
    if (existing) {
      if (existing.invoice_id !== invoiceId) throw conflict('IDEMPOTENCY_MISMATCH', 'This request key was already used for another invoice.');
      return { paymentId: existing.id, duplicate: true };
    }
    const inv = get<{ patient_id: number; number: string; status: string }>('SELECT patient_id, number, status FROM invoices WHERE id = ?', [invoiceId]);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') throw conflict('INVOICE_VOID', 'This invoice is void and cannot take payments.');
    const bal = invoiceBalance(invoiceId);
    if (bal.balance <= 0) throw conflict('INVOICE_ALREADY_PAID', 'This invoice is already fully paid.');
    if (input.amount > bal.balance) {
      throw conflict('OVERPAYMENT', `The amount is more than the outstanding balance.`, { balance: bal.balance });
    }
    const number = nextNumber('receipt', 'RCT');
    const { id } = run(
      `INSERT INTO payments(number, invoice_id, patient_id, amount, method, reference, kind, received_at, received_by, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [number, invoiceId, inv.patient_id, input.amount, input.method, input.reference, input.kind, nowIso(), user.id, input.idempotencyKey],
    );
    audit(user, 'payment.record', {
      entityType: 'payment',
      entityId: id,
      patientId: inv.patient_id,
      summary: `${number} recorded against ${inv.number}`,
      meta: { amount: input.amount, method: input.method, kind: input.kind },
    });
    return { paymentId: id, duplicate: false };
  });
}

export function refundable(paymentId: number): number {
  const p = get<{ amount: number }>('SELECT amount FROM payments WHERE id = ?', [paymentId]);
  if (!p) throw notFound('Payment');
  const refunded = scalar<number>('SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE payment_id = ?', [paymentId]);
  return p.amount - refunded;
}

export function issueRefund(
  user: AuthUser,
  paymentId: number,
  input: { amount: number; method: PaymentMethod; reason: string; idempotencyKey: string },
): { refundId: number; duplicate: boolean } {
  return tx(() => {
    const existing = get<{ id: number; payment_id: number }>('SELECT id, payment_id FROM refunds WHERE idempotency_key = ?', [input.idempotencyKey]);
    if (existing) {
      if (existing.payment_id !== paymentId) throw conflict('IDEMPOTENCY_MISMATCH', 'This request key was already used for another payment.');
      return { refundId: existing.id, duplicate: true };
    }
    const p = get<{ invoice_id: number; patient_id: number; number: string }>('SELECT invoice_id, patient_id, number FROM payments WHERE id = ?', [paymentId]);
    if (!p) throw notFound('Payment');
    const available = refundable(paymentId);
    if (input.amount > available) throw conflict('REFUND_EXCEEDS_PAYMENT', 'The refund is more than the amount still refundable on this payment.', { available });
    const number = nextNumber('refund', 'RFD');
    const { id } = run(
      `INSERT INTO refunds(number, payment_id, invoice_id, patient_id, amount, method, reason, created_by, created_at, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [number, paymentId, p.invoice_id, p.patient_id, input.amount, input.method, input.reason, user.id, nowIso(), input.idempotencyKey],
    );
    audit(user, 'refund.issue', {
      entityType: 'refund',
      entityId: id,
      patientId: p.patient_id,
      summary: `${number} against payment ${p.number}`,
      meta: { amount: input.amount },
    });
    return { refundId: id, duplicate: false };
  });
}

export function addAdjustment(user: AuthUser, invoiceId: number, amount: number, reason: string): void {
  tx(() => {
    const inv = get<{ status: string; patient_id: number; number: string; adjustments_total: number; subtotal: number; discount_total: number; tax: number }>(
      'SELECT status, patient_id, number, adjustments_total, subtotal, discount_total, tax FROM invoices WHERE id = ?',
      [invoiceId],
    );
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') throw conflict('INVOICE_VOID', 'This invoice is void.');
    const adjustments = inv.adjustments_total + amount;
    const newTotal = inv.subtotal - inv.discount_total + inv.tax + adjustments;
    if (newTotal < 0) throw badRequest('ADJUSTMENT_TOO_LARGE', 'The adjustment would make the invoice total negative.');
    const bal = invoiceBalance(invoiceId);
    if (newTotal < bal.netPaid) {
      throw conflict('ADJUSTMENT_BELOW_PAID', 'The new total would be less than what has been paid. Issue a refund first.', { netPaid: bal.netPaid });
    }
    run('INSERT INTO invoice_adjustments(invoice_id, amount, reason, created_by, created_at) VALUES (?,?,?,?,?)', [invoiceId, amount, reason, user.id, nowIso()]);
    run('UPDATE invoices SET adjustments_total = ?, total = ? WHERE id = ?', [adjustments, newTotal, invoiceId]);
    audit(user, 'invoice.adjust', { entityType: 'invoice', entityId: invoiceId, patientId: inv.patient_id, summary: `${inv.number} adjusted`, meta: { amount } });
  });
}

export function voidInvoice(user: AuthUser, invoiceId: number, reason: string): void {
  tx(() => {
    const inv = get<{ status: string; patient_id: number; number: string; kind: string }>('SELECT status, patient_id, number, kind FROM invoices WHERE id = ?', [invoiceId]);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'void') return;
    const bal = invoiceBalance(invoiceId);
    if (bal.netPaid > 0) throw conflict('INVOICE_HAS_PAYMENTS', 'Refund the payments on this invoice before voiding it.', { netPaid: bal.netPaid });
    if (inv.kind === 'package') {
      const used = scalar<number>(
        "SELECT COUNT(*) FROM package_usage u JOIN purchased_packages p ON p.id = u.purchased_package_id WHERE p.invoice_id = ? AND u.kind = 'consume'",
        [invoiceId],
      );
      if (used) throw conflict('PACKAGE_IN_USE', 'Sessions have already been used from this package, so its invoice cannot be voided. Use an adjustment instead.');
      run("UPDATE purchased_packages SET status = 'cancelled' WHERE invoice_id = ?", [invoiceId]);
    }
    run("UPDATE invoices SET status = 'void', voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ?", [user.id, nowIso(), reason, invoiceId]);
    audit(user, 'invoice.void', { entityType: 'invoice', entityId: invoiceId, patientId: inv.patient_id, summary: `${inv.number} voided` });
  });
}

export function patientOutstanding(patientId: number): number {
  return scalar<number>(
    `SELECT COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) FROM invoices i WHERE i.patient_id = ? AND i.status = 'issued'`,
    [patientId],
  );
}

/** Deposit/payment state of an appointment, for badges in the calendar and lists. */
export function appointmentPaymentState(appt: { id: number; purchased_package_id: number | null; deposit_amount?: number; status?: string }): {
  state: 'package' | 'paid' | 'deposit_paid' | 'partially_paid' | 'unpaid' | 'deposit_due';
  invoiceId: number | null;
  balance: number;
  paid: number;
} {
  if (appt.purchased_package_id) return { state: 'package', invoiceId: null, balance: 0, paid: 0 };
  // A deposit is only "due" while the visit is still ahead; afterwards the whole amount is simply unpaid.
  const depositDue = !!appt.deposit_amount && (!appt.status || appt.status === 'booked' || appt.status === 'confirmed');
  const inv = get<{ id: number }>("SELECT id FROM invoices WHERE appointment_id = ? AND status <> 'void'", [appt.id]);
  if (!inv) return { state: depositDue ? 'deposit_due' : 'unpaid', invoiceId: null, balance: 0, paid: 0 };
  const b = invoiceBalance(inv.id);
  const kinds = all<{ kind: string }>('SELECT DISTINCT kind FROM payments WHERE invoice_id = ?', [inv.id]);
  const depositsOnly = kinds.length > 0 && kinds.every((p) => p.kind === 'deposit');
  const state = b.balance <= 0 ? 'paid' : b.netPaid > 0 ? (depositsOnly ? 'deposit_paid' : 'partially_paid') : depositDue ? 'deposit_due' : 'unpaid';
  return { state, invoiceId: inv.id, balance: b.balance, paid: b.netPaid };
}
