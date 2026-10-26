import { all, get, nowIso, parseJson, run, scalar, tx } from '../db/db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../http.js';
import { clinicToday } from '../settings.js';
import type { SessionDraftInput } from '../../shared/schemas.js';
import { checkEligibility } from './packages.js';
import { batchOnHand, round } from './inventory.js';
import { ensureAppointmentInvoice } from './finance.js';

interface SessionRow {
  id: number;
  appointment_id: number;
  patient_id: number;
  practitioner_id: number;
  service_id: number;
  status: 'draft' | 'completed' | 'reversed';
  purchased_package_id: number | null;
  follow_up_date: string | null;
  assessment: string | null;
  treatment_notes: string | null;
  aftercare: string | null;
  follow_up_plan: string | null;
}

interface ApptRow {
  id: number;
  patient_id: number;
  service_id: number;
  practitioner_id: number;
  device_id: number | null;
  status: string;
  purchased_package_id: number | null;
}

function loadSession(id: number): SessionRow {
  const s = get<SessionRow>('SELECT * FROM treatment_sessions WHERE id = ?', [id]);
  if (!s) throw notFound('Treatment session');
  return s;
}

/** The most recent consent record of a type decides; a later withdrawal overrides any earlier grant. */
export function activeConsentId(patientId: number, type: string): number | null {
  const latest = get<{ id: number; status: string }>('SELECT id, status FROM consents WHERE patient_id = ? AND type = ? ORDER BY id DESC LIMIT 1', [patientId, type]);
  return latest?.status === 'granted' ? latest.id : null;
}

export function hasActiveConsent(patientId: number, type: string): boolean {
  return activeConsentId(patientId, type) !== null;
}

