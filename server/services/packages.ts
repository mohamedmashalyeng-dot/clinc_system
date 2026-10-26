import { all, get } from '../db/db.js';

export interface PackageItemBalance {
  serviceId: number;
  serviceNameEn: string;
  serviceNameAr: string;
  quantity: number;
  consumed: number;
  reversed: number;
  adjusted: number;
  used: number;
  remaining: number;
}

export interface PackageSummary {
  id: number;
  patientId: number;
  templateId: number;
  nameEn: string;
  nameAr: string;
  price: number;
  discount: number;
  purchaseDate: string;
  startDate: string;
  expiryDate: string;
  status: 'active' | 'cancelled';
  state: 'active' | 'expired' | 'used_up' | 'cancelled';
  invoiceId: number | null;
  invoiceNumber: string | null;
  invoiceTotal: number;
  paid: number;
  balance: number;
  items: PackageItemBalance[];
  totalSessions: number;
  usedSessions: number;
  remainingSessions: number;
  termsEn: string | null;
  termsAr: string | null;
}

/** Item balances derived from the usage ledger (never from a stored counter). */
export function packageItems(packageId: number): PackageItemBalance[] {
  return all<Record<string, number | string>>(
    `SELECT i.service_id, s.name_en, s.name_ar, i.quantity,
            COALESCE(SUM(CASE WHEN u.kind = 'consume' THEN -u.delta END), 0) AS consumed,
            COALESCE(SUM(CASE WHEN u.kind = 'reversal' THEN u.delta END), 0) AS reversed,
            COALESCE(SUM(CASE WHEN u.kind = 'adjustment' THEN u.delta END), 0) AS adjusted,
            COALESCE(SUM(u.delta), 0) AS net
       FROM purchased_package_items i
       JOIN services s ON s.id = i.service_id
       LEFT JOIN package_usage u ON u.purchased_package_id = i.purchased_package_id AND u.service_id = i.service_id
      WHERE i.purchased_package_id = ?
      GROUP BY i.service_id`,
    [packageId],
  ).map((r) => {
    const quantity = Number(r.quantity);
    const remaining = quantity + Number(r.net);
    return {
      serviceId: Number(r.service_id),
      serviceNameEn: String(r.name_en),
      serviceNameAr: String(r.name_ar),
      quantity,
      consumed: Number(r.consumed),
      reversed: Number(r.reversed),
      adjusted: Number(r.adjusted),
      used: quantity - remaining,
      remaining,
    };
  });
}

export function packageSummary(packageId: number, today: string): PackageSummary | null {
  const p = get<Record<string, unknown>>(
    `SELECT pp.*, i.number AS invoice_number, i.total AS invoice_total,
            COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0)
              - COALESCE((SELECT SUM(amount) FROM refunds WHERE invoice_id = i.id), 0) AS paid
       FROM purchased_packages pp LEFT JOIN invoices i ON i.id = pp.invoice_id
      WHERE pp.id = ?`,
    [packageId],
  );
  if (!p) return null;
  const items = packageItems(packageId);
  const totalSessions = items.reduce((s, i) => s + i.quantity, 0);
  const remainingSessions = items.reduce((s, i) => s + i.remaining, 0);
  const invoiceTotal = Number(p.invoice_total ?? 0);
  const paid = Number(p.paid ?? 0);
  const status = p.status as 'active' | 'cancelled';
  const expiryDate = String(p.expiry_date);
  const state = status === 'cancelled' ? 'cancelled' : remainingSessions <= 0 ? 'used_up' : expiryDate < today ? 'expired' : 'active';
  return {
    id: Number(p.id),
    patientId: Number(p.patient_id),
    templateId: Number(p.template_id),
    nameEn: String(p.name_en),
    nameAr: String(p.name_ar),
    price: Number(p.price),
    discount: Number(p.discount),
    purchaseDate: String(p.purchase_date),
    startDate: String(p.start_date),
    expiryDate,
    status,
    state,
    invoiceId: (p.invoice_id as number) ?? null,
    invoiceNumber: (p.invoice_number as string) ?? null,
    invoiceTotal,
    paid,
    balance: Math.max(0, invoiceTotal - paid),
    items,
    totalSessions,
    usedSessions: totalSessions - remainingSessions,
    remainingSessions,
    termsEn: (p.terms_en as string) ?? null,
    termsAr: (p.terms_ar as string) ?? null,
  };
}

export function patientPackages(patientId: number, today: string): PackageSummary[] {
  return all<{ id: number }>('SELECT id FROM purchased_packages WHERE patient_id = ? ORDER BY purchase_date DESC, id DESC', [patientId])
    .map((r) => packageSummary(r.id, today))
    .filter((p): p is PackageSummary => !!p);
}

export type EligibilityProblem = 'NOT_FOUND' | 'OTHER_PATIENT' | 'CANCELLED' | 'EXPIRED' | 'SERVICE_NOT_INCLUDED' | 'NO_SESSIONS_LEFT';

/** Can this package pay for one session of `serviceId` on `onDate`? */
export function checkEligibility(
  packageId: number,
  patientId: number,
  serviceId: number,
  onDate: string,
): { ok: true; summary: PackageSummary } | { ok: false; problem: EligibilityProblem; message: string } {
  const summary = packageSummary(packageId, onDate);
  if (!summary) return { ok: false, problem: 'NOT_FOUND', message: 'Package not found.' };
  if (summary.patientId !== patientId) return { ok: false, problem: 'OTHER_PATIENT', message: 'This package belongs to another patient.' };
  if (summary.status === 'cancelled') return { ok: false, problem: 'CANCELLED', message: 'This package has been cancelled.' };
  if (summary.expiryDate < onDate) {
    return { ok: false, problem: 'EXPIRED', message: `This package expired on ${summary.expiryDate}. Bill the session or ask a manager to adjust the package.` };
  }
  const item = summary.items.find((i) => i.serviceId === serviceId);
  if (!item) return { ok: false, problem: 'SERVICE_NOT_INCLUDED', message: 'This package does not include the selected service.' };
  if (item.remaining <= 0) return { ok: false, problem: 'NO_SESSIONS_LEFT', message: 'No sessions remain on this package for this service.' };
  return { ok: true, summary };
}

export function eligiblePackages(patientId: number, serviceId: number, onDate: string): PackageSummary[] {
  return patientPackages(patientId, onDate).filter((p) => checkEligibility(p.id, patientId, serviceId, onDate).ok);
}
