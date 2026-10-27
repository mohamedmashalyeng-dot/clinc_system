import { Router } from 'express';
import { all, camel, get, scalar } from '../db/db.js';
import { assertPerm, can, patientScopeSql, requirePerm } from '../auth.js';
import { badRequest, optInt, optStr } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { addDays, diffDays, isValidDateString, rangeBoundsUtc, zonedParts } from '../../shared/time.js';
import { INVOICE_BALANCE_SQL } from '../services/finance.js';
import { packageSummary } from '../services/packages.js';
import { inventoryAlerts } from '../services/inventory.js';
import { mapAppointment } from './appointments.js';
import { attachNoShowRisk } from '../services/insights.js';

export const reportsRouter = Router();
type Row = Record<string, unknown>;

function range(q: Record<string, unknown>) {
  const today = clinicToday();
  const from = typeof q.from === 'string' && isValidDateString(q.from) ? q.from : today;
  const to = typeof q.to === 'string' && isValidDateString(q.to) ? q.to : from;
  if (to < from) throw badRequest('INVALID_RANGE', 'The end date is before the start date.');
  if (diffDays(from, to) > 731) throw badRequest('RANGE_TOO_LONG', 'Choose a range of two years or less.');
  return { from, to, today, ...rangeBoundsUtc(from, to, getSettings().timezone) };
}

function expiringPackages(scopeSql: string, scopeParams: unknown[], fromDate: string, limitDate: string, today: string) {
  return all<{ id: number }>(
    `SELECT pp.id FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id
      WHERE ${scopeSql} AND pp.status = 'active' AND pp.expiry_date >= ? AND pp.expiry_date <= ?`,
    [...scopeParams, fromDate, limitDate],
  )
    .map((r) => packageSummary(r.id, today)!)
    .filter((p) => p.remainingSessions > 0);
}

