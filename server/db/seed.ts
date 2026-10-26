// Fictional demo data. Every name, phone number, address and clinical note below is invented.
// History is generated through the same invariants the API enforces (no overlapping bookings,
// ledger-based package balances, FEFO stock movements, invoices settled by payments/refunds).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, UPLOAD_DIR, closeDb, nextNumber, openDb, run, scalar, tx } from './db.js';
import { hashPassword } from '../auth.js';
import { invalidateSettings } from '../settings.js';
import { DEFAULT_ROLE_PERMISSIONS, ROLES, type Role } from '../../shared/permissions.js';
import { normalizePhone, type WeeklyHours } from '../../shared/domain.js';
import { addDays, diffDays, minutesToTime, timeToMinutes, todayIn, weekdayOf, zonedParts, zonedToUtc } from '../../shared/time.js';
import { computeInvoiceTotals, lineTotal } from '../../shared/money.js';

const TZ = 'Africa/Cairo';
const PASSWORD = 'demo1234';
const HISTORY_DAYS = 120;
const FUTURE_DAYS = 14;

// ---- deterministic randomness -------------------------------------------------
let seedState = 20261025;
function rnd(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number) => rnd() < p;
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
function weighted<T>(entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of entries) {
    if ((r -= w) <= 0) return v;
  }
  return entries[entries.length - 1][0];
}

const iso = (date: string, time: string) => zonedToUtc(date, time, TZ).toISOString();
const addMin = (isoStr: string, m: number) => new Date(new Date(isoStr).getTime() + m * 60000).toISOString();
const EGP = (n: number) => Math.round(n * 100);
const key = () => crypto.randomUUID();

// ---- static reference data -----------------------------------------------------
function week(spec: Partial<Record<number, [string, string]>>): WeeklyHours {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => (spec[d] ? { open: true, start: spec[d]![0], end: spec[d]![1] } : { open: false, start: '10:00', end: '18:00' }));
}

const CLINIC_HOURS = week({ 0: ['10:00', '20:00'], 1: ['10:00', '20:00'], 2: ['10:00', '20:00'], 3: ['10:00', '20:00'], 4: ['10:00', '20:00'], 6: ['11:00', '19:00'] });

const SETTINGS = {
  clinicName: 'Luma Clinic',
  clinicNameAr: 'عيادة لوما',
  address: 'Building 7, Demo Street 90, New Cairo (fictional address)',
  phone: '+20 2 0000 0000',
  email: 'hello@luma-clinic.example',
  taxRegistration: null,
  defaultLanguage: 'en',
  currency: 'EGP',
  timezone: TZ,
  taxRatePercent: 0,
  slotMinutes: 15,
  openingHours: CLINIC_HOURS,
  cancellation: {
    minNoticeHours: 24,
    lateCancelDeposit: 'retain',
    noShowDeposit: 'retain',
    policyTextEn: 'Please give at least 24 hours’ notice to cancel or reschedule. Deposits for later cancellations and missed appointments are retained.',
    policyTextAr: 'يرجى الإبلاغ قبل ٢٤ ساعة على الأقل للإلغاء أو تغيير الموعد. يُحتفظ بالعربون في حالات الإلغاء المتأخر أو عدم الحضور.',
  },
  packageExpiryWarningDays: 30,
  expiryWarningDays: 60,
  integrations: { whatsapp: 'not_connected', sms: 'not_connected', email: 'not_connected', online_payments: 'not_connected', cloud_storage: 'not_connected' },
};

const USERS: { key: string; name: string; email: string; role: Role }[] = [
  { key: 'owner', name: 'Laila Hassan', email: 'owner@luma.demo', role: 'owner' },
  { key: 'rec1', name: 'Mariam Adel', email: 'reception@luma.demo', role: 'receptionist' },
  { key: 'rec2', name: 'Omar Said', email: 'reception2@luma.demo', role: 'receptionist' },
  { key: 'nour', name: 'Dr. Nour El-Sayed', email: 'dr.nour@luma.demo', role: 'practitioner' },
  { key: 'karim', name: 'Dr. Karim Fathy', email: 'dr.karim@luma.demo', role: 'practitioner' },
  { key: 'salma', name: 'Salma Youssef', email: 'salma@luma.demo', role: 'practitioner' },
  { key: 'acc', name: 'Hany Mostafa', email: 'accounts@luma.demo', role: 'accountant' },
];

const QUALIFICATIONS = [
  { code: 'physician', en: 'Physician (dermatology)', ar: 'طبيب جلدية' },
  { code: 'laser_certified', en: 'Laser safety certified', ar: 'شهادة سلامة الليزر' },
  { code: 'aesthetician', en: 'Licensed aesthetician', ar: 'أخصائية تجميل معتمدة' },
];

const PRACTITIONERS = [
  { key: 'nour', user: 'nour', en: 'Dr. Nour El-Sayed', ar: 'د. نور السيد', quals: ['physician', 'laser_certified'], color: '#7C6AA8', hours: week({ 0: ['10:00', '18:00'], 1: ['10:00', '18:00'], 2: ['10:00', '18:00'], 3: ['10:00', '18:00'], 4: ['10:00', '18:00'], 6: ['11:00', '17:00'] }) },
  { key: 'karim', user: 'karim', en: 'Dr. Karim Fathy', ar: 'د. كريم فتحي', quals: ['physician', 'laser_certified'], color: '#3F7F80', hours: week({ 0: ['12:00', '20:00'], 1: ['12:00', '20:00'], 2: ['12:00', '20:00'], 3: ['12:00', '20:00'], 4: ['12:00', '20:00'] }) },
  { key: 'salma', user: 'salma', en: 'Salma Youssef', ar: 'سلمى يوسف', quals: ['aesthetician', 'laser_certified'], color: '#A86F4C', hours: week({ 0: ['10:00', '18:00'], 2: ['10:00', '18:00'], 3: ['10:00', '18:00'], 4: ['10:00', '18:00'], 6: ['11:00', '18:00'] }) },
];

const ROOMS = ['Laser Room 1', 'Laser Room 2', 'Facial Suite', 'Consultation Room'];
const ROOM_AR: Record<string, string> = {
  'Laser Room 1': 'غرفة الليزر 1',
  'Laser Room 2': 'غرفة الليزر 2',
  'Facial Suite': 'جناح العناية بالوجه',
  'Consultation Room': 'غرفة الاستشارات',
};
const DEVICES = [
  { key: 'alex', name: 'Alexandrite Laser (Unit A)', ar: 'ليزر ألكسندرايت (الوحدة A)', model: 'Alexandrite 755 nm', room: 'Laser Room 1' },
  { key: 'diode', name: 'Diode Laser (Unit B)', ar: 'ليزر الدايود (الوحدة B)', model: 'Diode 810 nm', room: 'Laser Room 2' },
  { key: 'hydra', name: 'Hydradermabrasion Unit', ar: 'جهاز التقشير المائي', model: 'Hydradermabrasion system', room: 'Facial Suite' },
  { key: 'rf', name: 'RF Microneedling Unit', ar: 'جهاز الميكرونيدلنج بالترددات الراديوية', model: 'Fractional RF', room: 'Facial Suite' },
];

/** Absences relative to today: [first, last] day offsets, and hours for part of a single day. */
const TIME_OFF: { days: [number, number]; prac: string; kind: 'leave' | 'sick' | 'training'; hours?: [string, string]; note: string | null }[] = [
  { days: [-38, -37], prac: 'nour', kind: 'leave', note: null },
  { days: [-12, -12], prac: 'karim', kind: 'sick', note: null },
  { days: [3, 3], prac: 'salma', kind: 'training', hours: ['14:00', '18:00'], note: 'Supplier device training' },
  { days: [9, 10], prac: 'karim', kind: 'leave', note: 'Dr. Nour covers urgent reviews' },
];

const CATEGORIES = [
  { key: 'laser', en: 'Laser Hair Removal', ar: 'إزالة الشعر بالليزر' },
  { key: 'facial', en: 'Facials', ar: 'العناية بالوجه' },
  { key: 'skin', en: 'Skin Treatments', ar: 'علاجات البشرة' },
  { key: 'consult', en: 'Consultations', ar: 'الاستشارات' },
];

type Consumable = [sku: string, qty: number];
interface ServiceDef {
  key: string;
  en: string;
  ar: string;
  cat: string;
  dur: number;
  price: number;
  deposit: number;
  qual: string | null;
  rooms: string[];
  devices: string[];
  before: number;
  after: number;
  areas: string[];
  consumables: Consumable[];
  followUpDays?: number;
  kind: 'laser' | 'hydra' | 'facial' | 'peel' | 'rf' | 'acne' | 'consult';
}

