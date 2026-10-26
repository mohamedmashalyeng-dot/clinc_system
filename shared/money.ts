// All money is stored and calculated as integer minor units (e.g. piastres for EGP)
// so totals are exact and identical on the server and in the browser.

export interface LineInput {
  quantity: number;
  unitPrice: number; // minor units
  discount: number; // minor units, whole-line discount
}

export interface InvoiceTotals {
  subtotal: number;
  discountTotal: number;
  taxableAmount: number;
  tax: number;
  adjustments: number;
  total: number;
}

export function lineTotal(line: LineInput): number {
  return Math.max(0, line.quantity * line.unitPrice - line.discount);
}

/**
 * Invoice total = Σ(qty × unit) − discounts + tax(on discounted amount) + adjustments.
 * Adjustments are signed (credit notes are negative) and never make the total negative.
 */
export function computeInvoiceTotals(lines: LineInput[], taxRatePercent: number, adjustments = 0): InvoiceTotals {
  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const discountTotal = lines.reduce((s, l) => s + Math.min(l.discount, l.quantity * l.unitPrice), 0);
  const taxableAmount = subtotal - discountTotal;
  const tax = Math.round((taxableAmount * taxRatePercent) / 100);
  const total = Math.max(0, taxableAmount + tax + adjustments);
  return { subtotal, discountTotal, taxableAmount, tax, adjustments, total };
}

export function toMinor(major: number | string): number {
  const n = typeof major === 'string' ? Number(major.replace(/,/g, '')) : major;
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

export function toMajor(minor: number): number {
  return minor / 100;
}

export function formatMoney(minor: number, currency: string, locale: string): string {
  try {
    // Latin digits in both languages, matching dates, times and phone numbers across the UI.
    return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-EG', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