reportsRouter.get('/dashboard', requirePerm('dashboard.view'), (req, res) => {
  const r = range(req.query);
  const settings = getSettings();
  const user = req.user!;
  const practitionerFilter = optInt(req.query.practitionerId);
  const apptWhere = practitionerFilter ? 'AND a.practitioner_id = ?' : '';
  const apptParams = practitionerFilter ? [practitionerFilter] : [];
  const counts = Object.fromEntries(
    all<{ status: string; n: number }>(
      `SELECT a.status, COUNT(*) AS n FROM appointments a WHERE a.start_at >= ? AND a.start_at < ? ${apptWhere} GROUP BY a.status`,
      [r.start, r.end, ...apptParams],
    ).map((x) => [x.status, x.n]),
  ) as Record<string, number>;
  const scheduled = ['booked', 'confirmed', 'arrived', 'in_treatment', 'completed'].reduce((s, k) => s + (counts[k] ?? 0), 0);
  const completedSessions = scalar<number>(
    `SELECT COUNT(*) FROM treatment_sessions t WHERE t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ? ${practitionerFilter ? 'AND t.practitioner_id = ?' : ''}`,
    [r.start, r.end, ...apptParams],
  );
  const scope = patientScopeSql(user);
  const metrics: Record<string, unknown> = {
    appointments: scheduled,
    cancelled: counts.cancelled ?? 0,
    noShows: counts.no_show ?? 0,
    waiting: counts.arrived ?? 0,
    inTreatment: counts.in_treatment ?? 0,
    completedSessions,
  };
  if (can(req, 'billing.view')) {
    metrics.paymentsCollected = scalar<number>('SELECT COALESCE(SUM(amount), 0) FROM payments WHERE received_at >= ? AND received_at < ?', [r.start, r.end]);
    metrics.refunds = scalar<number>('SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE created_at >= ? AND created_at < ?', [r.start, r.end]);
    const out = get<{ total: number; n: number }>(
      `SELECT COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) AS total, COUNT(*) AS n FROM invoices i
        WHERE i.status = 'issued' AND i.issue_date >= ? AND i.issue_date <= ? AND (${INVOICE_BALANCE_SQL}) > 0`,
      [r.from, r.to],
    );
    metrics.outstandingInRange = out?.total ?? 0;
    metrics.outstandingInvoices = out?.n ?? 0;
    metrics.outstandingAll = scalar<number>(`SELECT COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) FROM invoices i WHERE i.status = 'issued'`);
  }
  if (can(req, 'packages.view')) {
    metrics.packagesExpiring = expiringPackages(scope.sql, scope.params, r.from, addDays(r.to, settings.packageExpiryWarningDays), r.today).length;
    metrics.packageWindowEnd = addDays(r.to, settings.packageExpiryWarningDays);
  }
  if (can(req, 'inventory.view')) {
    const alerts = inventoryAlerts(r.today, settings.expiryWarningDays);
    metrics.lowStock = alerts.lowStock.length;
    metrics.expiringBatches = alerts.expiringBatches.length;
  }
  const scheduleDate = optStr(req.query.date) && isValidDateString(String(req.query.date)) ? String(req.query.date) : r.from;
  const sb = rangeBoundsUtc(scheduleDate, scheduleDate, settings.timezone);
  const schedule = can(req, 'appointments.view')
    ? all<Row>(
        `SELECT a.*, p.first_name, p.last_name, p.phone, p.code AS patient_code, p.primary_practitioner_id, s.deposit_amount, pp.name_en AS package_en, pp.name_ar AS package_ar,
                (SELECT t.id FROM treatment_sessions t WHERE t.appointment_id = a.id AND t.status <> 'reversed') AS session_id,
                (SELECT t.status FROM treatment_sessions t WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1) AS session_status
           FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id LEFT JOIN purchased_packages pp ON pp.id = a.purchased_package_id
          WHERE a.start_at >= ? AND a.start_at < ? ${apptWhere} ORDER BY a.start_at`,
        [sb.start, sb.end, ...apptParams],
      ).map((row) => mapAppointment(req, row))
    : [];
  if (can(req, 'packages.view') && can(req, 'followup.view')) {
    // Prepaid sessions waiting with nothing booked: the first list in the growth centre.
    metrics.unbookedPackages = scalar<number>(
      `SELECT COUNT(*) FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id
        WHERE ${scope.sql} AND pp.status = 'active' AND pp.expiry_date >= ?
          AND (SELECT SUM(quantity) FROM purchased_package_items WHERE purchased_package_id = pp.id)
              + COALESCE((SELECT SUM(delta) FROM package_usage WHERE purchased_package_id = pp.id), 0) > 0
          AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.patient_id = p.id AND x.status IN ('booked','confirmed','arrived','in_treatment') AND x.start_at >= ?)`,
      [...scope.params, r.today, rangeBoundsUtc(r.today, r.today, settings.timezone).start],
    );
  }
  res.json({ range: { from: r.from, to: r.to }, scheduleDate, metrics, schedule: attachNoShowRisk(schedule) });
});