const LASER_ROOMS = ['Laser Room 1', 'Laser Room 2'];
const LASER_DEVICES = ['alex', 'diode'];
const SERVICES: ServiceDef[] = [
  { key: 'legs', en: 'Laser – Full Legs', ar: 'ليزر – الساقين بالكامل', cat: 'laser', dur: 60, price: 2500, deposit: 500, qual: 'laser_certified', rooms: LASER_ROOMS, devices: LASER_DEVICES, before: 5, after: 10, areas: ['full_legs'], consumables: [['CG-500', 60], ['LZ-TIP', 1], ['GLV-M', 1], ['EYE-SH', 1]], kind: 'laser' },
  { key: 'underarms', en: 'Laser – Underarms', ar: 'ليزر – الإبطين', cat: 'laser', dur: 20, price: 700, deposit: 0, qual: 'laser_certified', rooms: LASER_ROOMS, devices: LASER_DEVICES, before: 5, after: 10, areas: ['underarms'], consumables: [['CG-500', 15], ['LZ-TIP', 1], ['GLV-M', 1], ['EYE-SH', 1]], kind: 'laser' },
  { key: 'bikini', en: 'Laser – Bikini', ar: 'ليزر – منطقة البكيني', cat: 'laser', dur: 30, price: 1200, deposit: 0, qual: 'laser_certified', rooms: LASER_ROOMS, devices: LASER_DEVICES, before: 5, after: 10, areas: ['bikini'], consumables: [['CG-500', 25], ['LZ-TIP', 1], ['GLV-M', 1], ['EYE-SH', 1]], kind: 'laser' },
  { key: 'face_laser', en: 'Laser – Full Face', ar: 'ليزر – الوجه بالكامل', cat: 'laser', dur: 30, price: 1100, deposit: 0, qual: 'laser_certified', rooms: LASER_ROOMS, devices: LASER_DEVICES, before: 5, after: 10, areas: ['face'], consumables: [['CG-500', 20], ['LZ-TIP', 1], ['GLV-M', 1], ['EYE-SH', 1]], kind: 'laser' },
  { key: 'body', en: 'Laser – Full Body', ar: 'ليزر – الجسم بالكامل', cat: 'laser', dur: 120, price: 6000, deposit: 1000, qual: 'laser_certified', rooms: LASER_ROOMS, devices: LASER_DEVICES, before: 10, after: 15, areas: ['full_body'], consumables: [['CG-500', 150], ['LZ-TIP', 2], ['GLV-M', 2], ['EYE-SH', 1]], kind: 'laser' },
  { key: 'patch', en: 'Laser Consultation & Patch Test', ar: 'استشارة ليزر واختبار حساسية', cat: 'consult', dur: 20, price: 0, deposit: 0, qual: 'laser_certified', rooms: LASER_ROOMS, devices: LASER_DEVICES, before: 0, after: 5, areas: ['underarms'], consumables: [['CG-500', 5], ['GLV-M', 1]], kind: 'consult' },
  { key: 'hydra', en: 'Hydrafacial Signature', ar: 'هيدرافيشيال سيجنتشر', cat: 'facial', dur: 60, price: 1800, deposit: 0, qual: null, rooms: ['Facial Suite'], devices: ['hydra'], before: 5, after: 10, areas: ['face'], consumables: [['HYD-SOL', 40], ['HYD-TIP', 1], ['GLV-M', 1]], kind: 'hydra' },
  { key: 'cleansing', en: 'Deep Cleansing Facial', ar: 'تنظيف بشرة عميق', cat: 'facial', dur: 60, price: 1200, deposit: 0, qual: null, rooms: ['Facial Suite'], devices: [], before: 5, after: 10, areas: ['face'], consumables: [['GLV-M', 1], ['GAUZE', 6]], kind: 'facial' },
  { key: 'peel', en: 'Chemical Peel – Light', ar: 'تقشير كيميائي خفيف', cat: 'skin', dur: 45, price: 1500, deposit: 0, qual: 'physician', rooms: ['Facial Suite'], devices: [], before: 5, after: 10, areas: ['face'], consumables: [['PEEL-GLY', 5], ['GAUZE', 4], ['GLV-M', 1], ['ALC', 2]], followUpDays: 7, kind: 'peel' },
  { key: 'rf', en: 'RF Microneedling – Face', ar: 'ميكرونيدلنج بالترددات الراديوية – الوجه', cat: 'skin', dur: 60, price: 4500, deposit: 1000, qual: 'physician', rooms: ['Facial Suite'], devices: ['rf'], before: 10, after: 15, areas: ['face'], consumables: [['RF-CART', 1], ['NUM-CRM', 10], ['GLV-M', 2], ['ALC', 3]], followUpDays: 14, kind: 'rf' },
  { key: 'acne', en: 'Acne Clinical Treatment', ar: 'علاج حب الشباب', cat: 'skin', dur: 40, price: 900, deposit: 0, qual: 'physician', rooms: ['Facial Suite', 'Consultation Room'], devices: [], before: 5, after: 5, areas: ['face'], consumables: [['GLV-M', 1], ['ALC', 2]], followUpDays: 21, kind: 'acne' },
  { key: 'consult', en: 'Dermatology Consultation', ar: 'استشارة جلدية', cat: 'consult', dur: 30, price: 600, deposit: 0, qual: 'physician', rooms: ['Consultation Room'], devices: [], before: 0, after: 5, areas: [], consumables: [['GLV-M', 1]], kind: 'consult' },
];

const PACKAGES = [
  { key: 'legs6', en: 'Laser Full Legs – 6 Sessions', ar: 'ليزر الساقين – ٦ جلسات', price: 12000, validity: 365, items: [['legs', 6]] as [string, number][] },
  { key: 'under6', en: 'Laser Underarms – 6 Sessions', ar: 'ليزر الإبطين – ٦ جلسات', price: 3500, validity: 365, items: [['underarms', 6]] as [string, number][] },
  { key: 'bikini6', en: 'Bikini + Underarms – 6 Sessions', ar: 'البكيني والإبطين – ٦ جلسات', price: 8000, validity: 365, items: [['bikini', 6], ['underarms', 6]] as [string, number][] },
  { key: 'body6', en: 'Laser Full Body – 6 Sessions', ar: 'ليزر الجسم بالكامل – ٦ جلسات', price: 30000, validity: 450, items: [['body', 6]] as [string, number][] },
  { key: 'glow', en: 'Glow Facial Course', ar: 'برنامج نضارة البشرة', price: 7000, validity: 180, items: [['hydra', 3], ['cleansing', 2]] as [string, number][] },
  { key: 'rf3', en: 'RF Microneedling – 3 Sessions', ar: 'ميكرونيدلنج – ٣ جلسات', price: 11500, validity: 270, items: [['rf', 3]] as [string, number][] },
];
const PACKAGE_TERMS_EN =
  'Sessions are personal and non-transferable. The package is valid until the expiry date shown. Only completed sessions are deducted; cancelled or missed appointments do not use a session. Unused sessions are not refundable after expiry.';
const PACKAGE_TERMS_AR =
  'الجلسات شخصية وغير قابلة للتحويل. الباقة صالحة حتى تاريخ الانتهاء الموضح. تُخصم الجلسات المكتملة فقط، ولا يُخصم الإلغاء أو عدم الحضور. لا تُسترد الجلسات غير المستخدمة بعد انتهاء الصلاحية.';

interface ItemDef {
  sku: string;
  name: string;
  cat: string;
  unit: string;
  supplier: string;
  threshold: number;
  cost: number; // piastres per unit
  restock: number;
  shelfDays: number | null;
}
const ITEMS: ItemDef[] = [
  { sku: 'CG-500', name: 'Cooling gel', cat: 'Laser consumables', unit: 'ml', supplier: 'Delta Medical Supplies (demo)', threshold: 1500, cost: 8, restock: 5000, shelfDays: 540 },
  { sku: 'LZ-TIP', name: 'Laser handpiece tip cover', cat: 'Laser consumables', unit: 'pc', supplier: 'Delta Medical Supplies (demo)', threshold: 30, cost: 2500, restock: 200, shelfDays: null },
  { sku: 'EYE-SH', name: 'Disposable eye shields', cat: 'Laser consumables', unit: 'pair', supplier: 'Nile Safety Co. (demo)', threshold: 40, cost: 1200, restock: 200, shelfDays: null },
  { sku: 'GLV-M', name: 'Nitrile gloves (M)', cat: 'General', unit: 'pair', supplier: 'Nile Safety Co. (demo)', threshold: 150, cost: 300, restock: 1000, shelfDays: 900 },
  { sku: 'ALC', name: 'Alcohol prep pads', cat: 'General', unit: 'pc', supplier: 'Delta Medical Supplies (demo)', threshold: 200, cost: 50, restock: 1000, shelfDays: 720 },
  { sku: 'GAUZE', name: 'Sterile gauze 10×10', cat: 'General', unit: 'pc', supplier: 'Delta Medical Supplies (demo)', threshold: 150, cost: 100, restock: 800, shelfDays: 1080 },
  { sku: 'HYD-SOL', name: 'Hydradermabrasion solution A', cat: 'Facial products', unit: 'ml', supplier: 'Aesthetic Source (demo)', threshold: 800, cost: 60, restock: 3000, shelfDays: 365 },
  { sku: 'HYD-TIP', name: 'Hydradermabrasion tip', cat: 'Facial products', unit: 'pc', supplier: 'Aesthetic Source (demo)', threshold: 20, cost: 4500, restock: 60, shelfDays: null },
  { sku: 'PEEL-GLY', name: 'Glycolic acid peel 30%', cat: 'Skin treatment products', unit: 'ml', supplier: 'Aesthetic Source (demo)', threshold: 60, cost: 250, restock: 250, shelfDays: 300 },
  { sku: 'RF-CART', name: 'RF microneedling cartridge (25-pin)', cat: 'Skin treatment products', unit: 'pc', supplier: 'Aesthetic Source (demo)', threshold: 8, cost: 35000, restock: 12, shelfDays: 730 },
  { sku: 'NUM-CRM', name: 'Topical numbing cream', cat: 'Skin treatment products', unit: 'g', supplier: 'Delta Medical Supplies (demo)', threshold: 80, cost: 400, restock: 300, shelfDays: 400 },
  { sku: 'SPF-S', name: 'Sunscreen SPF 50 sample', cat: 'Retail samples', unit: 'pc', supplier: 'Aesthetic Source (demo)', threshold: 15, cost: 12000, restock: 40, shelfDays: 365 },
];

const FEMALE = ['Nada', 'Yasmin', 'Mariam', 'Hana', 'Farida', 'Malak', 'Habiba', 'Rana', 'Dina', 'Aya', 'Nourhan', 'Reem', 'Sara', 'Heba', 'Mona', 'Rania', 'Dalia', 'Ghada', 'Nesma', 'Shereen', 'Amira', 'Basma', 'Jana', 'Lina', 'Nadine', 'Rawan', 'Yara', 'Menna', 'Esraa', 'Doaa', 'Ola', 'Marwa', 'Noha', 'Inji', 'Hoda', 'Samar', 'Engy', 'Lobna', 'Mai', 'Tasneem'];
const MALE = ['Ahmed', 'Omar', 'Youssef', 'Mostafa', 'Tarek', 'Hassan', 'Ali', 'Khaled', 'Sherif', 'Amr', 'Mahmoud', 'Ziad', 'Hesham', 'Adham'];
const LAST = ['Hassan', 'Mahmoud', 'Ibrahim', 'Abdelrahman', 'Fawzy', 'Saleh', 'Kamal', 'Naguib', 'Farouk', 'Mansour', 'Shawky', 'Ragab', 'Zaki', 'Helmy', 'Sabry', 'El-Sherif', 'Abdallah', 'Gamal', 'Lotfy', 'Rashad', 'Soliman', 'Hafez', 'Nasser', 'Tawfik', 'Badawi', 'Morsy', 'Selim', 'El-Masry', 'Wahba', 'Sami'];
const DISTRICTS = ['Maadi', 'Zamalek', 'Heliopolis', 'New Cairo', 'Sheikh Zayed', 'Nasr City', 'Dokki', '6th of October'];

// ---- helpers -----------------------------------------------------------------------
interface PatientState {
  id: number;
  created: string;
  female: boolean;
  treatmentConsent: boolean;
  photoConsent: boolean;
  skin: string;
  lastBySvc: Map<string, string>;
  busy: Map<string, [number, number][]>;
}
interface PkgState {
  id: number;
  patientId: number;
  tplKey: string;
  remaining: Map<string, number>;
  reserved: Map<string, number>;
  purchase: string;
  expiry: string;
  planId: number | null;
}
interface InvSpec {
  id?: number;
  patientId: number;
  kind: 'service' | 'package' | 'custom';
  appointmentId: number | null;
  lines: { description: string; serviceId?: number; packageTemplateId?: number; quantity: number; unitPrice: number; discount: number }[];
  issueDate: string;
  createdAt: string;
  createdBy: number;
  discountReason?: string;
  adjustments: { amount: number; reason: string; at: string; by: number }[];
  voided?: { at: string; by: number; reason: string };
  packageId?: number;
  installments?: { due: string; amount: number }[];
}
interface PaySpec {
  id?: number;
  inv: InvSpec;
  amount: number;
  method: 'cash' | 'card' | 'bank_transfer';
  kind: 'payment' | 'deposit';
  at: string;
  by: number;
  refunds: { amount: number; reason: string; at: string; by: number }[];
}

