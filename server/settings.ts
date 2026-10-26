import { get, parseJson } from './db/db.js';
import type { SettingsInput } from '../shared/schemas.js';
import { todayIn } from '../shared/time.js';

export type ClinicSettings = SettingsInput & {
  integrations: Record<'whatsapp' | 'sms' | 'email' | 'online_payments' | 'cloud_storage', 'not_connected' | 'connected'>;
};

let cached: ClinicSettings | null = null;

export function getSettings(): ClinicSettings {
  if (cached) return cached;
  const row = get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
  if (!row) throw new Error('Clinic settings missing — run the seed.');
  cached = parseJson<ClinicSettings>(row.data, {} as ClinicSettings);
  return cached;
}

export function invalidateSettings(): void {
  cached = null;
}

export const clinicTz = () => getSettings().timezone;
export const clinicToday = () => todayIn(clinicTz());

export const DEMO_MODE = process.env.LUMA_DEMO_MODE !== 'false';
