import { all } from '../db/db.js';
import { getSettings } from '../settings.js';
import { BLOCKING_STATUSES } from '../../shared/domain.js';
import { addDays, minutesToTime, timeToMinutes, weekdayOf, zonedParts, zonedToUtc } from '../../shared/time.js';
import {
  getDevice,
  getPractitioner,
  getRoom,
  getService,
  listDevices,
  listPractitioners,
  listRooms,
  type Practitioner,
  type Service,
} from './reference.js';

export interface SlotRequest {
  serviceId: number;
  practitionerId: number;
  roomId: number;
  deviceId: number | null;
  date: string;
  time: string;
  patientId?: number | null;
  excludeAppointmentId?: number | null;
}

export interface Issue {
  code: string;
  message: string;
  params: Record<string, string | number>;
}

export interface SlotTimes {
  start: string;
  end: string;
  blockStart: string;
  blockEnd: string;
}

interface BusyBlock {
  id: number;
  patient_id: number;
  service_id: number;
  practitioner_id: number;
  room_id: number;
  device_id: number | null;
  block_start: string;
  block_end: string;
  start_at: string;
  end_at: string;
  service_name: string;
}

interface TimeOffBlock {
  id: number;
  practitioner_id: number;
  start_at: string;
  end_at: string;
  all_day: number;
}

