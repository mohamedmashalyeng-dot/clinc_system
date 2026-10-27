// Default bilingual wording for the growth outreach lists. Seeded into new demo databases and added
// once to databases created by an earlier build; staff can edit them under Follow-up → Templates.

export const GROWTH_TEMPLATES: { kind: string; name: string; en: string; ar: string }[] = [
  {
    kind: 'rebook',
    name: 'Next session due',
    en: 'Hello {{patient_name}}, it is time for your next {{service}} session at {{clinic_name}}. Reply with a day and time that suit you and we will book it for you.',
    ar: 'مرحبًا {{patient_name}}، حان موعد جلسة {{service}} القادمة في {{clinic_name}}. أرسل لنا اليوم والوقت المناسبين لك وسنحجز لك.',
  },
  {
    kind: 'unused_sessions',
    name: 'Sessions waiting in a package',
    en: 'Hello {{patient_name}}, you still have {{remaining}} session(s) in your {{package}} package, valid until {{expiry_date}}. Shall we book your next one? Reply with a time that suits you.',
    ar: 'مرحبًا {{patient_name}}، متبقٍ لك {{remaining}} جلسة في باقة {{package}} وهي صالحة حتى {{expiry_date}}. هل نحجز جلستك القادمة؟ أرسل لنا الوقت المناسب لك.',
  },
  {
    kind: 'win_back',
    name: 'We miss you',
    en: 'Hello {{patient_name}}, we miss you at {{clinic_name}}! It has been a while since your last {{service}}. Reply to this message and we will find a time that suits you.',
    ar: 'مرحبًا {{patient_name}}، افتقدناك في {{clinic_name}}! مرّ وقت منذ آخر جلسة {{service}}. رُد على هذه الرسالة وسنجد لك موعدًا مناسبًا.',
  },
  {
    kind: 'renewal',
    name: 'Package almost finished',
    en: 'Hello {{patient_name}}, you are close to finishing your {{package}} package ({{remaining}} session(s) left). Ask us about continuing your treatment at your next visit.',
    ar: 'مرحبًا {{patient_name}}، اقتربت من إنهاء باقة {{package}} (متبقٍ {{remaining}} جلسة). اسألنا عن استكمال برنامجك في زيارتك القادمة.',
  },
  {
    kind: 'birthday',
    name: 'Birthday greeting',
    en: 'Happy birthday {{patient_name}}! Everyone at {{clinic_name}} wishes you a wonderful year.',
    ar: 'عيد ميلاد سعيد يا {{patient_name}}! يتمنى لك فريق {{clinic_name}} عامًا جميلًا مليئًا بالسعادة.',
  },
];
