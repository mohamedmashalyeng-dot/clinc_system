import { Router } from 'express';
import { all, camel, get, nowIso, run, scalar, tx } from '../db/db.js';
import { assertPatientAccess, patientScopeSql, requirePerm } from '../auth.js';
import { audit } from '../audit.js';
import { badRequest, conflict, forbidden, intParam, notFound, optStr, pageParams, validate } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { packageAdjustSchema, sellPackageSchema } from '../../shared/schemas.js';
import { addDays, diffDays, isValidDateString } from '../../shared/time.js';
import { createInvoice, recordPayment } from '../services/finance.js';
import { packageSummary } from '../services/packages.js';

export const packagesRouter = Router();
type Row = Record<string, unknown>;

packagesRouter.get('/', requirePerm('packages.view'), (req, res) => {
  const user = req.user!;
  const today = clinicToday();
  const warn = getSettings().packageExpiryWarningDays;
  const state = optStr(req.query.state);
  const q = optStr(req.query.q);
  const scope = patientScopeSql(user);
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (q) {
    where.push("(p.first_name || ' ' || p.last_name LIKE ? OR p.code LIKE ? OR pp.name_en LIKE ? OR pp.name_ar LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all<Row>(
    `SELECT pp.id, p.first_name, p.last_name, p.code, p.phone FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id
      WHERE ${where.join(' AND ')} ORDER BY pp.expiry_date`,
    params,
  );
  const until = optStr(req.query.until);
  let items = rows.map((r) => ({ ...packageSummary(r.id as number, today)!, patientName: `${r.first_name} ${r.last_name}`, patientCode: r.code, patientPhone: r.phone }));
  if (state === 'expiring') {
    const limit = until && isValidDateString(until) ? addDays(until, warn) : addDays(today, warn);
    items = items.filter((p) => p.state === 'active' && p.expiryDate <= limit);
  } else if (state === 'with_balance') {
    items = items.filter((p) => p.state !== 'cancelled' && p.balance > 0);
  } else if (state) {
    items = items.filter((p) => p.state === state);
  }
  const rank = { active: 0, expired: 1, used_up: 2, cancelled: 3 } as const;
  items.sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'active' ? a.expiryDate.localeCompare(b.expiryDate) : b.purchaseDate.localeCompare(a.purchaseDate)));
  const { page, pageSize, offset } = pageParams(req.query);
  res.json({
    items: items.slice(offset, offset + pageSize).map((p) => ({ ...p, daysToExpiry: diffDays(today, p.expiryDate) })),
    total: items.length,
    page,
    pageSize,
  });
});

packagesRouter.get('/:id', requirePerm('packages.view'), (req, res) => {
  const id = intParam(req.params.id);
  const s = packageSummary(id, clinicToday());
  if (!s) throw notFound('Package');
  assertPatientAccess(req, s.patientId);
  const ledger = all<Row>(
    `SELECT u.*, us.name AS by_name, a.start_at FROM package_usage u LEFT JOIN users us ON us.id = u.created_by LEFT JOIN appointments a ON a.id = u.appointment_id
      WHERE u.purchased_package_id = ? ORDER BY u.id DESC`,
    [id],
  ).map((r) => camel(r));
  res.json({ package: s, ledger });
});