/** Bookings and time off loaded once for a window, so slot searches do not query per candidate. */
interface Preloaded {
  busy: BusyBlock[];
  timeOff: TimeOffBlock[];
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function slotTimes(service: Service, date: string, time: string, tz: string): SlotTimes {
  const start = zonedToUtc(date, time, tz);
  const end = new Date(start.getTime() + service.durationMin * 60000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    blockStart: new Date(start.getTime() - service.bufferBeforeMin * 60000).toISOString(),
    blockEnd: new Date(end.getTime() + service.bufferAfterMin * 60000).toISOString(),
  };
}

function loadBusy(fromIso: string, toIso: string): BusyBlock[] {
  const placeholders = BLOCKING_STATUSES.map(() => '?').join(',');
  return all<BusyBlock>(
    `SELECT a.id, a.patient_id, a.service_id, a.practitioner_id, a.room_id, a.device_id, a.block_start, a.block_end, a.start_at, a.end_at,
            s.name_en AS service_name
       FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE a.status IN (${placeholders}) AND a.block_start < ? AND a.block_end > ?`,
    [...BLOCKING_STATUSES, toIso, fromIso],
  );
}

function loadTimeOff(fromIso: string, toIso: string): TimeOffBlock[] {
  return all<TimeOffBlock>(
    'SELECT id, practitioner_id, start_at, end_at, all_day FROM practitioner_time_off WHERE cancelled_at IS NULL AND start_at < ? AND end_at > ? ORDER BY start_at',
    [toIso, fromIso],
  );
}

function preload(fromIso: string, toIso: string): Preloaded {
  return { busy: loadBusy(fromIso, toIso), timeOff: loadTimeOff(fromIso, toIso) };
}

const localTime = (iso: string, tz: string) => zonedParts(iso, tz).time;

/** Clinic-local start and (inclusive) end of a time-off period; an all-day period ends at the next midnight. */
export function timeOffLocal(o: { start_at: string; end_at: string; all_day: number | boolean }, tz: string) {
  const from = zonedParts(o.start_at, tz);
  const to = zonedParts(o.all_day ? new Date(new Date(o.end_at).getTime() - 60000) : o.end_at, tz);
  return { startDate: from.date, endDate: to.date, startTime: from.time, endTime: o.all_day ? '24:00' : to.time };
}

/** Evaluate a requested slot. Returns every reason it cannot be booked (empty = bookable). */
export function evaluateSlot(req: SlotRequest, preloaded?: Preloaded): { issues: Issue[]; times: SlotTimes | null } {
  const settings = getSettings();
  const tz = settings.timezone;
  const issues: Issue[] = [];
  const add = (code: string, message: string, params: Record<string, string | number> = {}) => issues.push({ code, message, params });

  const service = getService(req.serviceId);
  const practitioner = getPractitioner(req.practitionerId);
  const room = getRoom(req.roomId);
  const device = req.deviceId ? getDevice(req.deviceId) : null;
  if (!service) return { issues: [{ code: 'SERVICE_NOT_FOUND', message: 'Service not found.', params: {} }], times: null };
  if (!practitioner) return { issues: [{ code: 'PRACTITIONER_NOT_FOUND', message: 'Practitioner not found.', params: {} }], times: null };
  if (!room) return { issues: [{ code: 'ROOM_NOT_FOUND', message: 'Room not found.', params: {} }], times: null };

  // Messages name records in English; the ids let the UI show the localized names instead.
  const svcName = service.nameEn;
  const svc = { service: svcName, serviceId: service.id };
  const prac = { practitioner: practitioner.displayName, practitionerId: practitioner.id };
  const rm = { room: room.name, roomId: room.id };
  if (!service.active) add('SERVICE_INACTIVE', `${svcName} is inactive and cannot be booked.`, svc);
  if (!practitioner.active) add('PRACTITIONER_INACTIVE', `${practitioner.displayName} is not active.`, prac);
  if (service.qualification && !practitioner.qualifications.includes(service.qualification)) {
    add('PRACTITIONER_UNQUALIFIED', `${practitioner.displayName} does not hold the qualification required for ${svcName}.`, {
      ...prac,
      ...svc,
      qualification: service.qualification,
    });
  }
  if (!room.active) add('ROOM_INACTIVE', `${room.name} is not in use.`, rm);
  if (service.roomIds.length && !service.roomIds.includes(room.id)) {
    add('ROOM_NOT_SUITABLE', `${room.name} is not set up for ${svcName}.`, { ...rm, ...svc });
  }
  if (service.deviceIds.length) {
    if (!device) {
      add('DEVICE_REQUIRED', `${svcName} requires a device.`, svc);
    } else if (!service.deviceIds.includes(device.id)) {
      add('DEVICE_NOT_SUITABLE', `${device.name} cannot be used for ${svcName}.`, { device: device.name, deviceId: device.id, ...svc });
    }
  }
  if (device && !device.active) add('DEVICE_INACTIVE', `${device.name} is out of service.`, { device: device.name, deviceId: device.id });

  const times = slotTimes(service, req.date, req.time, tz);
  const startMin = timeToMinutes(req.time);
  const endMin = startMin + service.durationMin;
  const wd = weekdayOf(req.date);
  const clinicDay = settings.openingHours[wd];
  const fromStr = req.time;
  const toStr = minutesToTime(endMin % 1440);

  if (!clinicDay?.open) {
    add('CLINIC_CLOSED', `The clinic is closed on ${WEEKDAY_NAMES[wd]}.`, { weekday: wd });
  } else if (startMin < timeToMinutes(clinicDay.start) || endMin > timeToMinutes(clinicDay.end)) {
    add('OUTSIDE_CLINIC_HOURS', `The clinic is open ${clinicDay.start}–${clinicDay.end}; this booking would run ${fromStr}–${toStr}.`, {
      start: clinicDay.start,
      end: clinicDay.end,
      from: fromStr,
      to: toStr,
    });
  }
  const pDay = practitioner.hours[wd];
  if (!pDay?.open) {
    add('PRACTITIONER_NOT_WORKING', `${practitioner.displayName} does not work on ${WEEKDAY_NAMES[wd]}.`, { ...prac, weekday: wd });
  } else if (startMin < timeToMinutes(pDay.start) || endMin > timeToMinutes(pDay.end)) {
    add('OUTSIDE_PRACTITIONER_HOURS', `${practitioner.displayName} works ${pDay.start}–${pDay.end} on this day.`, { ...prac, start: pDay.start, end: pDay.end });
  }
  // Time off is checked against the treatment time, like working hours (buffers are room/device preparation).
  const off = (preloaded?.timeOff ?? loadTimeOff(times.start, times.end)).find(
    (o) => o.practitioner_id === practitioner.id && o.start_at < times.end && o.end_at > times.start,
  );
  if (off) {
    const l = timeOffLocal(off, tz);
    const period = off.all_day ? (l.startDate === l.endDate ? l.startDate : `${l.startDate} to ${l.endDate}`) : `${l.startTime}–${l.endTime}`;
    add('PRACTITIONER_TIME_OFF', `${practitioner.displayName} is on time off (${period}).`, {
      ...prac,
      timeOffId: off.id,
      allDay: off.all_day ? 1 : 0,
      ...l,
    });
  }
  if (new Date(times.start).getTime() < Date.now() - 5 * 60000) {
    add('IN_PAST', 'This time has already passed. Choose a future time.', {});
  }

  const busy = (preloaded?.busy ?? loadBusy(times.blockStart, times.blockEnd)).filter(
    (b) => b.id !== req.excludeAppointmentId && b.block_start < times.blockEnd && b.block_end > times.blockStart,
  );
  const buffers = service.bufferBeforeMin + service.bufferAfterMin;
  for (const b of busy) {
    const range = { from: localTime(b.start_at, tz), to: localTime(b.end_at, tz), service: b.service_name, serviceId: b.service_id };
    if (b.practitioner_id === practitioner.id) {
      add(
        'CONFLICT_PRACTITIONER',
        `${practitioner.displayName} is booked ${range.from}–${range.to} (${b.service_name})${buffers ? ', including preparation/cleanup time' : ''}.`,
        { ...prac, ...range, appointmentId: b.id },
      );
    }
    if (b.room_id === room.id) {
      add('CONFLICT_ROOM', `${room.name} is in use ${range.from}–${range.to} (${b.service_name}).`, { ...rm, ...range, appointmentId: b.id });
    }
    if (device && b.device_id === device.id) {
      add('CONFLICT_DEVICE', `${device.name} is in use ${range.from}–${range.to} (${b.service_name}).`, {
        device: device.name,
        deviceId: device.id,
        ...range,
        appointmentId: b.id,
      });
    }
  }
  if (req.patientId) {
    const patientClash = (preloaded?.busy ?? loadBusy(times.start, times.end)).find(
      (b) => b.patient_id === req.patientId && b.id !== req.excludeAppointmentId && b.start_at < times.end && b.end_at > times.start,
    );
    if (patientClash) {
      add('PATIENT_OVERLAP', `The patient already has ${patientClash.service_name} at ${localTime(patientClash.start_at, tz)}.`, {
        service: patientClash.service_name,
        serviceId: patientClash.service_id,
        from: localTime(patientClash.start_at, tz),
      });
    }
  }
  return { issues, times };
}

export interface Alternative {
  date: string;
  time: string;
  practitionerId: number;
  roomId: number;
  deviceId: number | null;
  samePractitioner: boolean;
}

function eligibleResources(service: Service, preferRoom: number | null, preferDevice: number | null) {
  const rooms = listRooms()
    .filter((r) => r.active && (!service.roomIds.length || service.roomIds.includes(r.id)))
    .sort((a, b) => Number(b.id === preferRoom) - Number(a.id === preferRoom));
  const devices = service.deviceIds.length
    ? listDevices()
        .filter((d) => d.active && service.deviceIds.includes(d.id))
        .sort((a, b) => Number(b.id === preferDevice) - Number(a.id === preferDevice))
    : [];
  return { rooms, devices };
}

function qualified(p: Practitioner, service: Service): boolean {
  return p.active && (!service.qualification || p.qualifications.includes(service.qualification));
}

/**
 * Nearest bookable alternatives: same practitioner first (same day, then the following
 * week), then other qualified practitioners near the requested time.
 */
export function findAlternatives(req: SlotRequest, limit = 6): Alternative[] {
  const settings = getSettings();
  const tz = settings.timezone;
  const service = getService(req.serviceId);
  if (!service) return [];
  const step = settings.slotMinutes || 15;
  const { rooms, devices } = eligibleResources(service, req.roomId, req.deviceId);
  if (!rooms.length || (service.deviceIds.length && !devices.length)) return [];
  const practitioners = listPractitioners().filter((p) => qualified(p, service));
  const requested = practitioners.find((p) => p.id === req.practitionerId);
  const others = practitioners.filter((p) => p.id !== req.practitionerId);

  const horizonDays = 8;
  const loaded = preload(zonedToUtc(req.date, '00:00', tz).toISOString(), zonedToUtc(addDays(req.date, horizonDays), '00:00', tz).toISOString());
  const requestedMin = timeToMinutes(req.time);
  const results: Alternative[] = [];
  const seen = new Set<string>();

  const tryPractitioner = (p: Practitioner, date: string, time: string): Alternative | null => {
    for (const room of rooms) {
      const deviceOptions: (number | null)[] = devices.length ? devices.map((d) => d.id) : [null];
      for (const deviceId of deviceOptions) {
        const { issues } = evaluateSlot(
          { ...req, practitionerId: p.id, roomId: room.id, deviceId, date, time },
          loaded,
        );
        if (!issues.length) return { date, time, practitionerId: p.id, roomId: room.id, deviceId, samePractitioner: p.id === req.practitionerId };
      }
    }
    return null;
  };

  const candidateTimes = (date: string, sameDay: boolean): string[] => {
    const day = settings.openingHours[weekdayOf(date)];
    if (!day?.open) return [];
    const times: number[] = [];
    for (let m = timeToMinutes(day.start); m + service.durationMin <= timeToMinutes(day.end); m += step) times.push(m);
    if (sameDay) times.sort((a, b) => Math.abs(a - requestedMin) - Math.abs(b - requestedMin) || a - b);
    return times.map(minutesToTime);
  };

  const collect = (group: Practitioner[], max: number, days: number) => {
    let found = 0;
    for (let d = 0; d < days && found < max; d++) {
      const date = addDays(req.date, d);
      for (const time of candidateTimes(date, d === 0)) {
        if (found >= max) break;
        if (d === 0 && time === req.time && group.some((p) => p.id === req.practitionerId)) continue;
        for (const p of group) {
          const key = `${date} ${time} ${p.id}`;
          if (seen.has(key)) continue;
          const alt = tryPractitioner(p, date, time);
          if (alt) {
            seen.add(key);
            results.push(alt);
            found++;
            break;
          }
        }
      }
    }
  };

  if (requested) collect([requested], Math.ceil(limit / 2), horizonDays);
  collect(others, limit - results.length, 2);
  return results.slice(0, limit);
}

/** Free start times for one practitioner on a date (used by the booking form). */
export function freeSlots(serviceId: number, practitionerId: number, date: string): { time: string; roomId: number; deviceId: number | null }[] {
  const settings = getSettings();
  const tz = settings.timezone;
  const service = getService(serviceId);
  const practitioner = getPractitioner(practitionerId);
  if (!service || !practitioner) return [];
  const { rooms, devices } = eligibleResources(service, null, null);
  const day = settings.openingHours[weekdayOf(date)];
  if (!day?.open) return [];
  const loaded = preload(zonedToUtc(date, '00:00', tz).toISOString(), zonedToUtc(addDays(date, 1), '00:00', tz).toISOString());
  const out: { time: string; roomId: number; deviceId: number | null }[] = [];
  for (let m = timeToMinutes(day.start); m + service.durationMin <= timeToMinutes(day.end); m += settings.slotMinutes || 15) {
    const time = minutesToTime(m);
    search: for (const room of rooms) {
      for (const deviceId of devices.length ? devices.map((d) => d.id) : [null]) {
        const { issues } = evaluateSlot({ serviceId, practitionerId, roomId: room.id, deviceId, date, time }, loaded);
        if (!issues.length) {
          out.push({ time, roomId: room.id, deviceId });
          break search;
        }
      }
    }
  }
  return out;
}
