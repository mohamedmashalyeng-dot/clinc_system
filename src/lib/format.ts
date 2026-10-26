import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { useSession } from './session';
import { formatMoney } from '@shared/money';
import { todayIn, zonedParts } from '@shared/time';

/** Formatting in the clinic's configured time zone and currency (never the browser's). */
export function useFmt() {
  const { locale, lang } = useI18n();
  const { me } = useSession();
  const tz = me.settings.timezone;
  const currency = me.settings.currency;
  return useMemo(() => {
    const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
    const dateShort = new Intl.DateTimeFormat(locale, { timeZone: tz, day: 'numeric', month: 'short' });
    const timeFmt = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const dtFmt = new Intl.DateTimeFormat(locale, { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const weekdayFmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const weekdayShortFmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    const calDate = (d: string) => new Date(`${d}T12:00:00Z`);
    const numFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const pctFmt = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
    return {
      tz,
      currency,
      money: (minor: number | null | undefined) => (minor === null || minor === undefined ? '—' : formatMoney(minor, currency, lang)),
      /** ISO instant → clinic-local date */
      date: (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso)) : '—'),
      /** Calendar date (YYYY-MM-DD) → formatted, no time-zone shift */
      day: (d: string | null | undefined) => (d ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(calDate(d)) : '—'),
      dayShort: (d: string) => weekdayShortFmt.format(calDate(d)),
      dayLong: (d: string) => weekdayFmt.format(calDate(d)),
      dateShort: (iso: string) => dateShort.format(new Date(iso)),
      time: (iso: string | null | undefined) => (iso ? timeFmt.format(new Date(iso)) : '—'),
      dateTime: (iso: string | null | undefined) => (iso ? dtFmt.format(new Date(iso)) : '—'),
      num: (n: number | null | undefined) => (n === null || n === undefined ? '—' : numFmt.format(n)),
      pct: (n: number) => pctFmt.format(n),
      localDate: (iso: string) => zonedParts(iso, tz).date,
      localTime: (iso: string) => zonedParts(iso, tz).time,
      today: () => todayIn(tz),
    };
  }, [locale, lang, tz, currency]);
}
