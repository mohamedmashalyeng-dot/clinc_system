// Patient value and attendance insights derived from appointments and payments. Nothing here is
// stored: every figure is recomputed from the same records the reports read, and every rule is
// simple enough to explain to staff (the UI shows the definitions).
import { all, nowIso } from '../db/db.js';
import { clinicToday, getSettings } from '../settings.js';
import { diffDays, zonedParts } from '../../shared/time.js';
import type { PatientSegment } from '../../shared/domain.js';

/** No completed visit for this many days, and nothing booked, counts as lapsed. */
export const LAPSED_DAYS = 90;
/** Registered or first treated within this many days counts as new. */
const NEW_DAYS = 60;
/** Completed visits (with a recent one) that make a patient loyal. */
const LOYAL_VISITS = 4;
/** Share of paying patients, ranked by lifetime net spend, treated as VIP. */
const VIP_SHARE = 0.1;

export interface PatientStats {
  patientId: number;
  createdAt: string;
  completed: number;
  noShows: number;
  cancellations: number;
  lateCancellations: number;
  firstVisit: string | null;
  lastVisit: string | null;
  upcoming: number;
  netPaid: number;
}

export type RiskLevel = 'low' | 'medium' | 'high';
export interface NoShowRisk {
  level: RiskLevel;
  reasons: { code: 'no_shows' | 'late_cancellations' | 'first_visit'; n?: number }[];
}

type Row = Record<string, unknown>;

/** Attendance and spend for the given patients, in one pass over appointments and payments. */
export function patientStats(ids: number[]): Map<number, PatientStats> {
  const out = new Map<number, PatientStats>();
  const unique = [...new Set(ids)].filter((x) => Number.isInteger(x) && x > 0);
  if (!unique.length) return out;
  const ph = unique.map(() => '?').join(',');
  const noticeHours = getSettings().cancellation.minNoticeHours;
  const rows = all<Row>(
    `SELECT p.id, p.created_at,
            COALESCE(SUM(CASE WHEN a.status = 'completed' THEN 1 END), 0) AS completed,
            COALESCE(SUM(CASE WHEN a.status = 'no_show' THEN 1 END), 0) AS no_shows,
            COALESCE(SUM(CASE WHEN a.status = 'cancelled' THEN 1 END), 0) AS cancellations,
            COALESCE(SUM(CASE WHEN a.status = 'cancelled' AND a.cancelled_at IS NOT NULL
                               AND (julianday(a.start_at) - julianday(a.cancelled_at)) * 24 < ? THEN 1 END), 0) AS late_cancellations,
            MIN(CASE WHEN a.status = 'completed' THEN a.start_at END) AS first_visit,
            MAX(CASE WHEN a.status = 'completed' THEN a.start_at END) AS last_visit,
            COALESCE(SUM(CASE WHEN a.status IN ('booked','confirmed','arrived','in_treatment') AND a.start_at >= ? THEN 1 END), 0) AS upcoming,
            COALESCE((SELECT SUM(amount) FROM payments WHERE patient_id = p.id), 0)
              - COALESCE((SELECT SUM(amount) FROM refunds WHERE patient_id = p.id), 0) AS net_paid
       FROM patients p LEFT JOIN appointments a ON a.patient_id = p.id
      WHERE p.id IN (${ph})
      GROUP BY p.id`,
    [noticeHours, nowIso(), ...unique],
  );
  for (const r of rows) {
    out.set(r.id as number, {
      patientId: r.id as number,
      createdAt: r.created_at as string,
      completed: Number(r.completed),
      noShows: Number(r.no_shows),
      cancellations: Number(r.cancellations),
      lateCancellations: Number(r.late_cancellations),
      firstVisit: (r.first_visit as string) ?? null,
      lastVisit: (r.last_visit as string) ?? null,
      upcoming: Number(r.upcoming),
      netPaid: Number(r.net_paid),
    });
  }
  return out;
}

/** Lowest lifetime net spend that still ranks in the top VIP_SHARE of paying patients. */
export function vipThreshold(): number {
  const rows = all<{ net: number }>(
    `SELECT net FROM (
       SELECT pm.patient_id, SUM(pm.amount) - COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.patient_id = pm.patient_id), 0) AS net
         FROM payments pm GROUP BY pm.patient_id
     ) WHERE net > 0 ORDER BY net DESC`,
  );
  if (!rows.length) return Number.POSITIVE_INFINITY;
  return rows[Math.max(0, Math.ceil(rows.length * VIP_SHARE) - 1)].net;
}

export function segmentOf(s: PatientStats, vipMin: number, today = clinicToday()): { segment: PatientSegment; lapsed: boolean; daysSinceLastVisit: number | null } {
  const tz = getSettings().timezone;
  const days = s.lastVisit ? diffDays(zonedParts(s.lastVisit, tz).date, today) : null;
  const lapsed = days !== null && days > LAPSED_DAYS && s.upcoming === 0;
  const sinceCreated = diffDays(zonedParts(s.createdAt, tz).date, today);
  const sinceFirst = s.firstVisit ? diffDays(zonedParts(s.firstVisit, tz).date, today) : null;
  let segment: PatientSegment;
  if (s.completed > 0 && s.netPaid > 0 && s.netPaid >= vipMin) segment = 'vip';
  else if (s.completed >= LOYAL_VISITS && days !== null && days <= LAPSED_DAYS) segment = 'loyal';
  else if (s.completed === 0) segment = sinceCreated <= NEW_DAYS ? 'new' : 'prospect';
  else if (sinceFirst !== null && sinceFirst <= NEW_DAYS) segment = 'new';
  else segment = 'regular';
  return { segment, lapsed, daysSinceLastVisit: days };
}

/**
 * Rule-based no-show risk from the patient's own history:
 * high = 2+ no-shows making up at least a quarter of attended-or-missed visits;
 * medium = a no-show in at least 15% of visits, 2+ late cancellations, or a missed/late-cancelled
 * booking before ever completing a visit.
 */
export function noShowRisk(s: PatientStats): NoShowRisk {
  const reasons: NoShowRisk['reasons'] = [];
  if (s.noShows) reasons.push({ code: 'no_shows', n: s.noShows });
  if (s.lateCancellations) reasons.push({ code: 'late_cancellations', n: s.lateCancellations });
  if (!s.completed) reasons.push({ code: 'first_visit' });
  const attended = s.completed + s.noShows;
  const rate = attended ? s.noShows / attended : 0;
  let level: RiskLevel = 'low';
  if (s.noShows >= 2 && rate >= 0.25) level = 'high';
  else if ((s.noShows >= 1 && rate >= 0.15) || s.lateCancellations >= 2 || (!s.completed && s.noShows + s.lateCancellations >= 1)) level = 'medium';
  return { level, reasons };
}

/** Adds `noShowRisk` to upcoming bookings of patients the viewer can see. */
export function attachNoShowRisk<T extends { patientId: number | null; status: string; masked: boolean }>(items: T[]): (T & { noShowRisk: NoShowRisk | null })[] {
  const open = (a: T) => !a.masked && a.patientId !== null && (a.status === 'booked' || a.status === 'confirmed');
  const stats = patientStats(items.filter(open).map((a) => a.patientId!));
  return items.map((a) => {
    const s = open(a) ? stats.get(a.patientId!) : undefined;
    const risk = s ? noShowRisk(s) : null;
    return { ...a, noShowRisk: risk && risk.level !== 'low' ? risk : null };
  });
}
