// Growth centre: patients the clinic can help (and earn from) right now, derived from records that
// already exist — prepaid sessions nobody has booked, treatments due again, patients who stopped
// coming, packages about to run out, birthdays, and balances to collect at an upcoming visit.
import { Router } from 'express';
import { all, nowIso } from '../db/db.js';
import { can, patientScopeSql, requirePerm } from '../auth.js';
import { optInt } from '../http.js';
import { clinicToday, getSettings } from '../settings.js';
import { addDays, ageFrom, diffDays, rangeBoundsUtc, zonedParts } from '../../shared/time.js';
import { INVOICE_BALANCE_SQL } from '../services/finance.js';
import { packageSummary } from '../services/packages.js';
import { LAPSED_DAYS, patientStats } from '../services/insights.js';

export const growthRouter = Router();
type Row = Record<string, unknown>;

const LIMIT = 100;
/** Rebooking: look this far ahead for treatments falling due, and this far back for overdue ones. */
const DUE_AHEAD_DAYS = 7;
const DUE_BACK_DAYS = 60;
const BIRTHDAY_DAYS = 7;
/** A service needs this many observed repeat gaps before the clinic's typical interval is trusted. */
const MIN_GAPS = 3;

const CONTACT_COLS = `p.id AS patient_id, p.first_name, p.last_name, p.phone, p.contact_channel, p.allow_reminders, p.allow_marketing, p.preferred_language,
  (SELECT MAX(c.created_at) FROM communications c WHERE c.patient_id = p.id) AS last_contact_at`;
const NOTHING_BOOKED = `NOT EXISTS (SELECT 1 FROM appointments x WHERE x.patient_id = p.id AND x.status IN ('booked','confirmed','arrived','in_treatment') AND x.start_at >= ?)`;

function contact(r: Row) {
  return {
    patientId: r.patient_id as number,
    patientName: `${r.first_name} ${r.last_name}`,
    phone: r.phone as string,
    contactChannel: r.contact_channel as string,
    allowReminders: !!r.allow_reminders,
    allowMarketing: !!r.allow_marketing,
    preferredLanguage: r.preferred_language as string,
    lastContactAt: (r.last_contact_at as string) ?? null,
  };
}

/**
 * Typical days between repeat sessions of each service, learned from this clinic's own history
 * (median of gaps between 7 and 180 days). Services without enough repeats are treated as one-off.
 */
export function typicalIntervals(since: string): Map<number, number> {
  const rows = all<{ patient_id: number; service_id: number; completed_at: string }>(
    "SELECT patient_id, service_id, completed_at FROM treatment_sessions WHERE status = 'completed' AND completed_at >= ? ORDER BY patient_id, service_id, completed_at",
    [since],
  );
  const gaps = new Map<number, number[]>();
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.patient_id !== b.patient_id || a.service_id !== b.service_id) continue;
    const days = Math.round((new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()) / 86400000);
    if (days >= 7 && days <= 180) gaps.set(b.service_id, [...(gaps.get(b.service_id) ?? []), days]);
  }
  const out = new Map<number, number>();
  for (const [serviceId, list] of gaps) {
    if (list.length < MIN_GAPS) continue;
    const sorted = list.sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    out.set(serviceId, sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2));
  }
  return out;
}

