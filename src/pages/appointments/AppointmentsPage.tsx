import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, CalendarOff, CalendarPlus, ChevronLeft, ChevronRight, Hourglass, List, Rows3, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, EmptyState, ErrorState, Loading, Pagination, Panel, PayBadge, Segmented, StatusBadge } from '@/components/ui';
import { useActions } from '@/layout/actions';
import { ReceptionQueue } from './shared';
import { TimeOffDetailDialog, TimeOffView, offSegment, useTimeOff, useTimeOffText } from './TimeOff';
import { WaitlistView } from './Waitlist';
import type { Appointment, Paged, TimeOff } from '@/lib/types';
import { APPOINTMENT_STATUSES } from '@shared/domain';
import { addDays, minutesToTime, startOfWeek, timeToMinutes, weekdayOf } from '@shared/time';
import type { TKey } from '@/i18n/en';

type View = 'day' | 'week' | 'list' | 'queue' | 'waitlist' | 'timeoff';
const PX_PER_MIN = 1.3;

export function AppointmentsPage() {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { can } = useSession();
  const actions = useActions();
  const isNarrow = typeof window !== 'undefined' && window.innerWidth < 760;
  const [s, set] = useUrlState({
    view: (isNarrow ? 'list' : 'day') as string,
    date: fmt.today(),
    from: '',
    to: '',
    practitionerId: '',
    serviceId: '',
    deviceId: '',
    status: '',
    q: '',
    page: '1',
  });
  const view: View = (['day', 'week', 'list', 'queue', 'waitlist', 'timeoff'] as const).find((v) => v === s.view) ?? 'day';

  const filters = (
    <div className="filters">
      <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('appt.practitioner')} value={s.practitionerId} onChange={(e) => set({ practitionerId: e.target.value, page: '1' })}>
        <option value="">{t('appt.filters.practitioner')}</option>
        {ref.data?.practitioners.map((p) => (
          <option key={p.id} value={p.id}>
            {pick(p.displayName, p.displayNameAr)}
          </option>
        ))}
      </select>
      <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('appt.service')} value={s.serviceId} onChange={(e) => set({ serviceId: e.target.value, page: '1' })}>
        <option value="">{t('appt.filters.service')}</option>
        {ref.data?.services.map((x) => (
          <option key={x.id} value={x.id}>
            {pick(x.nameEn, x.nameAr)}
          </option>
        ))}
      </select>
      <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('appt.device')} value={s.deviceId} onChange={(e) => set({ deviceId: e.target.value, page: '1' })}>
        <option value="">{t('appt.filters.device')}</option>
        {ref.data?.devices.map((d) => (
          <option key={d.id} value={d.id}>
            {pick(d.name, d.nameAr)}
          </option>
        ))}
      </select>
      <select className="select input-sm" style={{ width: 'auto' }} aria-label={t('common.status')} value={s.status} onChange={(e) => set({ status: e.target.value, page: '1' })}>
        <option value="">{t('appt.filters.status')}</option>
        {APPOINTMENT_STATUSES.map((st) => (
          <option key={st} value={st}>
            {t(`status.${st}` as TKey)}
          </option>
        ))}
      </select>
    </div>
  );

  const stepDays = view === 'week' ? 7 : 1;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('appt.title')}</h1>
        <div className="toolbar">
          <Segmented
            label={t('appt.title')}
            value={view}
            onChange={(v) => set({ view: v })}
            options={[
              { id: 'day', label: t('appt.day'), icon: <CalendarDays size={14} /> },
              { id: 'week', label: t('appt.week'), icon: <Rows3 size={14} /> },
              { id: 'list', label: t('appt.list'), icon: <List size={14} /> },
              { id: 'queue', label: t('appt.queue'), icon: <Users size={14} /> },
              { id: 'waitlist', label: t('wl.short'), icon: <Hourglass size={14} /> },
              { id: 'timeoff', label: t('appt.timeOff'), icon: <CalendarOff size={14} /> },
            ]}
          />
          {can('appointments.manage') && (
            <Button variant="primary" icon={<CalendarPlus size={16} />} onClick={() => actions.book({ date: s.date })}>
              {t('appt.new')}
            </Button>
          )}
        </div>
      </div>

      {(view === 'day' || view === 'week') && (
        <div className="row wrap between">
          <div className="row">
            <Button size="sm" icon={<ChevronLeft size={16} className="flip-rtl" />} aria-label={t('common.prev')} onClick={() => set({ date: addDays(s.date, -stepDays) })} />
            <Button size="sm" onClick={() => set({ date: fmt.today() })}>
              {t('common.today')}
            </Button>
            <Button size="sm" icon={<ChevronRight size={16} className="flip-rtl" />} aria-label={t('common.next')} onClick={() => set({ date: addDays(s.date, stepDays) })} />
            <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.date')} value={s.date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
            <strong>{view === 'day' ? fmt.dayLong(s.date) : t('appt.weekOf', { date: fmt.day(startOfWeek(s.date)) })}</strong>
          </div>
          {filters}
        </div>
      )}

      {view === 'day' && <DayView date={s.date} filters={s} />}
      {view === 'week' && <WeekView date={s.date} filters={s} />}
      {view === 'list' && <ListView s={s} set={set} filters={filters} />}
      {view === 'queue' && (
        <Panel title={t('dash.queue')} flush>
          <ReceptionQueue />
        </Panel>
      )}
      {view === 'waitlist' && <WaitlistView />}
      {view === 'timeoff' && <TimeOffView />}
    </div>
  );
}

