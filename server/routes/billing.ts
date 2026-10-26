import { Router } from 'express';
import { all, camel, get, nowIso, run, scalar, tx } from '../db/db.js';
import { assertPatientAccess, assertPerm, patientScopeSql, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { intParam, notFound, optStr, pageParams, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { adjustmentSchema, expenseSchema, invoiceSchema, paymentSchema, refundSchema, voidSchema } from '../../shared/schemas.js';
import { rangeBoundsUtc } from '../../shared/time.js';
import { INVOICE_BALANCE_SQL, addAdjustment, createInvoice, invoiceBalance, issueRefund, recordPayment, refundable, voidInvoice } from '../services/finance.js';

export const billingRouter = Router();
type Row = Record<string, unknown>;

const PAID_SQL = `COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0)`;

billingRouter.get('/invoices', requirePerm('billing.view'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const scope = patientScopeSql(req.user!);
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  const q = optStr(req.query.q);
  if (q) {
    where.push("(i.number LIKE ? OR p.first_name || ' ' || p.last_name LIKE ? OR p.code LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const from = optStr(req.query.from);
  const to = optStr(req.query.to);
  if (from) {
    where.push('i.issue_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('i.issue_date <= ?');
    params.push(to);
  }
  const kind = optStr(req.query.kind);
  if (kind) {
    where.push('i.kind = ?');
    params.push(kind);
  }
  const status = optStr(req.query.status);
  if (status === 'void') where.push("i.status = 'void'");
  else if (status === 'outstanding') where.push(`i.status = 'issued' AND (${INVOICE_BALANCE_SQL}) > 0`);
  else if (status === 'paid') where.push(`i.status = 'issued' AND (${INVOICE_BALANCE_SQL}) <= 0`);
  else if (status === 'unpaid') where.push(`i.status = 'issued' AND (${PAID_SQL}) = 0 AND i.total > 0`);
  else if (status === 'partially_paid') where.push(`i.status = 'issued' AND (${PAID_SQL}) > 0 AND (${INVOICE_BALANCE_SQL}) > 0`);
  const patientId = Number(req.query.patientId) || null;
  if (patientId) {
    where.push('i.patient_id = ?');
    params.push(patientId);
  }
  const whereSql = where.join(' AND ');
  const total = scalar<number>(`SELECT COUNT(*) FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${whereSql}`, params);
  const sums = get<{ total: number; balance: number }>(
    `SELECT COALESCE(SUM(CASE WHEN i.status = 'issued' THEN i.total END), 0) AS total, COALESCE(SUM(CASE WHEN i.status = 'issued' THEN ${INVOICE_BALANCE_SQL} END), 0) AS balance
       FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${whereSql}`,
    params,
  );
  const rows = all<Row>(
    `SELECT i.*, p.first_name, p.last_name, p.code AS patient_code, (${INVOICE_BALANCE_SQL}) AS balance, (${PAID_SQL}) AS net_paid
       FROM invoices i JOIN patients p ON p.id = i.patient_id WHERE ${whereSql} ORDER BY i.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  res.json({
    items: rows.map((r) => ({ ...camel(r), patientName: `${r.first_name} ${r.last_name}`, balance: r.status === 'void' ? 0 : r.balance })),
    total,
    page,
    pageSize,
    sums,
  });
});

function installmentsWithStatus(invoiceId: number, netPaid: number) {
  const today = clinicToday();
  let remainingPaid = netPaid;
  return all<{ id: number; seq: number; due_date: string; amount: number }>('SELECT * FROM invoice_installments WHERE invoice_id = ? ORDER BY seq', [invoiceId]).map((i) => {
    const paid = Math.min(i.amount, Math.max(0, remainingPaid));
    remainingPaid -= paid;
    const status = paid >= i.amount ? 'paid' : i.due_date < today ? 'overdue' : paid > 0 ? 'partially_paid' : 'due';
    return { id: i.id, seq: i.seq, dueDate: i.due_date, amount: i.amount, paid, status };
  });
}

billingRouter.get('/invoices/:id', requirePerm('billing.view'), (req, res) => {
  const id = intParam(req.params.id);
  const inv = get<Row>(
    `SELECT i.*, p.first_name, p.last_name, p.code AS patient_code, p.phone, p.email, p.address, u.name AS created_by_name, uv.name AS voided_by_name
       FROM invoices i JOIN patients p ON p.id = i.patient_id LEFT JOIN users u ON u.id = i.created_by LEFT JOIN users uv ON uv.id = i.voided_by WHERE i.id = ?`,
    [id],
  );
  if (!inv) throw notFound('Invoice');
  assertPatientAccess(req, inv.patient_id as number);
  const bal = invoiceBalance(id);
  const payments = all<Row>(
    `SELECT pm.*, u.name AS received_by_name, COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id = pm.id), 0) AS refunded
       FROM payments pm LEFT JOIN users u ON u.id = pm.received_by WHERE pm.invoice_id = ? ORDER BY pm.id`,
    [id],
  ).map((r) => camel(r));
  const refunds = all<Row>(
    'SELECT r.*, p.number AS payment_number, u.name AS created_by_name FROM refunds r JOIN payments p ON p.id = r.payment_id LEFT JOIN users u ON u.id = r.created_by WHERE r.invoice_id = ? ORDER BY r.id',
    [id],
  ).map((r) => camel(r));
  const adjustments = all<Row>(
    'SELECT a.*, u.name AS created_by_name FROM invoice_adjustments a LEFT JOIN users u ON u.id = a.created_by WHERE a.invoice_id = ? ORDER BY a.id',
    [id],
  ).map((r) => camel(r));
  const pkg = get<Row>('SELECT id, name_en, name_ar FROM purchased_packages WHERE invoice_id = ?', [id]);
  const appt = inv.appointment_id ? get<Row>('SELECT id, start_at, status, service_id FROM appointments WHERE id = ?', [inv.appointment_id]) : null;
  res.json({
    invoice: { ...camel(inv), patientName: `${inv.first_name} ${inv.last_name}` },
    items: all<Row>('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [id]).map((r) => camel(r)),
    balance: bal,
    payments,
    refunds,
    adjustments,
    installments: installmentsWithStatus(id, bal.netPaid),
    package: pkg ? camel(pkg) : null,
    appointment: appt ? camel(appt) : null,
  });
});

billingRouter.post('/invoices', requirePerm('payments.record'), (req, res) => {
  const d = validate(invoiceSchema, req.body);
  const user = assertPatientAccess(req, d.patientId);
  const id = createInvoice(user, { patientId: d.patientId, kind: d.appointmentId ? 'service' : 'custom', appointmentId: d.appointmentId, lines: d.lines, discountReason: d.discountReason, notes: d.notes, idempotencyKey: d.idempotencyKey });
  res.status(201).json({ id });
});

billingRouter.post('/invoices/:id/payments', requirePerm('payments.record'), (req, res) => {
  const id = intParam(req.params.id);
  const inv = get<{ patient_id: number }>('SELECT patient_id FROM invoices WHERE id = ?', [id]);
  if (!inv) throw notFound('Invoice');
  const user = assertPatientAccess(req, inv.patient_id);
  const d = validate(paymentSchema, req.body);
  const r = recordPayment(user, id, d);
  res.status(r.duplicate ? 200 : 201).json(r);
});

billingRouter.get('/payments', requirePerm('billing.view'), (req, res) => {
  const tz = getSettings().timezone;
  const { page, pageSize, offset } = pageParams(req.query);
  const scope = patientScopeSql(req.user!);
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  const from = optStr(req.query.from);
  const to = optStr(req.query.to) ?? from;
  if (from && to) {
    const b = rangeBoundsUtc(from, to, tz);
    where.push('pm.received_at >= ? AND pm.received_at < ?');
    params.push(b.start, b.end);
  }
  const method = optStr(req.query.method);
  if (method) {
    where.push('pm.method = ?');
    params.push(method);
  }
  const q = optStr(req.query.q);
  if (q) {
    where.push("(pm.number LIKE ? OR i.number LIKE ? OR p.first_name || ' ' || p.last_name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const whereSql = where.join(' AND ');
  const base = 'FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN patients p ON p.id = pm.patient_id';
  const total = scalar<number>(`SELECT COUNT(*) ${base} WHERE ${whereSql}`, params);
  const sum = scalar<number>(`SELECT COALESCE(SUM(pm.amount), 0) ${base} WHERE ${whereSql}`, params);
  const rows = all<Row>(
    `SELECT pm.*, i.number AS invoice_number, p.first_name, p.last_name, u.name AS received_by_name,
            COALESCE((SELECT SUM(amount) FROM refunds WHERE payment_id = pm.id), 0) AS refunded
       ${base} LEFT JOIN users u ON u.id = pm.received_by WHERE ${whereSql} ORDER BY pm.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  res.json({ items: rows.map((r) => ({ ...camel(r), patientName: `${r.first_name} ${r.last_name}` })), total, page, pageSize, sum });
});

billingRouter.get('/payments/:id', requirePerm('billing.view'), (req, res) => {
  const id = intParam(req.params.id);
  const p = get<Row>(
    `SELECT pm.*, i.number AS invoice_number, i.total AS invoice_total, p.first_name, p.last_name, p.code AS patient_code, p.phone, u.name AS received_by_name
       FROM payments pm JOIN invoices i ON i.id = pm.invoice_id JOIN patients p ON p.id = pm.patient_id LEFT JOIN users u ON u.id = pm.received_by WHERE pm.id = ?`,
    [id],
  );
  if (!p) throw notFound('Payment');
  assertPatientAccess(req, p.patient_id as number);
  res.json({
    payment: { ...camel(p), patientName: `${p.first_name} ${p.last_name}`, refundable: refundable(id) },
    balanceAfter: invoiceBalance(p.invoice_id as number).balance,
    refunds: all<Row>('SELECT * FROM refunds WHERE payment_id = ? ORDER BY id', [id]).map((r) => camel(r)),
  });
});

billingRouter.post('/payments/:id/refunds', requirePerm('refunds.issue'), (req, res) => {
  const id = intParam(req.params.id);
  const p = get<{ patient_id: number }>('SELECT patient_id FROM payments WHERE id = ?', [id]);
  if (!p) throw notFound('Payment');
  const user = assertPatientAccess(req, p.patient_id);
  const r = issueRefund(user, id, validate(refundSchema, req.body));
  res.status(r.duplicate ? 200 : 201).json(r);
});

billingRouter.post('/invoices/:id/adjustments', requirePerm('invoices.adjust'), (req, res) => {
  const id = intParam(req.params.id);
  const inv = get<{ patient_id: number }>('SELECT patient_id FROM invoices WHERE id = ?', [id]);
  if (!inv) throw notFound('Invoice');
  const user = assertPatientAccess(req, inv.patient_id);
  const d = validate(adjustmentSchema, req.body);
  if (d.amount < 0) assertPerm(req, 'discounts.apply');
  addAdjustment(user, id, d.amount, d.reason);
  res.json({ ok: true });
});

billingRouter.post('/invoices/:id/void', requirePerm('invoices.adjust'), (req, res) => {
  const id = intParam(req.params.id);
  const inv = get<{ patient_id: number }>('SELECT patient_id FROM invoices WHERE id = ?', [id]);
  if (!inv) throw notFound('Invoice');
  const user = assertPatientAccess(req, inv.patient_id);
  voidInvoice(user, id, validate(voidSchema, req.body).reason);
  res.json({ ok: true });
});

// ---- Expenses ---------------------------------------------------------------

billingRouter.get('/expenses', requirePerm('expenses.manage'), (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query);
  const where = ['1=1'];
  const params: unknown[] = [];
  const from = optStr(req.query.from);
  const to = optStr(req.query.to);
  if (from) {
    where.push('e.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('e.date <= ?');
    params.push(to);
  }
  const category = optStr(req.query.category);
  if (category) {
    where.push('e.category = ?');
    params.push(category);
  }
  const whereSql = where.join(' AND ');
  const total = scalar<number>(`SELECT COUNT(*) FROM expenses e WHERE ${whereSql}`, params);
  const sum = scalar<number>(`SELECT COALESCE(SUM(amount), 0) FROM expenses e WHERE ${whereSql} AND e.voided_at IS NULL`, params);
  const rows = all<Row>(
    `SELECT e.*, u.name AS created_by_name FROM expenses e LEFT JOIN users u ON u.id = e.created_by WHERE ${whereSql} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  res.json({ items: rows.map((r) => camel(r)), total, page, pageSize, sum });
});

billingRouter.post('/expenses', requirePerm('expenses.manage'), (req, res) => {
  const d = validate(expenseSchema, req.body);
  const user = req.user!;
  const id = tx(() => {
    const existing = scalar<number | null>('SELECT id FROM expenses WHERE idempotency_key = ?', [d.idempotencyKey]);
    if (existing) return existing;
    const r = run('INSERT INTO expenses(date, category, description, vendor, amount, method, created_by, created_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)', [
      d.date,
      d.category,
      d.description,
      d.vendor,
      d.amount,
      d.method,
      user.id,
      nowIso(),
      d.idempotencyKey,
    ]);
    audit(user, 'expense.create', { entityType: 'expense', entityId: r.id, summary: `Expense recorded (${d.category})`, meta: { amount: d.amount } });
    return r.id;
  });
  res.status(201).json({ id });
});

billingRouter.post('/expenses/:id/void', requirePerm('expenses.manage'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(voidSchema, req.body);
  const r = run('UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL', [nowIso(), req.user!.id, d.reason, id]);
  if (r.changes) audit(req.user, 'expense.void', { entityType: 'expense', entityId: id, summary: 'Expense voided', meta: { reason: d.reason } });
  res.json({ ok: true });
});