reportsRouter.get('/reports', (req, res) => {
  const fin = can(req, 'reports.financial');
  const ops = can(req, 'reports.operational');
  if (!fin && !ops) assertPerm(req, 'reports.operational');
  const r = range(req.query);
  const out: Record<string, unknown> = { range: { from: r.from, to: r.to } };

  if (fin) {
    const byMethod = all<{ method: string; total: number; n: number }>(
      'SELECT method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM payments WHERE received_at >= ? AND received_at < ? GROUP BY method',
      [r.start, r.end],
    );
    const collected = byMethod.reduce((s, x) => s + x.total, 0);
    const byKind = all<{ kind: string; total: number }>(
      'SELECT i.kind, COALESCE(SUM(pm.amount), 0) AS total FROM payments pm JOIN invoices i ON i.id = pm.invoice_id WHERE pm.received_at >= ? AND pm.received_at < ? GROUP BY i.kind',
      [r.start, r.end],
    );
    const refunds = get<{ total: number; n: number }>('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM refunds WHERE created_at >= ? AND created_at < ?', [r.start, r.end])!;
    const expenses = all<{ category: string; total: number; n: number }>(
      'SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM expenses WHERE voided_at IS NULL AND date >= ? AND date <= ? GROUP BY category ORDER BY total DESC',
      [r.from, r.to],
    );
    const expensesTotal = expenses.reduce((s, x) => s + x.total, 0);
    const invoiced = all<{ kind: string; total: number; n: number; discounts: number }>(
      "SELECT kind, COALESCE(SUM(total), 0) AS total, COUNT(*) AS n, COALESCE(SUM(discount_total), 0) AS discounts FROM invoices WHERE status = 'issued' AND issue_date >= ? AND issue_date <= ? GROUP BY kind",
      [r.from, r.to],
    );
    const aging = all<{ bucket: string; total: number; n: number }>(
      `SELECT CASE WHEN julianday(?) - julianday(i.issue_date) <= 30 THEN '0_30' WHEN julianday(?) - julianday(i.issue_date) <= 60 THEN '31_60'
                   WHEN julianday(?) - julianday(i.issue_date) <= 90 THEN '61_90' ELSE '90_plus' END AS bucket,
              COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) AS total, COUNT(*) AS n
         FROM invoices i WHERE i.status = 'issued' AND (${INVOICE_BALANCE_SQL}) > 0 GROUP BY bucket`,
      [r.today, r.today, r.today],
    );
    const packageSales = get<{ n: number; gross: number; discounts: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS gross, COALESCE(SUM(discount), 0) AS discounts FROM purchased_packages WHERE purchase_date >= ? AND purchase_date <= ?',
      [r.from, r.to],
    )!;
    out.financial = {
      collected,
      collectedByMethod: byMethod,
      collectedByKind: byKind,
      refunds,
      netCollected: collected - refunds.total,
      expenses: { total: expensesTotal, byCategory: expenses },
      netAfterExpenses: collected - refunds.total - expensesTotal,
      invoiced,
      outstanding: { total: aging.reduce((s, x) => s + x.total, 0), aging },
      packageSales: { ...packageSales, net: packageSales.gross - packageSales.discounts, collected: byKind.find((k) => k.kind === 'package')?.total ?? 0 },
    };
  }

  if (ops) {
    const byStatus = Object.fromEntries(
      all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM appointments WHERE start_at >= ? AND start_at < ? GROUP BY status', [r.start, r.end]).map((x) => [x.status, x.n]),
    ) as Record<string, number>;
    const totalAppts = Object.values(byStatus).reduce((s, n) => s + n, 0);
    const created = scalar<number>('SELECT COUNT(*) FROM appointments WHERE created_at >= ? AND created_at < ?', [r.start, r.end]);
    const sessionsByService = all<Row>(
      `SELECT t.service_id, COUNT(*) AS sessions, SUM(CASE WHEN t.purchased_package_id IS NOT NULL THEN 1 ELSE 0 END) AS package_sessions
         FROM treatment_sessions t WHERE t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ? GROUP BY t.service_id ORDER BY sessions DESC`,
      [r.start, r.end],
    ).map((x) => camel(x));
    const sessionsByPractitioner = all<Row>(
      `SELECT t.practitioner_id, COUNT(*) AS sessions, COUNT(DISTINCT t.patient_id) AS patients
         FROM treatment_sessions t WHERE t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ? GROUP BY t.practitioner_id ORDER BY sessions DESC`,
      [r.start, r.end],
    ).map((x) => camel(x));
    const packageUsage = all<Row>(
      `SELECT pp.template_id, pp.name_en, pp.name_ar,
              SUM(CASE WHEN u.kind = 'consume' THEN 1 ELSE 0 END) AS redeemed,
              SUM(CASE WHEN u.kind = 'reversal' THEN 1 ELSE 0 END) AS reversed,
              SUM(CASE WHEN u.kind = 'adjustment' THEN u.delta ELSE 0 END) AS adjusted
         FROM package_usage u JOIN purchased_packages pp ON pp.id = u.purchased_package_id
        WHERE u.created_at >= ? AND u.created_at < ? GROUP BY pp.template_id ORDER BY redeemed DESC`,
      [r.start, r.end],
    ).map((x) => camel(x));
    const consumption = all<Row>(
      `SELECT i.id AS item_id, i.name, i.unit, i.sku,
              -SUM(CASE WHEN m.type = 'usage' THEN m.quantity ELSE 0 END) AS used,
              -SUM(CASE WHEN m.type = 'waste' THEN m.quantity ELSE 0 END) AS wasted,
              SUM(CASE WHEN m.type = 'purchase' THEN m.quantity ELSE 0 END) AS received,
              -SUM(CASE WHEN m.type IN ('usage','waste') THEN m.quantity * b.unit_cost ELSE 0 END) AS cost
         FROM stock_movements m JOIN inventory_items i ON i.id = m.item_id JOIN inventory_batches b ON b.id = m.batch_id
        WHERE m.created_at >= ? AND m.created_at < ? GROUP BY i.id HAVING used <> 0 OR wasted <> 0 OR received <> 0 ORDER BY used DESC`,
      [r.start, r.end],
    ).map((x) => ({ ...camel(x), cost: fin ? Math.round(Number(x.cost)) : null }));
    out.operational = {
      appointments: {
        total: totalAppts,
        created,
        byStatus,
        cancellationRate: totalAppts ? (byStatus.cancelled ?? 0) / totalAppts : 0,
        noShowRate: totalAppts ? (byStatus.no_show ?? 0) / totalAppts : 0,
      },
      sessionsByService,
      sessionsByPractitioner,
      packageUsage,
      consumption,
    };
  }

  // Marketing attribution: patients registered in the range, grouped by how they found the clinic.
  // Revenue is everything collected from those patients to date (payments − refunds).
  const netPaid = 'COALESCE((SELECT SUM(amount) FROM payments WHERE patient_id = p.id), 0) - COALESCE((SELECT SUM(amount) FROM refunds WHERE patient_id = p.id), 0)';
  const converted = "CASE WHEN EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') THEN 1 ELSE 0 END";
  const bySource = all<Row>(
    `SELECT COALESCE(p.source, 'unknown') AS source, COUNT(*) AS new_patients, SUM(${converted}) AS converted, COALESCE(SUM(${netPaid}), 0) AS revenue
       FROM patients p WHERE p.created_at >= ? AND p.created_at < ? GROUP BY COALESCE(p.source, 'unknown') ORDER BY new_patients DESC`,
    [r.start, r.end],
  ).map((x) => ({ source: x.source as string, newPatients: Number(x.new_patients), converted: Number(x.converted), revenue: fin ? Number(x.revenue) : null }));
  const newPatients = bySource.reduce((s, x) => s + x.newPatients, 0);
  const marketingSpend = fin
    ? scalar<number>("SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE voided_at IS NULL AND category = 'marketing' AND date >= ? AND date <= ?", [r.from, r.to])
    : null;
  out.marketing = {
    bySource,
    newPatients,
    converted: bySource.reduce((s, x) => s + x.converted, 0),
    revenue: fin ? bySource.reduce((s, x) => s + (x.revenue ?? 0), 0) : null,
    marketingSpend,
    costPerNewPatient: marketingSpend !== null && newPatients ? Math.round(marketingSpend / newPatients) : null,
    // Referrer names are patient identities: only for users who may see every patient.
    topReferrers: can(req, 'patients.view_all')
      ? all<Row>(
          `SELECT ref.id, ref.first_name, ref.last_name, ref.code, COUNT(*) AS referred, SUM(${converted}) AS converted, COALESCE(SUM(${netPaid}), 0) AS revenue
             FROM patients p JOIN patients ref ON ref.id = p.referred_by_patient_id
            WHERE p.created_at >= ? AND p.created_at < ? GROUP BY ref.id ORDER BY referred DESC, revenue DESC LIMIT 10`,
          [r.start, r.end],
        ).map((x) => ({ patientId: x.id as number, name: `${x.first_name} ${x.last_name}`, code: x.code as string, referred: Number(x.referred), converted: Number(x.converted), revenue: fin ? Number(x.revenue) : null }))
      : null,
  };
  res.json(out);
});