type Filters = { practitionerId: string; serviceId: string; deviceId: string; status: string };

function useAppointments(from: string, to: string, f: Filters) {
  return useQuery({
    queryKey: ['appointments', from, to, f.practitionerId, f.serviceId, f.deviceId, f.status],
    queryFn: () =>
      api.get<Paged<Appointment>>('/appointments', {
        from,
        to,
        practitionerId: f.practitionerId,
        serviceId: f.serviceId,
        deviceId: f.deviceId,
        status: f.status || 'booked,confirmed,arrived,in_treatment,completed,no_show',
      }),
    refetchInterval: 60_000,
  });
}

function hoursRange(weekdays: number[], openingHours: { open: boolean; start: string; end: string }[]) {
  const open = weekdays.map((w) => openingHours[w]).filter((d) => d?.open);
  if (!open.length) return { start: 9 * 60, end: 18 * 60 };
  return {
    start: Math.floor(Math.min(...open.map((d) => timeToMinutes(d.start))) / 60) * 60,
    end: Math.ceil(Math.max(...open.map((d) => timeToMinutes(d.end))) / 60) * 60,
  };
}

function lanes(items: Appointment[], toMin: (iso: string) => number) {
  const sorted = [...items].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const out = new Map<number, { lane: number; of: number }>();
  let cluster: Appointment[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];
  const flush = () => {
    const of = laneEnds.length || 1;
    for (const a of cluster) out.set(a.id, { ...out.get(a.id)!, of });
    cluster = [];
    laneEnds = [];
  };
  for (const a of sorted) {
    const s = toMin(a.startAt);
    const e = toMin(a.endAt);
    if (s >= clusterEnd && cluster.length) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(e);
    } else laneEnds[lane] = e;
    out.set(a.id, { lane, of: 1 });
    cluster.push(a);
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

function TimeColumn({ start, end }: { start: number; end: number }) {
  const hours: number[] = [];
  for (let m = start; m < end; m += 60) hours.push(m);
  return (
    <div className="cal-times">
      <div className="cal-col-head" />
      <div style={{ position: 'relative', height: (end - start) * PX_PER_MIN }}>
        {hours.map((m) => (
          <div key={m} className="cal-time" style={{ position: 'absolute', top: (m - start) * PX_PER_MIN, insetInlineEnd: 0, width: '100%', transform: m === start ? 'none' : undefined }}>
            {minutesToTime(m)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ApptBlock({ a, top, height, lane, of, showPractitioner }: { a: Appointment; top: number; height: number; lane: number; of: number; showPractitioner?: boolean }) {
  const ref = useRef_();
  const fmt = useFmt();
  const { t } = useI18n();
  const actions = useActions();
  const color = ref.practitionerColor(a.practitionerId);
  const width = 100 / of;
  const label = a.masked ? t('appt.busy') : a.patientName;
  return (
    <>
      {a.bufferBeforeMin > 0 && <div className="cal-buffer" style={{ top: top - a.bufferBeforeMin * PX_PER_MIN, height: a.bufferBeforeMin * PX_PER_MIN, insetInlineStart: `calc(${lane * width}% + 3px)`, width: `calc(${width}% - 6px)` }} />}
      {a.bufferAfterMin > 0 && <div className="cal-buffer" style={{ top: top + height, height: a.bufferAfterMin * PX_PER_MIN, insetInlineStart: `calc(${lane * width}% + 3px)`, width: `calc(${width}% - 6px)` }} />}
      <button
        className={`cal-appt status-${a.status} ${a.masked ? 'masked' : ''}`}
        style={{ top, height: Math.max(height, 20), insetInlineStart: `calc(${lane * width}% + 3px)`, width: `calc(${width}% - 6px)`, borderColor: color, borderInlineStartColor: color }}
        onClick={(e) => {
          e.stopPropagation();
          actions.openAppointment(a.id);
        }}
        aria-label={`${fmt.time(a.startAt)} ${label} · ${ref.serviceName(a.serviceId)} · ${t(`status.${a.status}` as TKey)}`}
      >
        <div className="t">
          {a.noShowRisk && <AlertTriangle size={11} aria-label={t('risk.short')} style={{ color: a.noShowRisk.level === 'high' ? 'var(--danger)' : 'var(--warning)', verticalAlign: '-1px', marginInlineEnd: 2 }} />}
          {fmt.time(a.startAt)} {label}
        </div>
        {height > 34 && <div className="truncate muted">{ref.serviceName(a.serviceId)}</div>}
        {height > 52 && (
          <div className="truncate muted">
            {showPractitioner ? ref.practitionerName(a.practitionerId) : ref.roomName(a.roomId)}
            {a.deviceId ? ` · ${ref.deviceName(a.deviceId)}` : ''}
          </div>
        )}
        {height > 70 && (
          <div className="row" style={{ marginTop: 2, gap: 4 }}>
            <StatusBadge status={a.status} />
            {a.payment && a.payment.state !== 'unpaid' && <PayBadge state={a.payment.state} />}
          </div>
        )}
      </button>
    </>
  );
}

type OffPart = { o: TimeOff; seg: { start: number; end: number } };

/** Time off for one day, optionally for one practitioner only. */
function offParts(items: TimeOff[] | undefined, date: string, practitionerId?: number): OffPart[] {
  return (items ?? [])
    .filter((o) => practitionerId === undefined || o.practitionerId === practitionerId)
    .map((o) => ({ o, seg: offSegment(o, date) }))
    .filter((x): x is OffPart => !!x.seg);
}

function OffBlocks({ parts, start, end, onOpen }: { parts: OffPart[]; start: number; end: number; onOpen: (id: number) => void }) {
  const { t } = useI18n();
  const ref = useRef_();
  const text = useTimeOffText();
  return (
    <>
      {parts.map(({ o, seg }) => {
        const from = Math.max(seg.start, start);
        const to = Math.min(seg.end, end);
        if (to <= from) return null;
        return (
          <button
            key={o.id}
            type="button"
            className="cal-off"
            style={{ top: (from - start) * PX_PER_MIN, height: (to - from) * PX_PER_MIN }}
            onClick={() => onOpen(o.id)}
            aria-label={`${t('off.label')} · ${ref.practitionerName(o.practitionerId)} · ${text.kind(o.kind)} · ${text.period(o)}`}
          >
            <span className="row" style={{ gap: 4 }}>
              <CalendarOff size={12} aria-hidden /> {t('off.label')}
            </span>
            <span className="xs truncate" style={{ fontWeight: 400 }}>
              {text.kind(o.kind)}
              {!o.allDay ? ` · ${o.startTime}–${o.endTime}` : ''}
            </span>
          </button>
        );
      })}
    </>
  );
}

function NowLine({ start, end }: { start: number; end: number }) {
  const fmt = useFmt();
  const nowMin = timeToMinutes(fmt.localTime(new Date().toISOString()));
  if (nowMin < start || nowMin > end) return null;
  return <div className="cal-now" style={{ top: (nowMin - start) * PX_PER_MIN }} aria-hidden />;
}

function DayView({ date, filters }: { date: string; filters: Filters }) {
  const { t, pick } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const { me, can } = useSession();
  const actions = useActions();
  const q = useAppointments(date, date, filters);
  const offQ = useTimeOff(date, date);
  const [offDetail, setOffDetail] = useState<number | null>(null);
  const wd = weekdayOf(date);
  const clinic = me.settings.openingHours[wd];
  const { start, end } = hoursRange([wd], me.settings.openingHours);
  const slot = me.settings.slotMinutes || 15;
  const toMin = (iso: string) => timeToMinutes(fmt.localTime(iso));
  const practitioners = (ref.data?.practitioners ?? []).filter((p) => p.active && (!filters.practitionerId || String(p.id) === filters.practitionerId));
  const isToday = date === fmt.today();
  if (q.isLoading || !ref.ready) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data!.items;
  return (
    <Panel flush>
      {!clinic?.open && <div style={{ padding: 12 }}><div className="callout callout-neutral small">{t('issue.CLINIC_CLOSED', { weekday: t(`weekday.${wd}` as TKey) })}</div></div>}
      <div className="cal" role="grid" aria-label={fmt.dayLong(date)}>
        <TimeColumn start={start} end={end} />
        <div className="cal-cols">
          {practitioners.map((p) => {
            const ph = p.hours[wd];
            const offs = offParts(offQ.data?.items, date, p.id);
            const offAllDay = offs.some(({ o }) => o.allDay);
            const mine = items.filter((a) => a.practitionerId === p.id);
            const layout = lanes(mine, toMin);
            const slots: number[] = [];
            for (let m = start; m < end; m += slot) slots.push(m);
            return (
              <div key={p.id} className="cal-col" role="rowgroup">
                <div className="cal-col-head">
                  <span className="color-dot" style={{ background: p.color }} aria-hidden />
                  <span className="truncate">{pick(p.displayName, p.displayNameAr)}</span>
                  <span className="muted xs">{offAllDay ? t('off.label') : ph?.open ? `${ph.start}–${ph.end}` : t('appt.closed')}</span>
                </div>
                <div className="cal-grid" style={{ height: (end - start) * PX_PER_MIN }}>
                  {slots.map((m) => {
                    const closed = !clinic?.open || !ph?.open || m < timeToMinutes(ph.start) || m >= timeToMinutes(ph.end) || m < timeToMinutes(clinic.start) || m >= timeToMinutes(clinic.end);
                    const off = offs.some(({ seg }) => m < seg.end && m + slot > seg.start);
                    return (
                      <div
                        key={m}
                        className={`cal-slot ${m % 60 === 60 - slot ? 'hour' : ''} ${closed || off ? 'closed' : ''}`}
                        style={{ height: slot * PX_PER_MIN }}
                        title={off ? t('off.label') : closed ? t('appt.closed') : `${minutesToTime(m)} · ${pick(p.displayName, p.displayNameAr)}`}
                        onClick={() => !closed && !off && can('appointments.manage') && actions.book({ practitionerId: p.id, date, time: minutesToTime(m) })}
                      />
                    );
                  })}
                  <OffBlocks parts={offs} start={start} end={end} onOpen={setOffDetail} />
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                    <div style={{ position: 'relative', height: '100%', pointerEvents: 'none' }}>
                      {mine.map((a) => {
                        const l = layout.get(a.id)!;
                        return (
                          <div key={a.id} style={{ pointerEvents: 'auto' }}>
                            <ApptBlock a={a} top={(toMin(a.startAt) - start) * PX_PER_MIN} height={(toMin(a.endAt) - toMin(a.startAt)) * PX_PER_MIN} lane={l.lane} of={l.of} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {isToday && <NowLine start={start} end={end} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="legend" style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
        <span>
          <span className="swatch" style={{ background: 'repeating-linear-gradient(135deg, transparent 0 3px, rgba(107,91,149,.25) 3px 5px)' }} />
          {t('appt.bufferLegend')}
        </span>
        <span>
          <span className="swatch" style={{ background: 'repeating-linear-gradient(135deg, var(--surface-2) 0 6px, var(--surface-3) 6px 7px)' }} />
          {t('appt.closed')}
        </span>
        <span>
          <span className="swatch cal-off-swatch" />
          {t('off.label')}
        </span>
        {(ref.data?.practitioners ?? []).map((p) => (
          <span key={p.id}>
            <span className="color-dot" style={{ background: p.color }} />
            {pick(p.displayName, p.displayNameAr)}
          </span>
        ))}
      </div>
      {offDetail !== null && <TimeOffDetailDialog id={offDetail} onClose={() => setOffDetail(null)} />}
    </Panel>
  );
}

function WeekView({ date, filters }: { date: string; filters: Filters }) {
  const fmt = useFmt();
  const { me, can } = useSession();
  const { t } = useI18n();
  const actions = useActions();
  const ref = useRef_();
  const weekStart = startOfWeek(date);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const q = useAppointments(days[0], days[6], filters);
  const offQ = useTimeOff(days[0], days[6]);
  const [offDetail, setOffDetail] = useState<number | null>(null);
  const filteredPractitioner = filters.practitionerId ? Number(filters.practitionerId) : undefined;
  const { start, end } = hoursRange(days.map(weekdayOf), me.settings.openingHours);
  const toMin = (iso: string) => timeToMinutes(fmt.localTime(iso));
  const byDay = useMemo(() => {
    const m = new Map<string, Appointment[]>();
    for (const a of q.data?.items ?? []) {
      const d = fmt.localDate(a.startAt);
      m.set(d, [...(m.get(d) ?? []), a]);
    }
    return m;
  }, [q.data, fmt]);
  if (q.isLoading || !ref.ready) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const slot = 30;
  return (
    <Panel flush>
      <div className="cal">
        <TimeColumn start={start} end={end} />
        <div className="cal-cols">
          {days.map((d) => {
            const wd = weekdayOf(d);
            const clinic = me.settings.openingHours[wd];
            const list = byDay.get(d) ?? [];
            const offs = offParts(offQ.data?.items, d, filteredPractitioner);
            const offNames = [...new Set(offs.map(({ o }) => ref.practitionerName(o.practitionerId)))];
            const layout = lanes(list, toMin);
            const slots: number[] = [];
            for (let m = start; m < end; m += slot) slots.push(m);
            return (
              <div key={d} className="cal-col" style={{ minWidth: 140 }}>
                <div className="cal-col-head" style={{ background: d === fmt.today() ? 'var(--accent-soft)' : undefined }}>
                  <span>{fmt.dayShort(d)}</span>
                  <span className="muted xs">{list.length}</span>
                  {offNames.length > 0 && (
                    <Badge tone="warning" title={`${t('off.label')}: ${offNames.join(', ')}`}>
                      {filteredPractitioner ? t('off.label') : t('off.countOff', { n: offNames.length })}
                    </Badge>
                  )}
                </div>
                <div className="cal-grid" style={{ height: (end - start) * PX_PER_MIN }}>
                  {slots.map((m) => {
                    const closed = !clinic?.open || m < timeToMinutes(clinic.start) || m >= timeToMinutes(clinic.end);
                    const off = !!filteredPractitioner && offs.some(({ seg }) => m < seg.end && m + slot > seg.start);
                    return (
                      <div
                        key={m}
                        className={`cal-slot ${m % 60 === 30 ? 'hour' : ''} ${closed || off ? 'closed' : ''}`}
                        style={{ height: slot * PX_PER_MIN }}
                        title={off ? t('off.label') : closed ? t('appt.closed') : `${fmt.dayShort(d)} ${minutesToTime(m)}`}
                        onClick={() => !closed && !off && can('appointments.manage') && actions.book({ date: d, time: minutesToTime(m), practitionerId: filteredPractitioner })}
                      />
                    );
                  })}
                  {filteredPractitioner && <OffBlocks parts={offs} start={start} end={end} onOpen={setOffDetail} />}
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                    {list.map((a) => {
                      const l = layout.get(a.id)!;
                      return (
                        <div key={a.id} style={{ pointerEvents: 'auto' }}>
                          <ApptBlock a={a} top={(toMin(a.startAt) - start) * PX_PER_MIN} height={(toMin(a.endAt) - toMin(a.startAt)) * PX_PER_MIN} lane={l.lane} of={l.of} showPractitioner />
                        </div>
                      );
                    })}
                  </div>
                  {d === fmt.today() && <NowLine start={start} end={end} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {offDetail !== null && <TimeOffDetailDialog id={offDetail} onClose={() => setOffDetail(null)} />}
    </Panel>
  );
}

function ListView({ s, set, filters }: { s: Record<string, string>; set: (p: Record<string, string>) => void; filters: React.ReactNode }) {
  const { t } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const actions = useActions();
  const from = s.from || fmt.today();
  const to = s.to || addDays(from, 13);
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['appointments-list', from, to, s.practitionerId, s.serviceId, s.deviceId, s.status, s.q, page],
    queryFn: () =>
      api.get<Paged<Appointment>>('/appointments', { paged: 1, from, to, practitionerId: s.practitionerId, serviceId: s.serviceId, deviceId: s.deviceId, status: s.status, q: s.q, page, pageSize: 25 }),
    placeholderData: (prev) => prev,
  });
  return (
    <Panel flush>
      <div className="row wrap between" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
        <div className="row wrap">
          <input type="search" className="input input-sm" style={{ width: 220 }} placeholder={t('appt.searchPatient')} aria-label={t('appt.searchPatient')} value={s.q} onChange={(e) => set({ q: e.target.value, page: '1' })} />
          <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.from')} value={from} onChange={(e) => set({ from: e.target.value, page: '1' })} />
          <span className="muted">–</span>
          <input type="date" className="input input-sm" style={{ width: 'auto' }} aria-label={t('common.to')} value={to} min={from} onChange={(e) => set({ to: e.target.value, page: '1' })} />
        </div>
        {filters}
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.items.length && <EmptyState title={t('appt.empty')} />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('common.date')}</th>
                <th>{t('appt.patient')}</th>
                <th>{t('appt.service')}</th>
                <th>{t('appt.practitioner')}</th>
                <th>{t('appt.room')}</th>
                <th>{t('common.status')}</th>
                <th>{t('appt.payment')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => actions.openAppointment(a.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && actions.openAppointment(a.id)}>
                  <td className="nowrap num">
                    {fmt.dateShort(a.startAt)} · {fmt.time(a.startAt)}
                  </td>
                  <td>
                    <div className="strong">{a.masked ? t('appt.busy') : a.patientName}</div>
                    {!a.masked && <div className="xs muted ltr">{a.patientPhone}</div>}
                  </td>
                  <td>{ref.serviceName(a.serviceId)}</td>
                  <td className="nowrap">
                    <span className="row">
                      <span className="color-dot" style={{ background: ref.practitionerColor(a.practitionerId) }} />
                      {ref.practitionerName(a.practitionerId)}
                    </span>
                  </td>
                  <td className="small">
                    {ref.roomName(a.roomId)}
                    {a.deviceId ? <div className="xs muted">{ref.deviceName(a.deviceId)}</div> : null}
                  </td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                  <td>{a.payment ? <PayBadge state={a.payment.state} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
    </Panel>
  );
}