growthRouter.get('/', requirePerm('followup.view'), (req, res) => {
  const user = req.user!;
  const settings = getSettings();
  const tz = settings.timezone;
  const today = clinicToday();
  const todayStart = rangeBoundsUtc(today, today, tz).start;
  const scope = patientScopeSql(user);
  const showPackages = can(req, 'packages.view');
  const showMoney = can(req, 'billing.view');
  const lapsedDays = Math.min(365, Math.max(30, optInt(req.query.lapsedDays) ?? LAPSED_DAYS));
  const localDate = (iso: string) => zonedParts(iso, tz).date;

  // ---- Prepaid sessions with nothing booked -------------------------------------------------
  const unbooked = showPackages
    ? all<Row>(
        `SELECT pp.id, ${CONTACT_COLS},
                (SELECT MAX(a.start_at) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS last_visit
           FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id
          WHERE ${scope.sql} AND pp.status = 'active' AND pp.expiry_date >= ? AND ${NOTHING_BOOKED}`,
        [...scope.params, today, todayStart],
      )
        .map((r) => ({ r, s: packageSummary(r.id as number, today)! }))
        .filter((x) => x.s.remainingSessions > 0)
        .map(({ r, s }) => ({
          ...contact(r),
          packageId: s.id,
          nameEn: s.nameEn,
          nameAr: s.nameAr,
          remaining: s.remainingSessions,
          total: s.totalSessions,
          expiryDate: s.expiryDate,
          daysToExpiry: diffDays(today, s.expiryDate),
          serviceId: s.items.find((i) => i.remaining > 0)?.serviceId ?? null,
          value: s.totalSessions ? Math.round(((s.price - s.discount) * s.remainingSessions) / s.totalSessions) : 0,
          lastVisit: (r.last_visit as string) ?? null,
        }))
        .sort((a, b) => a.daysToExpiry - b.daysToExpiry)
    : null;

  // Prepaid value still owed to patients across every active package (a liability until delivered).
  let prepaidOutstanding: { sessions: number; value: number } | null = null;
  if (showPackages) {
    prepaidOutstanding = { sessions: 0, value: 0 };
    for (const r of all<{ id: number }>(
      `SELECT pp.id FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id WHERE ${scope.sql} AND pp.status = 'active' AND pp.expiry_date >= ?`,
      [...scope.params, today],
    )) {
      const s = packageSummary(r.id, today)!;
      if (s.remainingSessions <= 0 || !s.totalSessions) continue;
      prepaidOutstanding.sessions += s.remainingSessions;
      prepaidOutstanding.value += Math.round(((s.price - s.discount) * s.remainingSessions) / s.totalSessions);
    }
  }

  // ---- Treatments due again ------------------------------------------------------------------
  const intervals = typicalIntervals(new Date(Date.now() - 730 * 86400000).toISOString());
  const plans = new Map<string, { interval: number; open: boolean }>();
  for (const p of all<Row>(
    `SELECT tp.patient_id, tp.service_id, tp.interval_weeks, tp.planned_sessions, tp.status,
            (SELECT COUNT(*) FROM treatment_sessions ts WHERE ts.treatment_plan_id = tp.id AND ts.status = 'completed') AS done
       FROM treatment_plans tp WHERE tp.service_id IS NOT NULL ORDER BY tp.updated_at`,
  )) {
    // Later plans for the same service replace earlier ones.
    plans.set(`${p.patient_id}:${p.service_id}`, { interval: Number(p.interval_weeks) * 7, open: p.status === 'active' && Number(p.done) < Number(p.planned_sessions) });
  }
  // Patients with prepaid sessions waiting are already on the first list; they are not repeated here.
  const prepaidPatients = new Set(unbooked?.map((x) => x.patientId) ?? []);
  const due = all<Row>(
    `SELECT t.service_id, MAX(t.completed_at) AS last_at, COUNT(*) AS sessions, ${CONTACT_COLS}
       FROM treatment_sessions t JOIN patients p ON p.id = t.patient_id
      WHERE ${scope.sql} AND t.status = 'completed' AND t.completed_at >= ? AND ${NOTHING_BOOKED}
      GROUP BY t.patient_id, t.service_id`,
    [...scope.params, new Date(Date.now() - 240 * 86400000).toISOString(), todayStart],
  )
    .flatMap((r) => {
      if (prepaidPatients.has(r.patient_id as number)) return [];
      const plan = plans.get(`${r.patient_id}:${r.service_id}`);
      if (plan && !plan.open) return [];
      const interval = plan && plan.interval > 0 ? plan.interval : intervals.get(r.service_id as number);
      if (!interval) return [];
      const lastDate = localDate(r.last_at as string);
      const dueDate = addDays(lastDate, interval);
      const overdue = diffDays(dueDate, today);
      if (overdue < -DUE_AHEAD_DAYS || overdue > DUE_BACK_DAYS) return [];
      return [{ ...contact(r), serviceId: r.service_id as number, lastSession: r.last_at as string, sessions: Number(r.sessions), intervalDays: interval, basis: plan ? 'plan' : 'typical', dueDate, overdueDays: overdue }];
    })
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, LIMIT);

  // ---- Lapsed patients (win-back) --------------------------------------------------------------
  const lapsedRows = all<Row>(
    `SELECT ${CONTACT_COLS}, v.last_visit, v.visits,
            (SELECT a.service_id FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed' ORDER BY a.start_at DESC LIMIT 1) AS last_service_id
       FROM patients p
       JOIN (SELECT patient_id, MAX(start_at) AS last_visit, COUNT(*) AS visits FROM appointments WHERE status = 'completed' GROUP BY patient_id) v ON v.patient_id = p.id
      WHERE ${scope.sql} AND v.last_visit < ? AND v.last_visit >= ? AND ${NOTHING_BOOKED}`,
    [...scope.params, rangeBoundsUtc(addDays(today, -lapsedDays), addDays(today, -lapsedDays), tz).start, new Date(Date.now() - 730 * 86400000).toISOString(), todayStart],
  );
  const lapsedStats = patientStats(lapsedRows.map((r) => r.patient_id as number));
  const lapsed = lapsedRows
    .map((r) => ({
      ...contact(r),
      lastVisit: r.last_visit as string,
      daysSince: diffDays(localDate(r.last_visit as string), today),
      visits: Number(r.visits),
      lastServiceId: (r.last_service_id as number) ?? null,
      lifetimeValue: lapsedStats.get(r.patient_id as number)?.netPaid ?? 0,
    }))
    .sort((a, b) => b.lifetimeValue - a.lifetimeValue || a.daysSince - b.daysSince)
    .slice(0, LIMIT)
    .map((x) => ({ ...x, lifetimeValue: showMoney ? x.lifetimeValue : null }));

  // ---- Packages close to finishing (renewal) -----------------------------------------------------
  const renewals = showPackages
    ? all<Row>(
        `SELECT pp.id, pp.template_id, pp.purchase_date, ${CONTACT_COLS}
           FROM purchased_packages pp JOIN patients p ON p.id = pp.patient_id
          WHERE ${scope.sql} AND pp.status = 'active'
            AND EXISTS (SELECT 1 FROM package_usage u WHERE u.purchased_package_id = pp.id AND u.kind = 'consume' AND u.created_at >= ?)
            AND NOT EXISTS (SELECT 1 FROM purchased_packages n WHERE n.patient_id = pp.patient_id AND n.template_id = pp.template_id AND n.id <> pp.id
                              AND n.status = 'active' AND n.purchase_date >= pp.purchase_date)`,
        [...scope.params, new Date(Date.now() - 90 * 86400000).toISOString()],
      )
        .map((r) => ({ r, s: packageSummary(r.id as number, today)! }))
        .filter(({ s }) => s.usedSessions >= 1 && s.remainingSessions <= 1)
        .map(({ r, s }) => ({ ...contact(r), packageId: s.id, templateId: s.templateId, nameEn: s.nameEn, nameAr: s.nameAr, remaining: s.remainingSessions, total: s.totalSessions, state: s.state, expiryDate: s.expiryDate }))
        .sort((a, b) => a.remaining - b.remaining)
        .slice(0, LIMIT)
    : null;

  // ---- Birthdays in the coming week --------------------------------------------------------------
  const upcomingDays = Array.from({ length: BIRTHDAY_DAYS + 1 }, (_, i) => addDays(today, i));
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const birthdays = all<Row>(`SELECT ${CONTACT_COLS}, p.dob FROM patients p WHERE ${scope.sql} AND p.dob IS NOT NULL`, scope.params)
    .flatMap((r) => {
      const dob = r.dob as string;
      const day = upcomingDays.find((d) => {
        const md = dob.slice(5) === '02-29' && !isLeap(Number(d.slice(0, 4))) ? '02-28' : dob.slice(5);
        return d.slice(5) === md;
      });
      return day ? [{ ...contact(r), date: day, inDays: diffDays(today, day), turning: ageFrom(dob, day) }] : [];
    })
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, LIMIT);

  // ---- Balances to collect at an upcoming visit ---------------------------------------------------
  const collect = showMoney
    ? all<Row>(
        `SELECT * FROM (
           SELECT ${CONTACT_COLS}, nv.id AS appointment_id, nv.start_at AS next_visit,
                  (SELECT COALESCE(SUM(${INVOICE_BALANCE_SQL}), 0) FROM invoices i WHERE i.patient_id = p.id AND i.status = 'issued') AS outstanding
             FROM patients p
             JOIN appointments nv ON nv.id = (SELECT a.id FROM appointments a WHERE a.patient_id = p.id AND a.status IN ('booked','confirmed','arrived','in_treatment')
                                                AND a.start_at >= ? AND a.start_at < ? ORDER BY a.start_at LIMIT 1)
            WHERE ${scope.sql}
         ) WHERE outstanding > 0 ORDER BY next_visit LIMIT ${LIMIT}`,
        [todayStart, rangeBoundsUtc(addDays(today, 7), addDays(today, 7), tz).start, ...scope.params],
      ).map((r) => ({ ...contact(r), outstanding: Number(r.outstanding), appointmentId: r.appointment_id as number, nextVisit: r.next_visit as string }))
    : null;

  // Headline totals are shown in whole currency units.
  const whole = (minor: number) => Math.round(minor / 100) * 100;
  if (prepaidOutstanding) prepaidOutstanding.value = whole(prepaidOutstanding.value);
  res.json({
    today,
    lapsedDays,
    summary: {
      prepaidOutstanding,
      unbookedValue: unbooked ? whole(unbooked.reduce((s, x) => s + x.value, 0)) : null,
      lapsedValue: showMoney ? lapsed.reduce((s, x) => s + (x.lifetimeValue ?? 0), 0) : null,
      collectTotal: collect ? collect.reduce((s, x) => s + x.outstanding, 0) : null,
    },
    unbooked,
    due,
    lapsed,
    renewals,
    birthdays,
    collect,
    generatedAt: nowIso(),
  });
});