reportsRouter.get('/notifications', (req, res) => {
  const settings = getSettings();
  const today = clinicToday();
  const items: { key: string; kind: string; severity: 'high' | 'medium' | 'low'; params: Record<string, unknown>; link: string }[] = [];
  if (can(req, 'appointments.view')) {
    const b = rangeBoundsUtc(today, today, settings.timezone);
    const waiting = all<{ id: number; arrived_at: string }>(
      "SELECT id, arrived_at FROM appointments WHERE status = 'arrived' AND start_at >= ? AND start_at < ? AND arrived_at < ?",
      [b.start, b.end, new Date(Date.now() - 15 * 60000).toISOString()],
    );
    if (waiting.length) items.push({ key: 'waiting', kind: 'waiting_long', severity: 'medium', params: { count: waiting.length }, link: '/appointments?view=queue' });
  }
  if (can(req, 'followup.view')) {
    const scope = patientScopeSql(req.user!);
    const due = scalar<number>(`SELECT COUNT(*) FROM follow_ups f JOIN patients p ON p.id = f.patient_id WHERE ${scope.sql} AND f.status = 'open' AND f.due_date <= ?`, [...scope.params, today]);
    if (due) items.push({ key: 'followups', kind: 'followups_due', severity: 'medium', params: { count: due }, link: '/follow-up' });
  }
  if (can(req, 'inventory.view')) {
    const alerts = inventoryAlerts(today, settings.expiryWarningDays);
    if (alerts.lowStock.length) items.push({ key: 'low', kind: 'low_stock', severity: 'high', params: { count: alerts.lowStock.length }, link: '/inventory?filter=low' });
    const expired = alerts.expiringBatches.filter((b) => b.expired).length;
    if (expired) items.push({ key: 'expired', kind: 'expired_batches', severity: 'high', params: { count: expired }, link: '/inventory?filter=expiring' });
    const soon = alerts.expiringBatches.length - expired;
    if (soon) items.push({ key: 'expiring', kind: 'expiring_batches', severity: 'low', params: { count: soon, days: settings.expiryWarningDays }, link: '/inventory?filter=expiring' });
  }
  if (can(req, 'packages.view')) {
    const scope = patientScopeSql(req.user!);
    const n = expiringPackages(scope.sql, scope.params, today, addDays(today, settings.packageExpiryWarningDays), today).length;
    if (n) items.push({ key: 'packages', kind: 'packages_expiring', severity: 'low', params: { count: n, days: settings.packageExpiryWarningDays }, link: '/follow-up?tab=packages' });
  }
  if (can(req, 'billing.view')) {
    const pending = scalar<number>(
      `SELECT COUNT(*) FROM invoices i JOIN appointments a ON a.id = i.appointment_id
        WHERE i.status = 'issued' AND a.status IN ('cancelled','no_show') AND (${INVOICE_BALANCE_SQL}) > 0`,
    );
    if (pending) items.push({ key: 'deposits', kind: 'deposits_pending', severity: 'medium', params: { count: pending }, link: '/billing?status=outstanding' });
    const overdue = scalar<number>(
      `SELECT COUNT(DISTINCT ii.invoice_id) FROM invoice_installments ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.status = 'issued' AND ii.due_date < ? AND (${INVOICE_BALANCE_SQL}) > 0
          AND (SELECT COALESCE(SUM(x.amount), 0) FROM invoice_installments x WHERE x.invoice_id = ii.invoice_id AND x.seq <= ii.seq)
              > COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0)`,
      [today],
    );
    if (overdue) items.push({ key: 'installments', kind: 'installments_overdue', severity: 'high', params: { count: overdue }, link: '/billing?status=outstanding' });
  }
  if (can(req, 'payments.record')) {
    // Recent days that took payments but whose cash drawer was never counted.
    const from = addDays(today, -7);
    const b = rangeBoundsUtc(from, addDays(today, -1), settings.timezone);
    const paidDays = new Set(all<{ received_at: string }>('SELECT received_at FROM payments WHERE received_at >= ? AND received_at < ?', [b.start, b.end]).map((p) => zonedParts(p.received_at, settings.timezone).date));
    const closed = new Set(all<{ date: string }>('SELECT date FROM day_closings WHERE superseded_by IS NULL AND date >= ?', [from]).map((c) => c.date));
    const open = [...paidDays].filter((d) => !closed.has(d)).length;
    if (open) items.push({ key: 'dayclose', kind: 'days_unclosed', severity: 'medium', params: { count: open }, link: '/billing?tab=close' });
  }
  if (can(req, 'aftercare.approve')) {
    const n = scalar<number>("SELECT COUNT(*) FROM message_templates WHERE kind = 'aftercare' AND approved_by IS NULL AND active = 1");
    if (n) items.push({ key: 'aftercare', kind: 'aftercare_unapproved', severity: 'low', params: { count: n }, link: '/follow-up?tab=templates' });
  }
  res.json({ items });
});