/** Open (or reopen) the session record for an appointment; moves Arrived → In Treatment. */
export function startSession(user: AuthUser, appointmentId: number): number {
  return tx(() => {
    const appt = get<ApptRow>('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
    if (!appt) throw notFound('Appointment');
    const existing = scalar<number | null>("SELECT id FROM treatment_sessions WHERE appointment_id = ? AND status <> 'reversed'", [appointmentId]);
    if (existing) {
      if (appt.status === 'arrived') setInTreatment(user, appt);
      return existing;
    }
    if (appt.status === 'completed') {
      const reversed = scalar<number | null>("SELECT id FROM treatment_sessions WHERE appointment_id = ? ORDER BY id DESC LIMIT 1", [appointmentId]);
      if (reversed) return reversed;
    }
    if (!['arrived', 'in_treatment'].includes(appt.status)) {
      throw conflict('NOT_CHECKED_IN', 'Check the patient in before starting the treatment session.', { status: appt.status });
    }
    if (appt.status === 'arrived') setInTreatment(user, appt);
    const now = nowIso();
    const { id } = run(
      `INSERT INTO treatment_sessions(appointment_id, patient_id, practitioner_id, service_id, status, device_id, purchased_package_id,
                                      created_by, created_at, updated_by, updated_at)
       VALUES (?,?,?,?, 'draft', ?,?,?,?,?,?)`,
      [appt.id, appt.patient_id, appt.practitioner_id, appt.service_id, appt.device_id, appt.purchased_package_id, user.id, now, user.id, now],
    );
    audit(user, 'session.start', { entityType: 'session', entityId: id, patientId: appt.patient_id, summary: `Session started for appointment #${appt.id}` });
    return id;
  });
}

function setInTreatment(user: AuthUser, appt: ApptRow): void {
  const now = nowIso();
  run("UPDATE appointments SET status = 'in_treatment', started_at = ?, updated_at = ? WHERE id = ?", [now, now, appt.id]);
  run("INSERT INTO appointment_events(appointment_id, kind, from_status, to_status, created_by, created_at) VALUES (?, 'status', ?, 'in_treatment', ?, ?)", [
    appt.id,
    appt.status,
    user.id,
    now,
  ]);
}

export function saveDraft(user: AuthUser, sessionId: number, input: SessionDraftInput): void {
  tx(() => {
    const s = loadSession(sessionId);
    if (s.status !== 'draft') throw conflict('SESSION_LOCKED', 'This session is completed. Use “Add amendment” to correct the record.');
    if (input.purchasedPackageId) {
      const e = checkEligibility(input.purchasedPackageId, s.patient_id, s.service_id, clinicToday());
      if (!e.ok) throw badRequest('PACKAGE_NOT_ELIGIBLE', e.message, { problem: e.problem });
    }
    for (const c of input.consumables) {
      const b = get<{ item_id: number }>('SELECT item_id FROM inventory_batches WHERE id = ?', [c.batchId]);
      if (!b || b.item_id !== c.itemId) throw badRequest('BATCH_MISMATCH', 'A selected batch does not belong to its product.');
    }
    run(
      `UPDATE treatment_sessions SET body_areas = ?, assessment = ?, treatment_notes = ?, device_id = ?, device_settings = ?, aftercare = ?,
              follow_up_plan = ?, follow_up_date = ?, purchased_package_id = ?, treatment_plan_id = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`,
      [
        JSON.stringify(input.bodyAreas),
        input.assessment,
        input.treatmentNotes,
        input.deviceId,
        JSON.stringify(input.deviceSettings),
        input.aftercare,
        input.followUpPlan,
        input.followUpDate,
        input.purchasedPackageId,
        input.treatmentPlanId,
        user.id,
        nowIso(),
        sessionId,
      ],
    );
    // Keep the appointment's package choice in step with the session.
    run('UPDATE appointments SET purchased_package_id = ?, updated_at = ? WHERE id = ?', [input.purchasedPackageId, nowIso(), s.appointment_id]);
    run('DELETE FROM session_consumables WHERE session_id = ?', [sessionId]);
    for (const c of input.consumables) {
      run('INSERT INTO session_consumables(session_id, item_id, batch_id, quantity) VALUES (?,?,?,?)', [sessionId, c.itemId, c.batchId, c.quantity]);
    }
    audit(user, 'session.save_draft', { entityType: 'session', entityId: sessionId, patientId: s.patient_id, summary: 'Session draft saved', sensitive: true });
  });
}

export interface StockProblem {
  type: 'expired' | 'insufficient';
  itemName: string;
  batchNumber: string;
  expiryDate: string | null;
  onHand: number;
  requested: number;
  unit: string;
}

/**
 * Complete a session atomically: consume one package session (if used), deduct each
 * consumable from stock, mark the appointment completed, raise the invoice for non-package
 * services and schedule follow-up. Safe to retry — a completed session is returned as-is,
 * and unique indexes make a second package or stock deduction impossible.
 */
export function completeSession(
  user: AuthUser,
  sessionId: number,
  opts: { idempotencyKey: string; overrideReason: string | null },
): { alreadyCompleted: boolean } {
  return tx(() => {
    const s = loadSession(sessionId);
    if (s.status === 'completed') return { alreadyCompleted: true };
    if (s.status === 'reversed') throw conflict('SESSION_REVERSED', 'This session was reversed and cannot be completed again.');
    const appt = get<ApptRow>('SELECT * FROM appointments WHERE id = ?', [s.appointment_id])!;
    if (!['arrived', 'in_treatment'].includes(appt.status)) {
      throw conflict('NOT_CHECKED_IN', 'The appointment must be checked in before the session can be completed.', { status: appt.status });
    }
    if (!hasActiveConsent(s.patient_id, 'treatment')) {
      throw conflict('TREATMENT_CONSENT_MISSING', 'Record the patient’s treatment consent (Consents tab) before completing the session.');
    }
    const today = clinicToday();
    const now = nowIso();

    if (s.purchased_package_id) {
      const e = checkEligibility(s.purchased_package_id, s.patient_id, s.service_id, today);
      if (!e.ok) throw conflict('PACKAGE_NOT_ELIGIBLE', e.message, { problem: e.problem });
      run(
        `INSERT INTO package_usage(purchased_package_id, service_id, delta, kind, session_id, appointment_id, created_by, created_at)
         VALUES (?, ?, -1, 'consume', ?, ?, ?, ?)`,
        [s.purchased_package_id, s.service_id, s.id, s.appointment_id, user.id, now],
      );
    }

    const lines = all<{ id: number; item_id: number; batch_id: number; quantity: number; name: string; unit: string; batch_number: string; expiry_date: string | null }>(
      `SELECT c.id, c.item_id, c.batch_id, c.quantity, i.name, i.unit, b.batch_number, b.expiry_date
         FROM session_consumables c JOIN inventory_items i ON i.id = c.item_id JOIN inventory_batches b ON b.id = c.batch_id
        WHERE c.session_id = ?`,
      [s.id],
    );
    const problems: StockProblem[] = [];
    const planned = new Map<number, number>();
    for (const l of lines) {
      const onHand = round(batchOnHand(l.batch_id) - (planned.get(l.batch_id) ?? 0));
      planned.set(l.batch_id, (planned.get(l.batch_id) ?? 0) + l.quantity);
      const base = { itemName: l.name, batchNumber: l.batch_number, expiryDate: l.expiry_date, onHand, requested: l.quantity, unit: l.unit };
      if (l.expiry_date && l.expiry_date < today) problems.push({ type: 'expired', ...base });
      if (onHand < l.quantity) problems.push({ type: 'insufficient', ...base });
    }
    if (problems.length) {
      const canOverride = user.permissions.has('inventory.override');
      if (!opts.overrideReason) {
        throw conflict(
          'STOCK_BLOCKED',
          canOverride
            ? 'Some consumables are expired or short. Choose another batch, or override with a documented reason.'
            : 'Some consumables are expired or short. Choose another batch or reduce the quantity; an override needs a manager with inventory override permission.',
          { problems, canOverride },
        );
      }
      if (!canOverride) throw forbidden('Overriding stock checks requires the "inventory.override" permission.', 'OVERRIDE_NOT_ALLOWED', { problems });
    }
    for (const l of lines) {
      run(
        `INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, session_id, session_consumable_id, override_reason, created_by, created_at)
         VALUES (?, ?, 'usage', ?, ?, ?, ?, ?, ?, ?)`,
        [l.item_id, l.batch_id, -l.quantity, `Session #${s.id}`, s.id, l.id, problems.length ? opts.overrideReason : null, user.id, now],
      );
    }
    if (problems.length) {
      audit(user, 'inventory.override', { entityType: 'session', entityId: s.id, summary: `Stock check overridden on session #${s.id}`, meta: { reason: opts.overrideReason, count: problems.length } });
    }

    run(
      "UPDATE treatment_sessions SET status = 'completed', completed_by = ?, completed_at = ?, completion_key = ?, updated_at = ? WHERE id = ?",
      [user.id, now, opts.idempotencyKey, now, s.id],
    );
    run("UPDATE appointments SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, appt.id]);
    run("INSERT INTO appointment_events(appointment_id, kind, from_status, to_status, created_by, created_at) VALUES (?, 'status', ?, 'completed', ?, ?)", [
      appt.id,
      appt.status,
      user.id,
      now,
    ]);
    if (!s.purchased_package_id) ensureAppointmentInvoice(user, appt.id);
    if (s.follow_up_date) {
      run(
        "INSERT INTO follow_ups(patient_id, session_id, service_id, due_date, status, created_by, created_at) VALUES (?,?,?,?, 'open', ?, ?)",
        [s.patient_id, s.id, s.service_id, s.follow_up_date, user.id, now],
      );
    }
    audit(user, 'session.complete', {
      entityType: 'session',
      entityId: s.id,
      patientId: s.patient_id,
      summary: `Session #${s.id} completed${s.purchased_package_id ? ' (package session used)' : ''}`,
      meta: { consumables: lines.length },
      sensitive: true,
    });
    return { alreadyCompleted: false };
  });
}

const AMENDABLE = { assessment: 'assessment', treatmentNotes: 'treatment_notes', aftercare: 'aftercare', followUpPlan: 'follow_up_plan' } as const;

/** Completed records are never overwritten silently: each change keeps the old value, author and time. */
export function amendSession(user: AuthUser, sessionId: number, reason: string, changes: Partial<Record<keyof typeof AMENDABLE, string | null>>): void {
  tx(() => {
    const s = loadSession(sessionId);
    if (s.status !== 'completed') throw conflict('NOT_COMPLETED', 'Only completed sessions are amended; drafts can be edited directly.');
    const diff: { field: string; from: string | null; to: string | null }[] = [];
    for (const [key, column] of Object.entries(AMENDABLE) as [keyof typeof AMENDABLE, string][]) {
      if (!(key in changes)) continue;
      const before = (s as unknown as Record<string, string | null>)[column] ?? null;
      const after = changes[key] ?? null;
      if (before !== after) diff.push({ field: key, from: before, to: after });
    }
    if (!diff.length) throw badRequest('NO_CHANGES', 'Nothing was changed.');
    for (const d of diff) run(`UPDATE treatment_sessions SET ${AMENDABLE[d.field as keyof typeof AMENDABLE]} = ? WHERE id = ?`, [d.to, sessionId]);
    run('INSERT INTO session_amendments(session_id, author_id, reason, changes, created_at) VALUES (?,?,?,?,?)', [
      sessionId,
      user.id,
      reason,
      JSON.stringify(diff),
      nowIso(),
    ]);
    audit(user, 'session.amend', { entityType: 'session', entityId: sessionId, patientId: s.patient_id, summary: `Session #${sessionId} amended (${diff.length} field(s))`, sensitive: true });
  });
}

/** Reverse a completed session: returns the package session and (optionally) stock, with a reason on record. */
export function reverseSession(user: AuthUser, sessionId: number, reason: string, restock: boolean): { alreadyReversed: boolean } {
  return tx(() => {
    const s = loadSession(sessionId);
    if (s.status === 'reversed') return { alreadyReversed: true };
    if (s.status !== 'completed') throw conflict('NOT_COMPLETED', 'Only a completed session can be reversed.');
    const now = nowIso();
    const consume = get<{ purchased_package_id: number; service_id: number }>("SELECT purchased_package_id, service_id FROM package_usage WHERE session_id = ? AND kind = 'consume'", [sessionId]);
    if (consume) {
      run(
        `INSERT INTO package_usage(purchased_package_id, service_id, delta, kind, session_id, appointment_id, reason, created_by, created_at)
         VALUES (?, ?, 1, 'reversal', ?, ?, ?, ?, ?)`,
        [consume.purchased_package_id, consume.service_id, sessionId, s.appointment_id, reason, user.id, now],
      );
    }
    if (restock) {
      const used = all<{ item_id: number; batch_id: number; quantity: number; session_consumable_id: number }>(
        "SELECT item_id, batch_id, quantity, session_consumable_id FROM stock_movements WHERE session_id = ? AND type = 'usage'",
        [sessionId],
      );
      for (const m of used) {
        run(
          `INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, session_id, session_consumable_id, created_by, created_at)
           VALUES (?, ?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
          [m.item_id, m.batch_id, -m.quantity, `Reversal of session #${sessionId}: ${reason}`, sessionId, m.session_consumable_id, user.id, now],
        );
      }
    }
    run("UPDATE treatment_sessions SET status = 'reversed', reversed_by = ?, reversed_at = ?, reversal_reason = ?, updated_at = ? WHERE id = ?", [
      user.id,
      now,
      reason,
      now,
      sessionId,
    ]);
    run("UPDATE follow_ups SET status = 'dismissed', closed_by = ?, closed_at = ?, close_note = 'Session reversed' WHERE session_id = ? AND status = 'open'", [
      user.id,
      now,
      sessionId,
    ]);
    run("INSERT INTO appointment_events(appointment_id, kind, reason, created_by, created_at) VALUES (?, 'session_reversed', ?, ?, ?)", [
      s.appointment_id,
      reason,
      user.id,
      now,
    ]);
    audit(user, 'session.reverse', {
      entityType: 'session',
      entityId: sessionId,
      patientId: s.patient_id,
      summary: `Session #${sessionId} reversed${consume ? ' (package session returned)' : ''}${restock ? ', stock returned' : ''}`,
    });
    return { alreadyReversed: false };
  });
}

export function sessionAmendments(sessionId: number) {
  return all<Record<string, unknown>>(
    `SELECT a.id, a.reason, a.changes, a.created_at, u.name AS author FROM session_amendments a LEFT JOIN users u ON u.id = a.author_id
      WHERE a.session_id = ? ORDER BY a.id`,
    [sessionId],
  ).map((a) => ({ id: a.id, reason: a.reason, changes: parseJson(a.changes, []), createdAt: a.created_at, author: a.author }));
}
