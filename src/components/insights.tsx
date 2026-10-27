// Patient value segment and no-show risk badges, shared by lists, the schedule and the profile.
import { AlertTriangle, Crown, Hourglass, Sparkles, Star } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Badge } from './ui';
import type { NoShowRisk } from '@/lib/types';
import type { PatientSegment } from '@shared/domain';
import type { TKey } from '@/i18n/en';

const SEGMENT_TONE: Record<PatientSegment, 'accent' | 'success' | 'info' | 'neutral' | 'outline'> = {
  vip: 'accent',
  loyal: 'success',
  new: 'info',
  regular: 'neutral',
  prospect: 'outline',
};

/** Shows notable segments only (VIP, loyal, new) plus "lapsed"; regular patients get no badge. */
export function SegmentBadge({ segment, lapsed, always }: { segment: PatientSegment | null; lapsed?: boolean; always?: boolean }) {
  const { t } = useI18n();
  if (!segment) return null;
  const show = always || segment === 'vip' || segment === 'loyal' || segment === 'new';
  return (
    <>
      {show && (
        <Badge tone={SEGMENT_TONE[segment]} title={t(`seg.def.${segment}` as TKey)}>
          {segment === 'vip' ? <Crown size={12} aria-hidden /> : segment === 'loyal' ? <Star size={12} aria-hidden /> : segment === 'new' ? <Sparkles size={12} aria-hidden /> : null}
          {t(`seg.${segment}` as TKey)}
        </Badge>
      )}
      {lapsed && (
        <Badge tone="warning" title={t('seg.def.lapsed')}>
          <Hourglass size={12} aria-hidden /> {t('seg.lapsed')}
        </Badge>
      )}
    </>
  );
}

export function useRiskText() {
  const { t } = useI18n();
  return (risk: NoShowRisk) =>
    risk.reasons
      .map((r) => (r.code === 'no_shows' ? t('risk.r.no_shows', { n: r.n ?? 0 }) : r.code === 'late_cancellations' ? t('risk.r.late_cancellations', { n: r.n ?? 0 }) : t('risk.r.first_visit')))
      .join(' · ');
}

export function RiskBadge({ risk, compact }: { risk: NoShowRisk | null | undefined; compact?: boolean }) {
  const { t } = useI18n();
  const text = useRiskText();
  if (!risk || risk.level === 'low') return null;
  const label = risk.level === 'high' ? t('risk.high') : t('risk.medium');
  return (
    <Badge tone={risk.level === 'high' ? 'danger' : 'warning'} title={`${label}: ${text(risk)}`}>
      <AlertTriangle size={12} aria-hidden />
      {compact ? t('risk.short') : label}
    </Badge>
  );
}
