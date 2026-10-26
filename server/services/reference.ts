import { all, get, parseJson } from '../db/db.js';
import type { WeeklyHours } from '../../shared/domain.js';

export interface Service {
  id: number;
  nameEn: string;
  nameAr: string;
  categoryId: number;
  durationMin: number;
  price: number;
  depositAmount: number;
  qualification: string | null;
  roomIds: number[];
  deviceIds: number[];
  bufferBeforeMin: number;
  bufferAfterMin: number;
  active: boolean;
}

export interface Practitioner {
  id: number;
  userId: number | null;
  displayName: string;
  displayNameAr: string;
  qualifications: string[];
  color: string;
  hours: WeeklyHours;
  active: boolean;
}

export interface Room {
  id: number;
  name: string;
  nameAr: string | null;
  active: boolean;
}

export interface Device {
  id: number;
  name: string;
  nameAr: string | null;
  model: string | null;
  roomId: number | null;
  active: boolean;
  maintenanceNote: string | null;
}

type Row = Record<string, unknown>;

export function mapService(r: Row): Service {
  return {
    id: r.id as number,
    nameEn: r.name_en as string,
    nameAr: r.name_ar as string,
    categoryId: r.category_id as number,
    durationMin: r.duration_min as number,
    price: r.price as number,
    depositAmount: r.deposit_amount as number,
    qualification: (r.qualification as string) ?? null,
    roomIds: parseJson<number[]>(r.room_ids, []),
    deviceIds: parseJson<number[]>(r.device_ids, []),
    bufferBeforeMin: r.buffer_before_min as number,
    bufferAfterMin: r.buffer_after_min as number,
    active: !!r.active,
  };
}

export function mapPractitioner(r: Row): Practitioner {
  return {
    id: r.id as number,
    userId: (r.user_id as number) ?? null,
    displayName: r.display_name as string,
    displayNameAr: r.display_name_ar as string,
    qualifications: parseJson<string[]>(r.qualifications, []),
    color: r.color as string,
    hours: parseJson<WeeklyHours>(r.hours, []),
    active: !!r.active,
  };
}

const mapRoom = (r: Row): Room => ({ id: r.id as number, name: r.name as string, nameAr: (r.name_ar as string) || null, active: !!r.active });
const mapDevice = (r: Row): Device => ({
  id: r.id as number,
  name: r.name as string,
  nameAr: (r.name_ar as string) || null,
  model: (r.model as string) ?? null,
  roomId: (r.room_id as number) ?? null,
  active: !!r.active,
  maintenanceNote: (r.maintenance_note as string) ?? null,
});

export const getService = (id: number) => {
  const r = get('SELECT * FROM services WHERE id = ?', [id]);
  return r ? mapService(r) : undefined;
};
export const listServices = () => all('SELECT * FROM services ORDER BY category_id, name_en').map(mapService);
export const getPractitioner = (id: number) => {
  const r = get('SELECT * FROM practitioners WHERE id = ?', [id]);
  return r ? mapPractitioner(r) : undefined;
};
export const listPractitioners = () => all('SELECT * FROM practitioners ORDER BY display_name').map(mapPractitioner);
export const getRoom = (id: number) => {
  const r = get('SELECT * FROM rooms WHERE id = ?', [id]);
  return r ? mapRoom(r) : undefined;
};
export const listRooms = () => all('SELECT * FROM rooms ORDER BY name').map(mapRoom);
export const getDevice = (id: number) => {
  const r = get('SELECT * FROM devices WHERE id = ?', [id]);
  return r ? mapDevice(r) : undefined;
};
export const listDevices = () => all('SELECT * FROM devices ORDER BY name').map(mapDevice);

export function patientName(id: number): string {
  const p = get<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM patients WHERE id = ?', [id]);
  return p ? `${p.first_name} ${p.last_name}` : `#${id}`;
}