packagesRouter.post('/', requirePerm('packages.sell'), (req, res) => {
  const d = validate(sellPackageSchema, req.body);
  const user = assertPatientAccess(req, d.patientId);
  const result = tx(() => {
    const existing = get<{ id: number; invoice_id: number }>('SELECT id, invoice_id FROM purchased_packages WHERE idempotency_key = ?', [d.idempotencyKey]);
    if (existing) return { id: existing.id, invoiceId: existing.invoice_id, duplicate: true };
    const t = get<Row>('SELECT * FROM package_templates WHERE id = ?', [d.templateId]);
    if (!t) throw notFound('Package template');
    if (!t.active) throw conflict('TEMPLATE_INACTIVE', 'This package is no longer offered.');
    const price = t.price as number;
    if (d.discount > 0 && !user.permissions.has('discounts.apply')) {
      throw forbidden('Applying a discount requires the "discounts.apply" permission.', 'DISCOUNT_NOT_ALLOWED');
    }
    if (d.discount > price) throw badRequest('DISCOUNT_TOO_LARGE', 'The discount cannot exceed the package price.');
    const invoiceId = createInvoice(user, {
      patientId: d.patientId,
      kind: 'package',
      lines: [{ description: `Package: ${t.name_en}`, packageTemplateId: t.id as number, quantity: 1, unitPrice: price, discount: d.discount }],
      discountReason: d.discountReason,
      idempotencyKey: `${d.idempotencyKey}-invoice`,
    });
    const expiry = addDays(d.startDate, t.validity_days as number);
    const now = nowIso();
    const r = run(
      `INSERT INTO purchased_packages(patient_id, template_id, name_en, name_ar, price, discount, purchase_date, start_date, expiry_date, terms_en, terms_ar,
         invoice_id, status, created_by, created_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
      [d.patientId, t.id, t.name_en, t.name_ar, price, d.discount, clinicToday(), d.startDate, expiry, t.terms_en, t.terms_ar, invoiceId, user.id, now, d.idempotencyKey],
    );
    for (const item of all<{ service_id: number; quantity: number }>('SELECT service_id, quantity FROM package_template_items WHERE template_id = ?', [t.id])) {
      run('INSERT INTO purchased_package_items(purchased_package_id, service_id, quantity) VALUES (?,?,?)', [r.id, item.service_id, item.quantity]);
    }
    const total = scalar<number>('SELECT total FROM invoices WHERE id = ?', [invoiceId]);
    if (d.installments > 1) {
      const base = Math.floor(total / d.installments / 100) * 100;
      for (let i = 0; i < d.installments; i++) {
        const amount = i === d.installments - 1 ? total - base * (d.installments - 1) : base;
        run('INSERT INTO invoice_installments(invoice_id, seq, due_date, amount) VALUES (?,?,?,?)', [invoiceId, i + 1, addDays(clinicToday(), 30 * i), amount]);
      }
    }
    if (d.initialPayment && d.initialPayment.amount > 0) {
      recordPayment(user, invoiceId, {
        amount: d.initialPayment.amount,
        method: d.initialPayment.method,
        reference: d.initialPayment.reference,
        kind: 'payment',
        idempotencyKey: `${d.idempotencyKey}-initial`,
      });
    }
    audit(user, 'package.sell', { entityType: 'package', entityId: r.id, patientId: d.patientId, summary: `Package sold: ${t.name_en}`, meta: { price, discount: d.discount } });
    return { id: r.id, invoiceId, duplicate: false };
  });
  res.status(result.duplicate ? 200 : 201).json(result);
});

packagesRouter.post('/:id/adjust', requirePerm('packages.adjust'), (req, res) => {
  const id = intParam(req.params.id);
  const d = validate(packageAdjustSchema, req.body);
  const s = packageSummary(id, clinicToday());
  if (!s) throw notFound('Package');
  const user = assertPatientAccess(req, s.patientId);
  tx(() => {
    if (scalar<number>('SELECT COUNT(*) FROM package_usage WHERE idempotency_key = ?', [d.idempotencyKey])) return;
    const item = packageSummary(id, clinicToday())!.items.find((i) => i.serviceId === d.serviceId);
    if (!item) throw badRequest('SERVICE_NOT_INCLUDED', 'This package does not include that service.');
    if (item.remaining + d.delta < 0) throw conflict('NEGATIVE_BALANCE', 'The adjustment would leave a negative number of sessions.');
    run(
      "INSERT INTO package_usage(purchased_package_id, service_id, delta, kind, reason, created_by, created_at, idempotency_key) VALUES (?,?,?, 'adjustment', ?,?,?,?)",
      [id, d.serviceId, d.delta, d.reason, user.id, nowIso(), d.idempotencyKey],
    );
    audit(user, 'package.adjust', { entityType: 'package', entityId: id, patientId: s.patientId, summary: `Package sessions adjusted by ${d.delta}`, meta: { reason: d.reason } });
  });
  res.json({ ok: true });
});

packagesRouter.post('/:id/extend', requirePerm('packages.adjust'), (req, res) => {
  const id = intParam(req.params.id);
  const newExpiry = optStr(req.body?.expiryDate);
  const reason = optStr(req.body?.reason);
  if (!newExpiry || !isValidDateString(newExpiry)) throw badRequest('VALIDATION_FAILED', 'Choose a valid new expiry date.');
  if (!reason) throw badRequest('REASON_REQUIRED', 'Give a reason for extending the package.');
  const s = packageSummary(id, clinicToday());
  if (!s) throw notFound('Package');
  const user = assertPatientAccess(req, s.patientId);
  if (newExpiry <= s.expiryDate) throw badRequest('EXPIRY_NOT_LATER', 'The new expiry must be later than the current one.');
  run('UPDATE purchased_packages SET expiry_date = ? WHERE id = ?', [newExpiry, id]);
  audit(user, 'package.extend', { entityType: 'package', entityId: id, patientId: s.patientId, summary: `Expiry extended ${s.expiryDate} → ${newExpiry}`, meta: { reason } });
  res.json({ ok: true });
});
