// Prepare a message from a template, hand it to WhatsApp or the clipboard, and log the contact.
// Nothing is sent by the system: staff send it themselves and record the outcome.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, MessageCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useAction, useToast } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Button, Callout, SelectField, TextArea } from '@/components/ui';
import { Dialog } from '@/components/overlays';
import { fillTemplate, whatsappLink } from '@shared/domain';

export interface Template {
  id: number;
  kind: string;
  name: string;
  bodyEn: string;
  bodyAr: string;
  active: boolean;
  approvedBy: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
}

export interface Contactable {
  patientId: number;
  patientName: string;
  phone: string;
  contactChannel: string;
  allowReminders: number | boolean;
  preferredLanguage: string;
  allowMarketing?: boolean;
}

export type Compose = {
  who: Contactable;
  kind: string;
  vars: Record<string, string>;
  followUpId?: number;
  appointmentId?: number;
  /** Promotional rather than care-related: warn when the patient has not agreed to marketing. */
  marketing?: boolean;
};

export function ComposeDialog({ c, onClose }: { c: Compose; onClose: () => void }) {
  const { t, tx } = useI18n();
  const { me } = useSession();
  const toast = useToast();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ items: Template[] }>('/followup/templates') });
  const patientDetail = useQuery({
    queryKey: ['patient', c.who.patientId],
    queryFn: () => api.get<{ patient: { contactChannel: string; allowReminders: boolean; allowMarketing: boolean; preferredLanguage: string } }>(`/patients/${c.who.patientId}`),
  });
  const pref = patientDetail.data?.patient ?? c.who;
  const list = (templates.data?.items ?? []).filter((x) => x.kind === c.kind && x.active);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [lang, setLang] = useState<'ar' | 'en' | null>(null);
  const effectiveLang = lang ?? ((pref.preferredLanguage as 'ar' | 'en') || 'ar');
  const tpl = list.find((x) => x.id === templateId) ?? list[0];
  const filled = useMemo(
    () => (tpl ? fillTemplate(effectiveLang === 'ar' ? tpl.bodyAr : tpl.bodyEn, { patient_name: c.who.patientName.split(' ')[0], clinic_name: effectiveLang === 'ar' ? me.settings.clinicNameAr : me.settings.clinicName, ...c.vars }) : ''),
    [tpl, effectiveLang, c, me.settings],
  );
  const [body, setBody] = useState<string | null>(null);
  const text = body ?? filled;
  const defaultChannel = ['whatsapp', 'sms', 'email', 'phone'].includes(pref.contactChannel) ? pref.contactChannel : 'phone';
  const [channel, setChannel] = useState<string | null>(null);
  const ch = channel ?? defaultChannel;
  const [outcome, setOutcome] = useState('contacted_manually');
  const optedOut = !pref.allowReminders || pref.contactChannel === 'none';
  const noMarketing = c.marketing && pref.allowMarketing === false;
  const waLink = ch === 'whatsapp' && text.trim() ? whatsappLink(c.who.phone, text) : null;
  const log = useAction(() => api.post('/followup/communications', { patientId: c.who.patientId, channel: ch, templateId: tpl?.id ?? null, followUpId: c.followUpId ?? null, appointmentId: c.appointmentId ?? null, body: text, outcome }), {
    success: t('fu.logged'),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      size="wide"
      onClose={onClose}
      title={t('fu.composeTitle', { name: c.who.patientName })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={<Copy size={15} />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast.success(t('common.copied'));
              } catch {
                toast.error(t('common.error'));
              }
            }}
          >
            {t('fu.copyText')}
          </Button>
          {waLink && (
            <a className="btn btn-soft" href={waLink} target="_blank" rel="noopener noreferrer">
              <MessageCircle size={15} aria-hidden /> {t('fu.openWhatsapp')}
            </a>
          )}
          <Button variant="primary" disabled={!text.trim()} loading={log.isPending} onClick={() => log.mutate(undefined)}>
            {t('fu.log')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {optedOut && <Callout tone="warning">{t('fu.preferenceWarning', { pref: pref.contactChannel === 'none' ? t('fu.noContact') : t('fu.optedOut') })}</Callout>}
        {noMarketing && <Callout tone="warning">{t('fu.marketingWarning')}</Callout>}
        <div className="form-grid">
          <SelectField
            label={t('fu.template')}
            value={tpl?.id ?? ''}
            onChange={(e) => {
              setTemplateId(Number(e.target.value));
              setBody(null);
            }}
          >
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('fu.messageLanguage')}
            value={effectiveLang}
            onChange={(e) => {
              setLang(e.target.value as 'ar' | 'en');
              setBody(null);
            }}
          >
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </SelectField>
          <SelectField label={t('fu.channel')} value={ch} onChange={(e) => setChannel(e.target.value)}>
            {['whatsapp', 'sms', 'email', 'phone', 'in_person'].map((x) => (
              <option key={x} value={x}>
                {tx(`pat.channel.${x}`)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t('fu.outcome')} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {['contacted_manually', 'no_answer', 'prepared_only'].map((x) => (
              <option key={x} value={x}>
                {tx(`fu.outcome.${x}`)}
              </option>
            ))}
          </SelectField>
        </div>
        <TextArea label={t('fu.message')} rows={6} dir={effectiveLang === 'ar' ? 'rtl' : 'ltr'} value={text} onChange={(e) => setBody(e.target.value)} />
        {ch === 'whatsapp' ? (
          <Callout tone="info">{t('fu.whatsappNote')}</Callout>
        ) : (
          ['sms', 'email'].includes(ch) && <Callout tone="info">{t('fu.notSentNote', { channel: tx(`pat.channel.${ch}`) })}</Callout>
        )}
        {!list.length && <p className="small muted">{t('fu.noTemplate')}</p>}
      </div>
    </Dialog>
  );
}
