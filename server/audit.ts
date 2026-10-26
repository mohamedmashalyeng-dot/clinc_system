import { nowIso, run } from './db/db.js';
import type { AuthUser } from './auth.js';

export interface AuditInput {
  entityType?: string;
  entityId?: number | null;
  patientId?: number | null;
  /** Human-readable, non-clinical description (record numbers, statuses, amounts). */
  summary?: string;
  meta?: Record<string, unknown>;
  /** Marks access to or changes of clinical content, for the sensitive-access report. */
  sensitive?: boolean;
}

export function audit(user: AuthUser | null | undefined, action: string, input: AuditInput = {}): void {
  run(
    'INSERT INTO audit_events(at, user_id, action, entity_type, entity_id, patient_id, summary, meta, sensitive) VALUES (?,?,?,?,?,?,?,?,?)',
    [
      nowIso(),
      user?.id ?? null,
      action,
      input.entityType ?? null,
      input.entityId ?? null,
      input.patientId ?? null,
      input.summary ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.sensitive ? 1 : 0,
    ],
  );
}
