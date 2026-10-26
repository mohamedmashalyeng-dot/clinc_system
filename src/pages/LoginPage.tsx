import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Button, Callout, TextField } from '@/components/ui';
import { useErrorText } from '@/lib/hooks';
import type { TKey } from '@/i18n/en';

interface PublicInfo {
  clinicName: string;
  clinicNameAr: string;
  hasLogo: boolean;
  demoMode: boolean;
  demoAccounts: { role: string; email: string }[];
  demoPassword: string | null;
}

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, pick, lang, setLang } = useI18n();
  const errorText = useErrorText();
  const { data: info } = useQuery({ queryKey: ['public'], queryFn: () => api.get<PublicInfo>('/auth/public') });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email || !password) {
      setError(t('v.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? t('v.email') : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card stack loose">
        <div className="row between">
          <div className="row">
            <span className={`brand-mark ${info?.hasLogo ? 'has-logo' : ''}`} aria-hidden>
              {info?.hasLogo && <img src="/api/settings/logo" alt="" />}
            </span>
            <div>
              <h1 style={{ fontSize: 'var(--fs-xl)' }}>{info ? pick(info.clinicName, info.clinicNameAr) : t('app.name')}</h1>
              <div className="small muted">{t('login.subtitle')}</div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} aria-label={t('top.languageLabel')}>
            {t('top.language')}
          </Button>
        </div>
        <form className="stack" onSubmit={submit} noValidate>
          <h2 style={{ fontSize: 'var(--fs-lg)' }}>{t('login.title')}</h2>
          {error && <Callout tone="danger">{error}</Callout>}
          <TextField label={t('login.email')} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
          <TextField label={t('login.password')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
          <Button type="submit" variant="primary" block loading={busy} icon={<LogIn size={16} className="flip-rtl" />}>
            {t('login.submit')}
          </Button>
        </form>
        {info?.demoMode && info.demoAccounts.length > 0 && (
          <div className="stack tight">
            <div className="section-title">{t('login.demoTitle')}</div>
            <p className="small muted">{t('login.demoHint', { pw: info.demoPassword ?? '' })}</p>
            <div className="demo-accounts">
              {info.demoAccounts.map((a) => (
                <Button
                  key={a.email}
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(info.demoPassword ?? '');
                    setError(null);
                  }}
                >
                  {t(`role.${a.role}` as TKey)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