const overlaps = (list: [number, number][] | undefined, s: number, e: number) => !!list?.some(([a, b]) => a < e && b > s);
function mark(map: Map<string, [number, number][]>, k: string, s: number, e: number) {
  const l = map.get(k) ?? [];
  l.push([s, e]);
  map.set(k, l);
}
const randomMethod = () => weighted<'cash' | 'card' | 'bank_transfer'>([['cash', 45], ['card', 42], ['bank_transfer', 13]]);

function demoPhotoSvg(area: string, stage: number, skinTone: string, dateLabel: string): string {
  // A clearly synthetic placeholder (no real photography): a skin-toned field with marks that
  // become fewer at later stages, plus a visible "demo image" caption.
  let s = 1000 + area.length * 7;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const marks = Math.max(6, 70 - stage * 26);
  const dots = Array.from({ length: marks }, () => `<circle cx="${(60 + r() * 480).toFixed(1)}" cy="${(70 + r() * 270).toFixed(1)}" r="${(1.6 + r() * 2.6).toFixed(1)}" fill="#3b2a22" fill-opacity="${(0.35 + r() * 0.4).toFixed(2)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
<rect width="600" height="450" fill="#e9e4de"/>
<ellipse cx="300" cy="205" rx="250" ry="165" fill="${skinTone}"/>
<ellipse cx="300" cy="205" rx="250" ry="165" fill="#ffffff" fill-opacity="${(stage * 0.04).toFixed(2)}"/>
${dots}
<rect x="0" y="400" width="600" height="50" fill="#2b2633" fill-opacity="0.82"/>
<text x="20" y="431" font-family="Arial, sans-serif" font-size="17" fill="#ffffff">DEMO IMAGE · fictional · ${area.replace('_', ' ')} · ${dateLabel}</text>
</svg>`;
}

function minimalPdf(lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[()\\]/g, (c) => '\\' + c);
  const content = `BT /F1 14 Tf 72 770 Td 18 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function writeUpload(subdir: string, ext: string, data: Buffer | string): { fileName: string; size: number; sha256: string } {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  fs.mkdirSync(path.join(UPLOAD_DIR, subdir), { recursive: true });
  const fileName = `${subdir}/${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buf);
  return { fileName, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

// ---- main ----------------------------------------------------------------------------
export function seedDemo(): void {
  seedState = 20261025;
  const today = todayIn(TZ);
  const nowMs = Date.now();
  const nowIsoStr = new Date(nowMs).toISOString();
  const startDay = addDays(today, -HISTORY_DAYS);

  tx(() => {
    run('INSERT INTO settings(id, data, updated_at) VALUES (1, ?, ?)', [JSON.stringify(SETTINGS), nowIsoStr]);
    for (const role of ROLES) for (const p of DEFAULT_ROLE_PERMISSIONS[role]) run('INSERT INTO role_permissions(role, permission) VALUES (?,?)', [role, p]);

    const userId: Record<string, number> = {};
    const created0 = iso(addDays(today, -540), '09:00');
    for (const u of USERS) {
      userId[u.key] = run('INSERT INTO users(name, email, password_hash, role, extra_permissions, active, created_at) VALUES (?,?,?,?,?,1,?)', [
        u.name,
        u.email,
        hashPassword(PASSWORD),
        u.role,
        '[]',
        created0,
      ]).id;
    }
    for (const q of QUALIFICATIONS) run('INSERT INTO qualifications(code, name_en, name_ar) VALUES (?,?,?)', [q.code, q.en, q.ar]);
    const pracId: Record<string, number> = {};
    for (const p of PRACTITIONERS) {
      pracId[p.key] = run('INSERT INTO practitioners(user_id, display_name, display_name_ar, qualifications, color, hours, active) VALUES (?,?,?,?,?,?,1)', [
        userId[p.user],
        p.en,
        p.ar,
        JSON.stringify(p.quals),
        p.color,
        JSON.stringify(p.hours),
      ]).id;
    }
    const roomId: Record<string, number> = {};
    for (const r of ROOMS) roomId[r] = run('INSERT INTO rooms(name, name_ar, active) VALUES (?, ?, 1)', [r, ROOM_AR[r]]).id;
    const deviceId: Record<string, number> = {};
    for (const d of DEVICES) deviceId[d.key] = run('INSERT INTO devices(name, name_ar, model, room_id, active) VALUES (?,?,?,?,1)', [d.name, d.ar, d.model, roomId[d.room]]).id;
    const catId: Record<string, number> = {};
    for (const c of CATEGORIES) catId[c.key] = run('INSERT INTO service_categories(name_en, name_ar, active) VALUES (?,?,1)', [c.en, c.ar]).id;
    const svcId: Record<string, number> = {};
    const svcByKey = Object.fromEntries(SERVICES.map((s) => [s.key, s]));
    for (const s of SERVICES) {
      svcId[s.key] = run(
        `INSERT INTO services(name_en, name_ar, category_id, duration_min, price, deposit_amount, qualification, room_ids, device_ids, buffer_before_min, buffer_after_min, active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [s.en, s.ar, catId[s.cat], s.dur, EGP(s.price), EGP(s.deposit), s.qual, JSON.stringify(s.rooms.map((r) => roomId[r])), JSON.stringify(s.devices.map((d) => deviceId[d])), s.before, s.after],
      ).id;
    }
    // An inactive service shows how retired offerings stay on historical records.
    run(
      `INSERT INTO services(name_en, name_ar, category_id, duration_min, price, deposit_amount, qualification, room_ids, device_ids, buffer_before_min, buffer_after_min, active)
       VALUES ('Microdermabrasion (retired)', 'صنفرة البشرة (متوقفة)', ?, 45, ?, 0, NULL, ?, '[]', 5, 10, 0)`,
      [catId.facial, EGP(950), JSON.stringify([roomId['Facial Suite']])],
    );
    const tplId: Record<string, number> = {};
    for (const p of PACKAGES) {
      tplId[p.key] = run('INSERT INTO package_templates(name_en, name_ar, price, validity_days, terms_en, terms_ar, active, created_at) VALUES (?,?,?,?,?,?,1,?)', [
        p.en,
        p.ar,
        EGP(p.price),
        p.validity,
        PACKAGE_TERMS_EN,
        PACKAGE_TERMS_AR,
        created0,
      ]).id;
      for (const [s, q] of p.items) run('INSERT INTO package_template_items(template_id, service_id, quantity) VALUES (?,?,?)', [tplId[p.key], svcId[s], q]);
    }

    // Consent templates -------------------------------------------------------------
    const consentTpl: Record<string, number> = {};
    const consentDefs = [
      {
        key: 'treatment',
        type: 'treatment',
        en: 'Consent to aesthetic treatment',
        ar: 'الموافقة على العلاج التجميلي',
        bodyEn:
          'I confirm that the proposed treatment, its expected results, alternatives, risks and aftercare have been explained to me, that I have disclosed my medical history and medications accurately, and that I consent to treatment by the clinic’s qualified practitioners. I understand I may withdraw this consent at any time.',
        bodyAr:
          'أُقر بأنه تم شرح العلاج المقترح ونتائجه المتوقعة والبدائل والمخاطر وتعليمات العناية بعده، وبأنني أفصحت عن تاريخي الطبي وأدويتي بدقة، وأوافق على تلقي العلاج من الممارسين المؤهلين بالعيادة. وأعلم أنه يحق لي سحب هذه الموافقة في أي وقت.',
      },
      {
        key: 'clinical_photography',
        type: 'clinical_photography',
        en: 'Clinical photography consent',
        ar: 'الموافقة على التصوير الطبي',
        bodyEn:
          'I agree to photographs of the treatment area being taken and stored securely in my clinical record, for documenting my treatment and progress only. They will not be used for marketing, teaching or publication without my separate written consent.',
        bodyAr:
          'أوافق على التقاط صور لمنطقة العلاج وحفظها بشكل آمن في ملفي الطبي لتوثيق العلاج والتقدم فقط. ولن تُستخدم للتسويق أو التعليم أو النشر دون موافقة كتابية منفصلة مني.',
      },
      {
        key: 'marketing_photography',
        type: 'marketing_photography',
        en: 'Marketing use of photographs',
        ar: 'استخدام الصور لأغراض تسويقية',
        bodyEn:
          'I separately agree that selected before-and-after photographs may be used in the clinic’s marketing materials. Images will be unretouched and will not show my face unless I have agreed in writing. I can withdraw this consent at any time for future use.',
        bodyAr:
          'أوافق بشكل منفصل على إمكانية استخدام صور مختارة قبل وبعد العلاج في المواد التسويقية للعيادة. لن يتم تعديل الصور ولن يظهر وجهي إلا بموافقة كتابية. ويمكنني سحب هذه الموافقة في أي وقت للاستخدامات المستقبلية.',
      },
      {
        key: 'data_processing',
        type: 'data_processing',
        en: 'Privacy & data processing notice',
        ar: 'إشعار الخصوصية ومعالجة البيانات',
        bodyEn:
          'I acknowledge how the clinic stores and uses my personal and health information to provide care, schedule appointments and keep financial records, and who can access it.',
        bodyAr: 'أُقر بأنني اطلعت على كيفية حفظ العيادة لبياناتي الشخصية والصحية واستخدامها لتقديم الرعاية وجدولة المواعيد وحفظ السجلات المالية، ومن يمكنه الاطلاع عليها.',
      },
    ];
    for (const c of consentDefs) {
      consentTpl[c.key] = run('INSERT INTO consent_templates(type, title_en, title_ar, body_en, body_ar, version, active, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)', [
        c.type,
        c.en,
        c.ar,
        c.bodyEn,
        c.bodyAr,
        created0,
        created0,
      ]).id;
    }
    const consentTitle = Object.fromEntries(consentDefs.map((c) => [c.key, c]));

    // Message templates -------------------------------------------------------------
    const tmpl = (kind: string, name: string, en: string, ar: string, approvedBy: number | null) =>
      run('INSERT INTO message_templates(kind, name, body_en, body_ar, active, approved_by, approved_at, created_by, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?,?,?)', [
        kind,
        name,
        en,
        ar,
        approvedBy,
        approvedBy ? created0 : null,
        approvedBy ?? userId.owner,
        created0,
        created0,
      ]);
    tmpl(
      'reminder',
      'Appointment reminder',
      'Hello {{patient_name}}, this is a reminder of your {{service}} appointment at {{clinic_name}} on {{date}} at {{time}} with {{practitioner}}. Reply to confirm or call us to reschedule.',
      'مرحبًا {{patient_name}}، نذكّرك بموعد {{service}} في {{clinic_name}} يوم {{date}} الساعة {{time}} مع {{practitioner}}. يرجى الرد للتأكيد أو الاتصال بنا لتغيير الموعد.',
      null,
    );
    tmpl(
      'reminder',
      'Deposit request',
      'Hello {{patient_name}}, to secure your {{service}} appointment on {{date}} at {{time}}, a deposit is required. Please contact reception to arrange payment.',
      'مرحبًا {{patient_name}}، لتأكيد موعد {{service}} يوم {{date}} الساعة {{time}} يلزم دفع عربون. يرجى التواصل مع الاستقبال لترتيب الدفع.',
      null,
    );
    tmpl(
      'followup',
      'Post-treatment check-in',
      'Hello {{patient_name}}, this is {{clinic_name}} checking in after your recent {{service}}. How are you feeling? Please call us if you have any concerns.',
      'مرحبًا {{patient_name}}، نتواصل معك من {{clinic_name}} للاطمئنان بعد جلسة {{service}} الأخيرة. كيف حالك؟ يرجى الاتصال بنا إذا كان لديك أي استفسار.',
      null,
    );
    tmpl(
      'package_expiry',
      'Package expiring soon',
      'Hello {{patient_name}}, your package "{{package}}" has {{remaining}} session(s) remaining and expires on {{expiry_date}}. Contact us to book your next session.',
      'مرحبًا {{patient_name}}، باقتك "{{package}}" بها {{remaining}} جلسة متبقية وتنتهي صلاحيتها في {{expiry_date}}. تواصل معنا لحجز جلستك القادمة.',
      null,
    );
    tmpl(
      'aftercare',
      'Laser hair removal aftercare',
      'After your laser session: avoid sun exposure and tanning for 2 weeks and use SPF 50 daily; avoid hot baths, saunas and intense exercise for 24–48 hours; do not wax or pluck between sessions (shaving is fine). Mild redness is common and settles within hours. Contact the clinic if you notice blistering or crusting.',
      'بعد جلسة الليزر: تجنّب التعرض للشمس والتسمير لمدة أسبوعين واستخدم واقي شمس SPF 50 يوميًا، وتجنّب الحمامات الساخنة والساونا والتمارين الشاقة لمدة ٢٤–٤٨ ساعة، ولا تستخدم الشمع أو النتف بين الجلسات (الحلاقة مسموحة). الاحمرار الخفيف شائع ويزول خلال ساعات. تواصل مع العيادة إذا لاحظت فقاعات أو قشور.',
      userId.nour,
    );
    tmpl(
      'aftercare',
      'Chemical peel aftercare',
      'For 5–7 days: cleanse gently, moisturise, and use SPF 50 daily. Do not pick or peel flaking skin. Avoid retinoids, exfoliants and waxing for one week. Contact the clinic if you have significant pain, swelling or signs of infection.',
      'لمدة ٥–٧ أيام: نظّف البشرة بلطف واستخدم مرطبًا وواقي شمس SPF 50 يوميًا. لا تنزع القشور. تجنّب الريتينويد والمقشرات والشمع لمدة أسبوع. تواصل مع العيادة في حال وجود ألم شديد أو تورم أو علامات عدوى.',
      userId.nour,
    );
    tmpl(
      'aftercare',
      'Hydrafacial aftercare',
      'Avoid makeup for 6 hours and exfoliating products for 48 hours. Keep skin hydrated and use SPF daily.',
      'تجنّب المكياج لمدة ٦ ساعات والمنتجات المقشرة لمدة ٤٨ ساعة. حافظ على ترطيب البشرة واستخدم واقي الشمس يوميًا.',
      userId.salma,
    );
    tmpl(
      'aftercare',
      'RF microneedling aftercare (draft)',
      'Draft — awaiting practitioner review.',
      'مسودة — بانتظار مراجعة الممارس.',
      null,
    );

    // Inventory ------------------------------------------------------------------------
    const itemId: Record<string, number> = {};
    const itemDef = Object.fromEntries(ITEMS.map((i) => [i.sku, i]));
    for (const i of ITEMS) {
      itemId[i.sku] = run('INSERT INTO inventory_items(sku, name, category, unit, supplier, reorder_threshold, unit_cost, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)', [
        i.sku,
        i.name,
        i.cat,
        i.unit,
        i.supplier,
        i.threshold,
        i.cost,
        created0,
      ]).id;
    }
    interface BatchState {
      id: number;
      sku: string;
      expiry: string | null;
      onHand: number;
    }
    const batches: BatchState[] = [];
    let batchSeq = 0;
    const expenses: { date: string; category: string; description: string; vendor: string | null; amount: number; method: string }[] = [];
    function receive(sku: string, qty: number, date: string, expiryOverride?: string | null, recordExpense = true): BatchState {
      const def = itemDef[sku];
      const expiry = expiryOverride !== undefined ? expiryOverride : def.shelfDays ? addDays(date, def.shelfDays) : null;
      const number = `${sku}-${date.slice(2, 7).replace('-', '')}-${String(++batchSeq).padStart(3, '0')}`;
      const b = run('INSERT INTO inventory_batches(item_id, batch_number, expiry_date, unit_cost, received_at) VALUES (?,?,?,?,?)', [itemId[sku], number, expiry, def.cost, iso(date, '09:30')]);
      run("INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, reference, created_by, created_at) VALUES (?,?, 'purchase', ?, 'Stock received', ?, ?, ?)", [
        itemId[sku],
        b.id,
        qty,
        `PO-${number}`,
        userId.owner,
        iso(date, '09:30'),
      ]);
      if (recordExpense) expenses.push({ date, category: 'supplies', description: `${def.name} × ${qty} ${def.unit}`, vendor: def.supplier, amount: Math.round(qty * def.cost), method: 'bank_transfer' });
      const state = { id: b.id, sku, expiry, onHand: qty };
      batches.push(state);
      return state;
    }
    const noRestockAfter: Record<string, string> = { 'RF-CART': addDays(today, -40) };
    function takeStock(sku: string, qty: number, date: string): BatchState | null {
      const usable = () => batches.filter((b) => b.sku === sku && b.onHand >= qty && (!b.expiry || b.expiry >= date)).sort((a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999'));
      let b = usable()[0];
      if (!b) {
        if (noRestockAfter[sku] && date > noRestockAfter[sku]) return null;
        b = receive(sku, itemDef[sku].restock, addDays(date, -1));
      }
      b.onHand -= qty;
      return b;
    }
    const opening = addDays(startDay, -20);
    for (const i of ITEMS) {
      if (i.sku === 'SPF-S') continue;
      receive(i.sku, i.restock, opening);
    }
    // Retail samples: one batch already expired with stock left (blocked from use), one current.
    receive('SPF-S', 30, addDays(today, -380), addDays(today, -6));
    takeStockManual('SPF-S');
    function takeStockManual(sku: string) {
      // Samples handed out over time (recorded as adjustments with a reason).
      const b = batches.find((x) => x.sku === sku)!;
      run("INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, created_by, created_at) VALUES (?,?, 'adjustment', -18, 'Samples given to patients (monthly count)', ?, ?)", [
        itemId[sku],
        b.id,
        userId.rec1,
        iso(addDays(today, -40), '18:00'),
      ]);
      b.onHand -= 18;
    }
    receive('SPF-S', 40, addDays(today, -30));

    // Patients ------------------------------------------------------------------------
    const patients: PatientState[] = [];
    const usedPhones = new Set<string>();
    const N_PATIENTS = 150;
    for (let i = 0; i < N_PATIENTS; i++) {
      const female = chance(0.84);
      const first = female ? pick(FEMALE) : pick(MALE);
      const last = pick(LAST);
      let phone: string;
      do phone = `01${pick(['0', '1', '2', '5'])}0555${String(int(0, 9999)).padStart(4, '0')}`;
      while (usedPhones.has(phone));
      usedPhones.add(phone);
      const isNew = i >= N_PATIENTS - 10;
      const createdDate = isNew ? addDays(today, -int(1, 18)) : addDays(today, -int(HISTORY_DAYS + 5, 600));
      const createdAt = iso(createdDate, `${String(int(10, 18)).padStart(2, '0')}:${pick(['05', '20', '35', '50'])}`);
      const dob = `${int(1972, 2006)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
      const channel = weighted<string>([['whatsapp', 70], ['sms', 10], ['email', 8], ['phone', 10], ['none', 2]]);
      const pid = run(
        `INSERT INTO patients(code, first_name, last_name, phone, phone_normalized, email, dob, gender, address, emergency_name, emergency_phone, emergency_relation,
           preferred_language, contact_channel, allow_reminders, allow_marketing, primary_practitioner_id, admin_notes, created_at, created_by, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          `P-${String(i + 1).padStart(5, '0')}`,
          first,
          last,
          phone,
          normalizePhone(phone),
          chance(0.7) ? `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}${int(1, 99)}@example.com` : null,
          dob,
          female ? 'female' : 'male',
          `Apt ${int(1, 40)}, Demo St. ${int(1, 120)}, ${pick(DISTRICTS)}`,
          chance(0.75) ? `${pick(FEMALE.concat(MALE))} ${last}` : null,
          chance(0.75) ? `01${pick(['0', '1', '2'])}0555${String(int(0, 9999)).padStart(4, '0')}` : null,
          chance(0.75) ? pick(['Mother', 'Sister', 'Spouse', 'Brother', 'Father', 'Friend']) : null,
          chance(0.7) ? 'ar' : 'en',
          channel,
          channel === 'none' ? 0 : chance(0.93) ? 1 : 0,
          chance(0.2) ? 1 : 0,
          chance(0.6) ? pracId[pick(['nour', 'karim', 'salma'])] : null,
          chance(0.1) ? pick(['Prefers morning appointments', 'Prefers a female practitioner', 'Corporate discount card holder (verify at checkout)', 'Prefers WhatsApp messages in English']) : null,
          createdAt,
          pick([userId.rec1, userId.rec2]),
          createdAt,
        ],
      ).id;
      const treatmentConsent = !isNew || chance(0.4);
      const photoConsent = chance(0.55);
      const skin = weighted<string>([['II', 10], ['III', 40], ['IV', 38], ['V', 12]]);
      const st: PatientState = { id: pid, created: createdDate, female, treatmentConsent, photoConsent, skin, lastBySvc: new Map(), busy: new Map() };
      patients.push(st);
      const recBy = pick([userId.rec1, userId.rec2]);
      const addConsent = (k: string, at: string, by: number) => {
        const c = consentTitle[k];
        return run(
          "INSERT INTO consents(patient_id, template_id, type, template_version, title_en, title_ar, status, method, recorded_by, recorded_at) VALUES (?,?,?,1,?,?, 'granted', ?, ?, ?)",
          [pid, consentTpl[k], c.type, c.en, c.ar, pick(['paper_signed', 'in_clinic_acknowledgement']), by, at],
        ).id;
      };
      addConsent('data_processing', createdAt, recBy);
      if (treatmentConsent) addConsent('treatment', createdAt, recBy);
      if (photoConsent) addConsent('clinical_photography', createdAt, recBy);
      if (photoConsent && chance(0.22)) addConsent('marketing_photography', createdAt, recBy);
      if (i === 17) {
        // A withdrawn marketing consent, kept for the record.
        const cid = addConsent('marketing_photography', createdAt, recBy);
        run("UPDATE consents SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = ?, withdraw_reason = 'Patient asked not to use photos in marketing' WHERE id = ?", [
          userId.rec1,
          iso(addDays(today, -35), '12:00'),
          cid,
        ]);
      }

      // Medical record (practitioner-entered, fictional)
      if (!isNew || chance(0.3)) {
        const allergy = weighted<string>([['No known drug allergies', 62], ['Lidocaine — localised skin reaction (2023)', 8], ['Penicillin', 10], ['Latex', 6], ['Fragrance / essential oils', 8], ['Salicylic acid — irritation', 6]]);
        const meds = weighted<string>([['None', 55], ['Oral contraceptive pill', 12], ['Levothyroxine 50 mcg daily', 9], ['Isotretinoin — stopped 4 months ago', 6], ['Topical tretinoin 0.025% at night', 10], ['Metformin 500 mg twice daily', 8]]);
        const history = weighted<string>([['No significant medical history', 50], ['Polycystic ovary syndrome (PCOS)', 14], ['Hypothyroidism — controlled', 10], ['Childhood eczema', 8], ['Recurrent cold sores (HSV-1)', 9], ['Migraine', 9]]);
        const alerts: { id: number; text: string; severity: string }[] = [];
        let precautions: string | null = null;
        if (allergy.startsWith('Lidocaine')) alerts.push({ id: alerts.length + 1, text: 'Lidocaine sensitivity — check numbing products before use', severity: 'high' });
        if (allergy.startsWith('Latex')) alerts.push({ id: alerts.length + 1, text: 'Latex allergy — nitrile only', severity: 'high' });
        if (meds.startsWith('Isotretinoin')) {
          alerts.push({ id: alerts.length + 1, text: 'Recent isotretinoin — practitioner review required before laser or peel', severity: 'high' });
          precautions = 'Isotretinoin stopped recently; practitioner to confirm timing before resurfacing or laser.';
        }
        if (history.startsWith('Recurrent cold sores')) {
          alerts.push({ id: alerts.length + 1, text: 'Cold sore history — review before facial peels/RF', severity: 'medium' });
          precautions = (precautions ? precautions + ' ' : '') + 'Discuss cold sore history before facial procedures.';
        }
        if (chance(0.05)) alerts.push({ id: alerts.length + 1, text: 'History of keloid scarring', severity: 'medium' });
        if (meds.startsWith('Topical tretinoin')) precautions = (precautions ? precautions + ' ' : '') + 'Pause tretinoin 5 days before peels.';
        const data = {
          medicalHistory: history,
          allergies: allergy,
          medications: meds,
          skinType: skin,
          pregnant: female ? weighted<string>([['no', 85], ['unknown', 15]]) : 'no',
          precautions,
          alerts,
        };
        const author = userId[pick(['nour', 'karim'])];
        const mAt = addMin(createdAt, 40);
        if (chance(0.25)) {
          run('INSERT INTO patient_medical_versions(patient_id, version, data, author_id, created_at) VALUES (?,1,?,?,?)', [
            pid,
            JSON.stringify({ ...data, medications: 'None', alerts: [] }),
            author,
            mAt,
          ]);
          run('INSERT INTO patient_medical(patient_id, data, version, updated_at, updated_by) VALUES (?,?,2,?,?)', [pid, JSON.stringify(data), addMin(mAt, 60 * 24 * int(10, 60)), author]);
        } else {
          run('INSERT INTO patient_medical(patient_id, data, version, updated_at, updated_by) VALUES (?,?,1,?,?)', [pid, JSON.stringify(data), mAt, author]);
        }
      }
    }
    // A likely duplicate registration (same number written differently) — detection flags it, nothing is merged.
    const dupSource = patients[11];
    const srcPhone = scalar<string>('SELECT phone FROM patients WHERE id = ?', [dupSource.id]);
    const dupPhone = `+20 ${srcPhone.slice(1, 4)} ${srcPhone.slice(4, 7)} ${srcPhone.slice(7)}`;
    run('UPDATE patients SET phone = ?, phone_normalized = ?, first_name = ?, last_name = ? WHERE id = ?', [dupPhone, normalizePhone(dupPhone), 'Yasmine', 'Aly', patients[N_PATIENTS - 3].id]);
    run('UPDATE patients SET first_name = ?, last_name = ? WHERE id = ?', ['Yasmin', 'Ali', dupSource.id]);

    // Schedule generation -----------------------------------------------------------------
    const patientById = new Map(patients.map((p) => [p.id, p]));
    const pkgs: PkgState[] = [];
    const invoices: InvSpec[] = [];
    const payments: PaySpec[] = [];
    const roomBusy = new Map<string, [number, number][]>();
    const pracBusyKey = (date: string, p: string) => `${date}|p${p}`;
    // Time off is recorded ahead by reception, and nothing is booked over it.
    for (const o of TIME_OFF) {
      const from = addDays(today, o.days[0]);
      const to = addDays(today, o.days[1]);
      for (let date = from; date <= to; date = addDays(date, 1)) {
        mark(roomBusy, pracBusyKey(date, o.prac), o.hours ? timeToMinutes(o.hours[0]) : 0, o.hours ? timeToMinutes(o.hours[1]) : 24 * 60);
      }
      run('INSERT INTO practitioner_time_off(practitioner_id, kind, start_at, end_at, all_day, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', [
        pracId[o.prac],
        o.kind,
        iso(from, o.hours?.[0] ?? '00:00'),
        o.hours ? iso(from, o.hours[1]) : iso(addDays(to, 1), '00:00'),
        o.hours ? 0 : 1,
        o.note,
        userId.rec1,
        iso(addDays(from, o.kind === 'sick' ? 0 : -10), '09:30'),
      ]);
    }
    const followUps: { patientId: number; sessionId: number; serviceKey: string; due: string; by: number; at: string }[] = [];
    const sessionsForPhotos: { patientId: number; sessionId: number; serviceKey: string; date: string }[] = [];
    const todayHasProgress = { arrived: 0, inTreatment: 0 };

    const serviceWeights: Record<string, [string, number][]> = {
      nour: [['legs', 14], ['underarms', 11], ['bikini', 7], ['face_laser', 6], ['body', 4], ['patch', 4], ['consult', 14], ['peel', 10], ['rf', 14], ['acne', 7]],
      karim: [['legs', 16], ['underarms', 12], ['bikini', 9], ['face_laser', 7], ['body', 5], ['patch', 5], ['consult', 13], ['peel', 9], ['rf', 13], ['acne', 6]],
      salma: [['hydra', 26], ['cleansing', 18], ['legs', 14], ['underarms', 13], ['bikini', 9], ['face_laser', 8], ['patch', 4]],
    };
    const templateFor: Record<string, string> = { legs: 'legs6', underarms: 'under6', bikini: 'bikini6', body: 'body6', hydra: 'glow', rf: 'rf3' };
    const minGapDays: Record<string, number> = { legs: 35, underarms: 30, bikini: 30, face_laser: 28, body: 40, hydra: 21, cleansing: 21, rf: 28, peel: 21, acne: 21, consult: 60, patch: 365 };

    interface NoteDef {
      assessment: (skin: string) => string;
      treatment: readonly string[];
      settings: (device: string) => { label: string; value: string }[];
    }
    const notes: Record<ServiceDef['kind'], NoteDef> = {
      laser: {
        assessment: (skin: string) => `Fitzpatrick ${skin}. Dark, medium–coarse hair; no recent sun exposure reported. Skin intact, no active lesions in treatment area.`,
        treatment: ['Treatment area covered evenly in single pass. Expected perifollicular oedema; no adverse reaction.', 'Patient tolerated well. Mild erythema immediately post-treatment, settled before discharge.', 'Reduced density noted compared with previous session. Even coverage; cooling applied throughout.'],
        settings: (dev: string) => [
          { label: 'Device', value: dev },
          { label: 'Fluence', value: `${int(14, 22)} J/cm²` },
          { label: 'Spot size', value: `${pick([12, 15, 18])} mm` },
          { label: 'Pulse width', value: `${pick([3, 10, 20, 30])} ms` },
        ],
      },
      hydra: { assessment: () => 'Combination skin, mild congestion on T-zone, no active inflammation.', treatment: ['Cleanse, exfoliation, extraction and hydration steps completed. Skin calm at end of session.'], settings: () => [{ label: 'Tip', value: 'Blue (normal skin)' }, { label: 'Serum', value: 'Solution A' }] },
      facial: { assessment: () => 'Mild congestion, dehydrated cheeks.', treatment: ['Double cleanse, steam, manual extractions, calming mask applied.'], settings: () => [] },
      peel: { assessment: () => 'Mild post-inflammatory hyperpigmentation on cheeks. Pre-peel preparation confirmed.', treatment: ['Glycolic 30% applied, neutralised at 3 minutes. Even mild erythema, no frosting.'], settings: () => [{ label: 'Agent', value: 'Glycolic acid 30%' }, { label: 'Contact time', value: '3 min' }] },
      rf: { assessment: () => 'Atrophic acne scarring on cheeks (rolling/boxcar). Numbing applied 45 minutes pre-procedure.', treatment: ['Two passes over cheeks, single pass forehead. Pinpoint bleeding as expected; cooled post-procedure.'], settings: () => [{ label: 'Depth', value: `${pick(['1.5', '2.0', '2.5'])} mm` }, { label: 'Energy level', value: String(int(3, 6)) }, { label: 'Passes', value: '2' }] },
      acne: { assessment: () => 'Inflammatory papules on jawline, few comedones.', treatment: ['Gentle cleanse, extractions and blue-light protocol completed.'], settings: () => [] },
      consult: { assessment: () => 'Consultation: concerns, history and expectations discussed.', treatment: ['Options and realistic outcomes explained. Written information given.'], settings: () => [] },
    };
    const aftercareText: Record<string, string> = {
      laser: 'Avoid sun and heat for 48 h, SPF 50 daily, no waxing between sessions.',
      hydra: 'No makeup for 6 h; avoid exfoliants for 48 h.',
      facial: 'Gentle skincare for 48 h; SPF daily.',
      peel: 'Gentle cleanse and moisturise; no picking; SPF 50; pause retinoids for 7 days.',
      rf: 'Keep skin clean, avoid makeup 24 h, SPF 50, no active skincare for 5 days.',
      acne: 'Continue prescribed routine; avoid picking.',
      consult: '',
    };
    const cancelReasons = ['Patient unwell', 'Travel', 'Work commitment', 'Rescheduled by patient by phone', 'Family emergency'];

    // A few packages bought before the visible history window, partly used up earlier.
    for (const p of patients.slice(20, 32)) {
      if (!p.treatmentConsent) continue;
      const tplKey = pick(['legs6', 'under6', 'bikini6', 'glow']);
      const date = addDays(startDay, -int(20, 120));
      if (date < p.created) continue;
      const st = sellPackage(p, tplKey, date, iso(date, '13:00'), pick(['nour', 'karim', 'salma']));
      const tpl = PACKAGES.find((x) => x.key === tplKey)!;
      const [s] = tpl.items[0];
      // Earlier sessions are recorded as a migrated opening balance (traceable adjustment).
      const used = int(1, 2);
      run(
        "INSERT INTO package_usage(purchased_package_id, service_id, delta, kind, reason, created_by, created_at) VALUES (?,?,?, 'adjustment', 'Opening balance: sessions used before system go-live', ?, ?)",
        [st.id, svcId[s], -used, userId.owner, iso(startDay, '09:00')],
      );
      st.remaining.set(s, (st.remaining.get(s) ?? 0) - used);
    }

    for (let date = startDay; date <= addDays(today, FUTURE_DAYS); date = addDays(date, 1)) {
      const wd = weekdayOf(date);
      const clinic = CLINIC_HOURS[wd];
      if (!clinic.open) continue;
      const daysAhead = diffDays(today, date);
      const density = daysAhead < 0 ? 0.74 : daysAhead === 0 ? 0.82 : Math.max(0.12, 0.66 - daysAhead * 0.045);
      for (const pr of PRACTITIONERS) {
        const ph = pr.hours[wd];
        if (!ph.open) continue;
        let cursor = Math.max(timeToMinutes(clinic.start), timeToMinutes(ph.start));
        const end = Math.min(timeToMinutes(clinic.end), timeToMinutes(ph.end));
        while (cursor < end) {
          if (!chance(density)) {
            cursor += 30;
            continue;
          }
          const sKey = weighted(serviceWeights[pr.key]);
          const svc = svcByKey[sKey];
          if (cursor + svc.dur > end) {
            cursor += 15;
            continue;
          }
          const blockS = cursor - svc.before;
          const blockE = cursor + svc.dur + svc.after;
          if (overlaps(roomBusy.get(pracBusyKey(date, pr.key)), blockS, blockE)) {
            cursor += 15;
            continue;
          }
          const room = svc.rooms.find((r) => !overlaps(roomBusy.get(`${date}|r${r}`), blockS, blockE));
          const device = svc.devices.length ? svc.devices.find((d) => !overlaps(roomBusy.get(`${date}|d${d}`), blockS, blockE)) : undefined;
          if (!room || (svc.devices.length && !device)) {
            cursor += 15;
            continue;
          }
          const startIso = iso(date, minutesToTime(cursor));
          const endIso = addMin(startIso, svc.dur);
          const startMs = new Date(startIso).getTime();
          const endMs = new Date(endIso).getTime();
          const happensBeforeNow = endMs <= nowMs;

          // Choose a patient: package holders due a session first, otherwise anyone suitable.
          const eligible = (p: PatientState) =>
            p.created <= date &&
            !overlaps(p.busy.get(date), cursor - 30, cursor + svc.dur + 30) &&
            (!(happensBeforeNow || startMs <= nowMs) || p.treatmentConsent) &&
            (!p.lastBySvc.get(sKey) || diffDays(p.lastBySvc.get(sKey)!, date) >= (minGapDays[sKey] ?? 21));
          let pkg: PkgState | undefined;
          let patient: PatientState | undefined;
          const pkgCandidates = pkgs.filter(
            (k) =>
              (k.remaining.get(sKey) ?? 0) - (k.reserved.get(sKey) ?? 0) > 0 &&
              k.purchase <= date &&
              k.expiry >= date &&
              eligible(patientById.get(k.patientId)!),
          );
          if (pkgCandidates.length && chance(0.8)) {
            pkg = pick(pkgCandidates);
            patient = patientById.get(pkg!.patientId);
          } else {
            const pool = patients.filter((p) => eligible(p));
            if (!pool.length) {
              cursor += 15;
              continue;
            }
            patient = pick(pool);
            pkg = pkgs.find((k) => k.patientId === patient!.id && (k.remaining.get(sKey) ?? 0) - (k.reserved.get(sKey) ?? 0) > 0 && k.purchase <= date && k.expiry >= date);
          }
          if (!patient) {
            cursor += 15;
            continue;
          }
          // Some patients buy a package at their visit (past or today only).
          const tplKey = templateFor[sKey];
          if (!pkg && tplKey && daysAhead <= 0 && happensBeforeNow && chance(0.35)) {
            pkg = sellPackage(patient, tplKey, date, startIso, pr.key);
          }

          // Determine status and timeline.
          let status: string;
          if (daysAhead < 0) status = weighted([['completed', 86], ['cancelled', 8], ['no_show', 6]]);
          else if (daysAhead === 0) {
            if (endMs <= nowMs) status = chance(0.94) ? 'completed' : 'no_show';
            else if (startMs <= nowMs) status = todayHasProgress.inTreatment < 2 ? 'in_treatment' : 'arrived';
            else if (startMs - nowMs <= 40 * 60000 && todayHasProgress.arrived < 3) status = 'arrived';
            else status = chance(0.7) ? 'confirmed' : 'booked';
          } else status = daysAhead <= 2 ? weighted([['confirmed', 65], ['booked', 30], ['cancelled', 5]]) : weighted([['booked', 82], ['confirmed', 13], ['cancelled', 5]]);
          if (pkg && status !== 'completed' && status !== 'cancelled' && status !== 'no_show' && status !== 'in_treatment') {
            pkg.reserved.set(sKey, (pkg.reserved.get(sKey) ?? 0) + 1);
          }
          if (status === 'in_treatment') todayHasProgress.inTreatment++;
          if (status === 'arrived') todayHasProgress.arrived++;

          const bookedDaysBefore = int(1, 14);
          let createdAt = iso(addDays(date, -bookedDaysBefore), `${String(int(10, 18)).padStart(2, '0')}:${pick(['10', '25', '40', '55'])}`);
          if (createdAt < iso(patient.created, '00:00')) createdAt = addMin(iso(patient.created, '00:00'), 600);
          if (new Date(createdAt).getTime() > nowMs) createdAt = new Date(nowMs - int(10, 600) * 60000).toISOString();
          const createdBy = pick([userId.rec1, userId.rec2]);
          const pracUser = userId[pr.user];
          let arrivedAt: string | null = null;
          let startedAt: string | null = null;
          let completedAt: string | null = null;
          let cancelledAt: string | null = null;
          let cancelReason: string | null = null;
          if (status === 'completed' || status === 'in_treatment') {
            arrivedAt = addMin(startIso, -int(2, 15));
            startedAt = addMin(startIso, int(0, 6));
            if (status === 'completed') completedAt = addMin(endIso, -int(0, 5));
          } else if (status === 'arrived') {
            arrivedAt = new Date(Math.min(nowMs - int(1, 20) * 60000, startMs)).toISOString();
          } else if (status === 'cancelled') {
            const hoursBefore = chance(0.35) ? int(2, 20) : int(26, 96);
            cancelledAt = new Date(Math.max(new Date(createdAt).getTime() + 3600_000, startMs - hoursBefore * 3600_000)).toISOString();
            if (new Date(cancelledAt).getTime() > nowMs) cancelledAt = new Date(nowMs - int(5, 300) * 60000).toISOString();
            cancelReason = pick(cancelReasons);
          } else if (status === 'no_show') {
            cancelledAt = new Date(Math.min(new Date(endIso).getTime() + 30 * 60000, nowMs - 60000)).toISOString();
            cancelReason = 'Did not attend; no answer to call';
          }

          const linkPkg = pkg && status !== 'cancelled' && status !== 'no_show' ? pkg : pkg && chance(0.6) ? pkg : undefined;
          let apptId: number;
          try {
            apptId = run(
              `INSERT INTO appointments(patient_id, service_id, practitioner_id, room_id, device_id, start_at, end_at, block_start, block_end, buffer_before_min, buffer_after_min,
                 status, purchased_package_id, notes, arrived_at, started_at, completed_at, cancelled_at, cancel_reason, created_by, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                patient.id,
                svcId[sKey],
                pracId[pr.key],
                roomId[room],
                device ? deviceId[device] : null,
                startIso,
                endIso,
                addMin(startIso, -svc.before),
                addMin(endIso, svc.after),
                svc.before,
                svc.after,
                status,
                linkPkg?.id ?? null,
                chance(0.08) ? pick(['Running 10 minutes late — called ahead', 'First visit — allow time for forms', 'Requested Dr. at last visit']) : null,
                arrivedAt,
                startedAt,
                completedAt,
                cancelledAt,
                cancelReason,
                createdBy,
                createdAt,
                cancelledAt ?? completedAt ?? createdAt,
              ],
            ).id;
          } catch {
            cursor += 15;
            continue;
          }
          mark(roomBusy, pracBusyKey(date, pr.key), blockS, blockE);
          mark(roomBusy, `${date}|r${room}`, blockS, blockE);
          if (device) mark(roomBusy, `${date}|d${device}`, blockS, blockE);
          mark(patient.busy, date, cursor, cursor + svc.dur);

          const event = (kind: string, from: string | null, to: string | null, at: string, by: number, reason: string | null = null) =>
            run('INSERT INTO appointment_events(appointment_id, kind, from_status, to_status, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?)', [apptId, kind, from, to, reason, by, at]);
          event('created', null, 'booked', createdAt, createdBy);
          if (['confirmed', 'arrived', 'in_treatment', 'completed'].includes(status) && chance(0.6)) event('status', 'booked', 'confirmed', addMin(createdAt, 60 * int(2, 40)), createdBy);
          if (arrivedAt) event('status', 'confirmed', 'arrived', arrivedAt, pick([userId.rec1, userId.rec2]));
          if (startedAt) event('status', 'arrived', 'in_treatment', startedAt, pracUser);
          if (completedAt) event('status', 'in_treatment', 'completed', completedAt, pracUser);
          if (cancelledAt) event('status', 'booked', status, cancelledAt, createdBy, cancelReason);

          // Deposits (non-package services that require one)
          let inv: InvSpec | undefined;
          if (!linkPkg && svc.deposit > 0 && (status !== 'completed' || chance(0.6)) && chance(status === 'booked' || status === 'confirmed' ? 0.55 : 0.6)) {
            inv = serviceInvoice(patient.id, apptId, sKey, createdAt, createdBy);
            payments.push({ inv, amount: EGP(svc.deposit), method: randomMethod(), kind: 'deposit', at: addMin(createdAt, 20), by: createdBy, refunds: [] });
            if (status === 'cancelled' || status === 'no_show') {
              const late = status === 'no_show' || new Date(startIso).getTime() - new Date(cancelledAt!).getTime() < 24 * 3600_000;
              if (late) {
                inv.adjustments.push({ amount: -(EGP(svc.price) - EGP(svc.deposit)), reason: `Deposit retained as ${status === 'no_show' ? 'no-show' : 'cancellation'} fee (policy)`, at: cancelledAt!, by: createdBy });
              } else {
                payments[payments.length - 1].refunds.push({ amount: EGP(svc.deposit), reason: 'Deposit refunded: cancelled with notice', at: addMin(cancelledAt!, 30), by: userId.acc });
                inv.voided = { at: addMin(cancelledAt!, 31), by: userId.acc, reason: 'Appointment cancelled — deposit refunded' };
              }
            }
          }

          if (status === 'completed' || status === 'in_treatment') {
            const ndef = notes[svc.kind];
            const devName = device ? DEVICES.find((d) => d.key === device)!.name : '';
            const completed = status === 'completed';
            const sessionId = run(
              `INSERT INTO treatment_sessions(appointment_id, patient_id, practitioner_id, service_id, status, body_areas, assessment, treatment_notes, device_id, device_settings,
                 aftercare, follow_up_plan, follow_up_date, purchased_package_id, treatment_plan_id, created_by, created_at, updated_by, updated_at, completed_by, completed_at, completion_key)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                apptId,
                patient.id,
                pracId[pr.key],
                svcId[sKey],
                completed ? 'completed' : 'draft',
                JSON.stringify(svc.areas),
                ndef.assessment(patient.skin),
                completed ? pick(ndef.treatment) : null,
                device ? deviceId[device] : null,
                JSON.stringify(completed ? ndef.settings(devName) : []),
                completed ? aftercareText[svc.kind] || null : null,
                completed && svc.followUpDays ? `Review response in ${svc.followUpDays} days.` : null,
                completed && svc.followUpDays ? addDays(date, svc.followUpDays) : null,
                linkPkg?.id ?? null,
                linkPkg?.planId ?? null,
                pracUser,
                startedAt,
                pracUser,
                completedAt ?? startedAt,
                completed ? pracUser : null,
                completedAt,
                completed ? key() : null,
              ],
            ).id;
            if (completed) {
              patient.lastBySvc.set(sKey, date);
              for (const [sku, qty] of svc.consumables) {
                const b = takeStock(sku, qty, date);
                if (!b) continue;
                const cid = run('INSERT INTO session_consumables(session_id, item_id, batch_id, quantity) VALUES (?,?,?,?)', [sessionId, itemId[sku], b.id, qty]).id;
                run(
                  "INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, session_id, session_consumable_id, created_by, created_at) VALUES (?,?, 'usage', ?, ?, ?, ?, ?, ?)",
                  [itemId[sku], b.id, -qty, `Session #${sessionId}`, sessionId, cid, pracUser, completedAt],
                );
              }
              if (linkPkg) {
                run(
                  "INSERT INTO package_usage(purchased_package_id, service_id, delta, kind, session_id, appointment_id, created_by, created_at) VALUES (?,?, -1, 'consume', ?, ?, ?, ?)",
                  [linkPkg.id, svcId[sKey], sessionId, apptId, pracUser, completedAt],
                );
                linkPkg.remaining.set(sKey, (linkPkg.remaining.get(sKey) ?? 0) - 1);
              } else if (svc.price > 0) {
                inv = inv ?? serviceInvoice(patient.id, apptId, sKey, completedAt!, pick([userId.rec1, userId.rec2]));
                const deposit = payments.filter((p) => p.inv === inv).reduce((s, p) => s + p.amount, 0);
                const due = EGP(svc.price) - deposit;
                const outstanding = daysAhead >= -3 ? chance(0.25) : chance(0.06);
                if (due > 0 && !outstanding) payments.push({ inv, amount: due, method: randomMethod(), kind: 'payment', at: addMin(completedAt!, 8), by: pick([userId.rec1, userId.rec2]), refunds: [] });
                else if (due > 0 && chance(0.4)) payments.push({ inv, amount: Math.round(due / 2 / 100) * 100, method: 'cash', kind: 'payment', at: addMin(completedAt!, 8), by: userId.rec1, refunds: [] });
              }
              if (svc.followUpDays) followUps.push({ patientId: patient.id, sessionId, serviceKey: sKey, due: addDays(date, svc.followUpDays), by: pracUser, at: completedAt! });
              sessionsForPhotos.push({ patientId: patient.id, sessionId, serviceKey: sKey, date });
            }
          }
          cursor = Math.ceil((cursor + svc.dur + svc.after + 10) / 15) * 15;
        }
      }
    }

    function serviceInvoice(patientId: number, apptId: number, sKey: string, at: string, by: number): InvSpec {
      const svc = svcByKey[sKey];
      const inv: InvSpec = {
        patientId,
        kind: 'service',
        appointmentId: apptId,
        lines: [{ description: svc.en, serviceId: svcId[sKey], quantity: 1, unitPrice: EGP(svc.price), discount: 0 }],
        issueDate: zonedParts(at, TZ).date,
        createdAt: at,
        createdBy: by,
        adjustments: [],
      };
      invoices.push(inv);
      return inv;
    }

    function sellPackage(patient: PatientState, tplKey: string, date: string, visitIso: string, pracKey: string): PkgState {
      const tpl = PACKAGES.find((p) => p.key === tplKey)!;
      const at = addMin(visitIso, -25);
      const by = pick([userId.rec1, userId.rec2]);
      const discount = chance(0.15) ? EGP(Math.round((tpl.price * pick([5, 10])) / 100)) : 0;
      const expiry = addDays(date, tpl.validity);
      const id = run(
        `INSERT INTO purchased_packages(patient_id, template_id, name_en, name_ar, price, discount, purchase_date, start_date, expiry_date, terms_en, terms_ar, status, created_by, created_at, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?,?)`,
        [patient.id, tplId[tplKey], tpl.en, tpl.ar, EGP(tpl.price), discount, date, date, expiry, PACKAGE_TERMS_EN, PACKAGE_TERMS_AR, by, at, key()],
      ).id;
      for (const [s, q] of tpl.items) run('INSERT INTO purchased_package_items(purchased_package_id, service_id, quantity) VALUES (?,?,?)', [id, svcId[s], q]);
      const total = EGP(tpl.price) - discount;
      const inv: InvSpec = {
        patientId: patient.id,
        kind: 'package',
        appointmentId: null,
        lines: [{ description: `Package: ${tpl.en}`, packageTemplateId: tplId[tplKey], quantity: 1, unitPrice: EGP(tpl.price), discount }],
        issueDate: date,
        createdAt: at,
        createdBy: discount ? userId.owner : by,
        discountReason: discount ? 'Loyalty discount approved by owner' : undefined,
        adjustments: [],
        packageId: id,
      };
      invoices.push(inv);
      if (chance(0.55)) {
        payments.push({ inv, amount: total, method: randomMethod(), kind: 'payment', at: addMin(at, 5), by, refunds: [] });
      } else {
        const n = 3;
        const base = Math.floor(total / n / 100) * 100;
        inv.installments = Array.from({ length: n }, (_, i) => ({ due: addDays(date, 30 * i), amount: i === n - 1 ? total - base * (n - 1) : base }));
        inv.installments.forEach((ins, i) => {
          const payDate = addDays(ins.due, i === 0 ? 0 : int(-2, 6));
          if (payDate > today || (i > 0 && chance(0.18))) return;
          const at2 = i === 0 ? addMin(at, 5) : iso(payDate, `${String(int(11, 18)).padStart(2, '0')}:15`);
          payments.push({ inv, amount: ins.amount, method: randomMethod(), kind: 'payment', at: at2, by: pick([userId.rec1, userId.rec2, userId.acc]), refunds: [] });
        });
      }
      let planId: number | null = null;
      const firstSvc = tpl.items[0][0];
      if (SERVICES.find((s) => s.key === firstSvc)!.kind === 'laser' || firstSvc === 'rf') {
        planId = run(
          `INSERT INTO treatment_plans(patient_id, title, service_id, body_areas, planned_sessions, interval_weeks, goals, notes, status, created_by, created_at, updated_by, updated_at)
           VALUES (?,?,?,?,?,?,?,?, 'active', ?,?,?,?)`,
          [
            patient.id,
            firstSvc === 'rf' ? 'Acne scar improvement — RF microneedling course' : `Laser hair reduction — ${svcByKey[firstSvc].areas[0]?.replace('_', ' ') ?? ''}`,
            svcId[firstSvc],
            JSON.stringify(svcByKey[firstSvc].areas),
            tpl.items[0][1],
            firstSvc === 'rf' ? 4 : 6,
            firstSvc === 'rf' ? 'Improve texture of rolling scars; reassess after course.' : 'Reduce hair density in the treatment area; reassess after the course.',
            null,
            userId[PRACTITIONERS.find((p) => p.key === pracKey)!.user],
            at,
            userId[PRACTITIONERS.find((p) => p.key === pracKey)!.user],
            at,
          ],
        ).id;
      }
      const st: PkgState = { id, patientId: patient.id, tplKey, remaining: new Map(tpl.items.map(([s, q]) => [s, q])), reserved: new Map(), purchase: date, expiry, planId };
      pkgs.push(st);
      return st;
    }

    // Persist financial documents in chronological order so numbering reads naturally.
    invoices.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const inv of invoices) {
      const adj = inv.adjustments.reduce((s, a) => s + a.amount, 0);
      const t = computeInvoiceTotals(inv.lines, 0, adj);
      inv.id = run(
        `INSERT INTO invoices(number, patient_id, appointment_id, kind, status, issue_date, subtotal, discount_total, tax_rate, tax, adjustments_total, total, discount_reason,
           created_by, created_at, voided_by, voided_at, void_reason, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`,
        [
          nextNumber('invoice', 'INV', Number(inv.issueDate.slice(0, 4))),
          inv.patientId,
          inv.appointmentId,
          inv.kind,
          inv.voided ? 'void' : 'issued',
          inv.issueDate,
          t.subtotal,
          t.discountTotal,
          t.tax,
          adj,
          t.total,
          inv.discountReason ?? null,
          inv.createdBy,
          inv.createdAt,
          inv.voided?.by ?? null,
          inv.voided?.at ?? null,
          inv.voided?.reason ?? null,
          key(),
        ],
      ).id;
      for (const l of inv.lines) {
        run('INSERT INTO invoice_items(invoice_id, description, service_id, package_template_id, quantity, unit_price, discount, line_total) VALUES (?,?,?,?,?,?,?,?)', [
          inv.id,
          l.description,
          l.serviceId ?? null,
          l.packageTemplateId ?? null,
          l.quantity,
          l.unitPrice,
          l.discount,
          lineTotal(l),
        ]);
      }
      for (const a of inv.adjustments) run('INSERT INTO invoice_adjustments(invoice_id, amount, reason, created_by, created_at) VALUES (?,?,?,?,?)', [inv.id, a.amount, a.reason, a.by, a.at]);
      inv.installments?.forEach((ins, i) => run('INSERT INTO invoice_installments(invoice_id, seq, due_date, amount) VALUES (?,?,?,?)', [inv.id, i + 1, ins.due, ins.amount]));
      if (inv.packageId) run('UPDATE purchased_packages SET invoice_id = ? WHERE id = ?', [inv.id, inv.packageId]);
    }
    payments.sort((a, b) => a.at.localeCompare(b.at));
    for (const p of payments) {
      if (new Date(p.at).getTime() > nowMs) p.at = new Date(nowMs - 60000).toISOString();
      p.id = run('INSERT INTO payments(number, invoice_id, patient_id, amount, method, reference, kind, received_at, received_by, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)', [
        nextNumber('receipt', 'RCT', Number(p.at.slice(0, 4))),
        p.inv.id,
        p.inv.patientId,
        p.amount,
        p.method,
        p.method === 'card' ? `POS-${int(100000, 999999)}` : p.method === 'bank_transfer' ? `TRF-${int(10000, 99999)}` : null,
        p.kind,
        p.at,
        p.by,
        key(),
      ]).id;
    }
    const refunds = payments.flatMap((p) => p.refunds.map((r) => ({ ...r, p })));
    refunds.sort((a, b) => a.at.localeCompare(b.at));
    for (const r of refunds) {
      run('INSERT INTO refunds(number, payment_id, invoice_id, patient_id, amount, method, reason, created_by, created_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)', [
        nextNumber('refund', 'RFD', Number(r.at.slice(0, 4))),
        r.p.id,
        r.p.inv.id,
        r.p.inv.patientId,
        r.amount,
        r.p.method,
        r.reason,
        r.by,
        r.at,
        key(),
      ]);
    }

    // Follow-ups and logged contacts --------------------------------------------------------
    for (const f of followUps) {
      const open = f.due >= addDays(today, -6) || (f.due >= addDays(today, -30) && chance(0.15));
      const fid = run(
        'INSERT INTO follow_ups(patient_id, session_id, service_id, due_date, status, created_by, created_at, closed_by, closed_at, close_note) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
          f.patientId,
          f.sessionId,
          svcId[f.serviceKey],
          f.due,
          open ? 'open' : 'done',
          f.by,
          f.at,
          open ? null : userId.rec1,
          open ? null : iso(f.due, '15:00'),
          open ? null : 'Called — patient doing well',
        ],
      ).id;
      if (!open) {
        run("INSERT INTO communications(patient_id, channel, follow_up_id, body, outcome, created_by, created_at) VALUES (?, 'phone', ?, ?, 'contacted_manually', ?, ?)", [
          f.patientId,
          fid,
          'Post-treatment check-in call.',
          userId.rec1,
          iso(f.due, '15:00'),
        ]);
      }
    }

    // Clinical photos (synthetic placeholders) ------------------------------------------------
    const skinTones: Record<string, string> = { II: '#e8c4a8', III: '#d9a989', IV: '#c08a64', V: '#9a6a48' };
    const byPatientSvc = new Map<string, typeof sessionsForPhotos>();
    for (const s of sessionsForPhotos) {
      const k = `${s.patientId}|${s.serviceKey}`;
      byPatientSvc.set(k, [...(byPatientSvc.get(k) ?? []), s]);
    }
    let photoSets = 0;
    for (const [, list] of byPatientSvc) {
      if (photoSets >= 9 || list.length < 2) continue;
      const p = patientById.get(list[0].patientId)!;
      if (!p.photoConsent) continue;
      const svc = svcByKey[list[0].serviceKey];
      if (!svc.areas.length || svc.kind === 'consult') continue;
      const consentId = scalar<number>("SELECT id FROM consents WHERE patient_id = ? AND type = 'clinical_photography' ORDER BY id DESC LIMIT 1", [p.id]);
      const shots = [
        { s: list[0], kind: 'before', stage: 0 },
        ...(list.length > 2 ? [{ s: list[Math.floor(list.length / 2)], kind: 'progress', stage: 1 }] : []),
        { s: list[list.length - 1], kind: 'after', stage: 2 },
      ];
      for (const shot of shots) {
        const svg = demoPhotoSvg(svc.areas[0], shot.stage, skinTones[p.skin] ?? '#d9a989', shot.s.date);
        const f = writeUpload('photos', '.svg', svg);
        const by = scalar<number>('SELECT completed_by FROM treatment_sessions WHERE id = ?', [shot.s.sessionId]);
        run(
          `INSERT INTO photos(patient_id, session_id, body_area, kind, taken_on, file_name, mime, size, sha256, notes, consent_id, uploaded_by, uploaded_at)
           VALUES (?,?,?,?,?,?, 'image/svg+xml', ?,?,?,?,?,?)`,
          [p.id, shot.s.sessionId, svc.areas[0], shot.kind, shot.s.date, f.fileName, f.size, f.sha256, 'Standard position, same lighting set-up', consentId, by, iso(shot.s.date, '17:00')],
        );
      }
      photoSets++;
    }

    // Documents --------------------------------------------------------------------------------
    for (const p of patients.slice(0, 6)) {
      const ref = writeUpload('documents', '.pdf', minimalPdf(['Referral letter (DEMO — fictional)', '', 'Referred for assessment of facial acne scarring.', 'This document is synthetic demo content.']));
      run("INSERT INTO documents(patient_id, title, category, clinical, file_name, original_name, mime, size, sha256, uploaded_by, uploaded_at) VALUES (?, 'Referral letter', 'referral', 1, ?, 'referral.pdf', 'application/pdf', ?, ?, ?, ?)", [
        p.id,
        ref.fileName,
        ref.size,
        ref.sha256,
        userId.nour,
        iso(addDays(today, -int(10, 90)), '12:00'),
      ]);
      const idDoc = writeUpload('documents', '.pdf', minimalPdf(['Signed consent form scan (DEMO — fictional)', '', 'Synthetic placeholder for a scanned paper form.']));
      run("INSERT INTO documents(patient_id, title, category, clinical, file_name, original_name, mime, size, sha256, uploaded_by, uploaded_at) VALUES (?, 'Signed consent form (scan)', 'consent_scan', 0, ?, 'consent-scan.pdf', 'application/pdf', ?, ?, ?, ?)", [
        p.id,
        idDoc.fileName,
        idDoc.size,
        idDoc.sha256,
        userId.rec1,
        iso(addDays(today, -int(10, 90)), '12:30'),
      ]);
    }

    // Stock situations worth seeing on the dashboard ---------------------------------------------
    receive('NUM-CRM', 90, addDays(today, -10), addDays(today, 35));
    receive('HYD-SOL', 1000, addDays(today, -12), addDays(today, 50));
    const rf = batches.filter((b) => b.sku === 'RF-CART' && b.onHand > 0 && (!b.expiry || b.expiry >= today));
    const rfOnHand = rf.reduce((s, b) => s + b.onHand, 0);
    if (rfOnHand > 5 && rf.length) {
      const b = rf[rf.length - 1];
      const waste = Math.min(b.onHand, rfOnHand - 5);
      run("INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, created_by, created_at) VALUES (?,?, 'waste', ?, 'Sterile packaging damaged in storage', ?, ?)", [
        itemId['RF-CART'],
        b.id,
        -waste,
        userId.owner,
        iso(addDays(today, -3), '10:00'),
      ]);
      b.onHand -= waste;
    }
    run("INSERT INTO stock_movements(item_id, batch_id, type, quantity, reason, created_by, created_at) VALUES (?,?, 'waste', -2, 'Dropped / contaminated', ?, ?)", [
      itemId['HYD-TIP'],
      batches.find((b) => b.sku === 'HYD-TIP' && b.onHand > 4)!.id,
      userId.salma,
      iso(addDays(today, -8), '16:00'),
    ]);

    // Expenses -------------------------------------------------------------------------------------
    const months = new Set<string>();
    for (let m = 0; m <= Math.ceil(HISTORY_DAYS / 28); m++) months.add(`${addDays(today, -m * 28).slice(0, 7)}-01`);
    for (const monthStart of months) {
      if (monthStart < addDays(startDay, -10) || monthStart > today) continue;
      expenses.push({ date: monthStart, category: 'rent', description: `Clinic rent ${monthStart.slice(0, 7)}`, vendor: 'Demo Properties LLC', amount: EGP(45000), method: 'bank_transfer' });
      expenses.push({ date: addDays(monthStart, 24) <= today ? addDays(monthStart, 24) : monthStart, category: 'salaries', description: `Payroll ${monthStart.slice(0, 7)}`, vendor: null, amount: EGP(168000), method: 'bank_transfer' });
      expenses.push({ date: addDays(monthStart, 9) <= today ? addDays(monthStart, 9) : monthStart, category: 'utilities', description: 'Electricity & water', vendor: 'Utility provider (demo)', amount: EGP(int(6200, 8400)), method: 'card' });
      expenses.push({ date: addDays(monthStart, 4) <= today ? addDays(monthStart, 4) : monthStart, category: 'marketing', description: 'Social media advertising', vendor: 'Ad platform (demo)', amount: EGP(int(8000, 14000)), method: 'card' });
    }
    expenses.push({ date: addDays(today, -47), category: 'maintenance', description: 'Laser unit annual service', vendor: 'Device service partner (demo)', amount: EGP(18500), method: 'bank_transfer' });
    expenses.sort((a, b) => a.date.localeCompare(b.date));
    for (const e of expenses) {
      if (e.date > today) continue;
      run('INSERT INTO expenses(date, category, description, vendor, amount, method, created_by, created_at, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)', [
        e.date,
        e.category,
        e.description,
        e.vendor,
        e.amount,
        e.method,
        userId.acc,
        iso(e.date, '16:00'),
        key(),
      ]);
    }
    run("INSERT INTO audit_events(at, user_id, action, summary, sensitive) VALUES (?, NULL, 'demo.seed', 'Fictional demo data loaded', 0)", [nowIsoStr]);
  });
  invalidateSettings();
}

export function resetDemoData(): void {
  closeDb();
  for (const f of ['clinic.db', 'clinic.db-wal', 'clinic.db-shm']) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  openDb();
  seedDemo();
}
