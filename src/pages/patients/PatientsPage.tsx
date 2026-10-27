import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useDebounced, useUrlState } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, EmptyState, ErrorState, Loading, Pagination, Panel } from '@/components/ui';
import { useActions } from '@/layout/actions';
import type { Paged, PatientListItem } from '@/lib/types';
import { SegmentBadge } from '@/components/insights';
import { useEffect, useState } from 'react';

export function PatientsPage() {
  const { t } = useI18n();
  const fmt = useFmt();
  const navigate = useNavigate();
  const { can, me } = useSession();
  const actions = useActions();
  const [s, set] = useUrlState({ q: '', filter: '', page: '1' });
  const [text, setText] = useState(s.q);
  const dq = useDebounced(text, 300);
  useEffect(() => {
    if (dq !== s.q) set({ q: dq, page: '1' });
  }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const page = Number(s.page) || 1;
  const q = useQuery({
    queryKey: ['patients', s.q, s.filter, page],
    queryFn: () => api.get<Paged<PatientListItem>>('/patients', { q: s.q, filter: s.filter, page, pageSize: 20 }),
    placeholderData: (prev) => prev,
  });
  const filters: { id: string; label: string; show: boolean }[] = [
    { id: '', label: t('pat.filter.all'), show: true },
    { id: 'balance', label: t('pat.filter.balance'), show: can('billing.view') },
    { id: 'package', label: t('pat.filter.package'), show: can('packages.view') },
    { id: 'mine', label: t('pat.filter.mine'), show: !!me.user.practitionerId },
  ];
  const showMoney = can('billing.view');
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('pat.title')}</h1>
        {can('patients.edit') && (
          <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => actions.newPatient((id) => navigate(`/patients/${id}`))}>
            {t('pat.new')}
          </Button>
        )}
      </div>
      <Panel flush>
        <div className="row wrap between" style={{ padding: 12, borderBottom: '1px solid var(--border)', gap: 8 }}>
          <div className="input-group" style={{ flex: '1 1 260px', maxWidth: 420 }}>
            <Search size={16} aria-hidden />
            <input className="input" type="search" placeholder={t('pat.search')} aria-label={t('pat.search')} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="row wrap" role="group" aria-label={t('common.filter')}>
            {filters
              .filter((f) => f.show)
              .map((f) => (
                <button key={f.id} className="chip" aria-pressed={s.filter === f.id} onClick={() => set({ filter: f.id, page: '1' })}>
                  {f.label}
                </button>
              ))}
          </div>
        </div>
        {q.isLoading && <Loading />}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data && !q.data.items.length && <EmptyState title={t('pat.empty')} hint={t('pat.emptyHint')} />}
        {q.data && q.data.items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('pat.name')}</th>
                  <th>{t('pat.phone')}</th>
                  <th>{t('pat.age')}</th>
                  <th>{t('pat.lastVisit')}</th>
                  <th>{t('pat.nextVisit')}</th>
                  <th>{t('pat.packages')}</th>
                  {showMoney && <th className="num">{t('pat.balance')}</th>}
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((p) => (
                  <tr key={p.id} className="clickable" tabIndex={0} onClick={() => navigate(`/patients/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/patients/${p.id}`)}>
                    <td>
                      <div className="strong">{p.fullName}</div>
                      <div className="row wrap" style={{ gap: 4 }}>
                        <span className="xs muted">{p.code}</span>
                        <SegmentBadge segment={p.segment} lapsed={p.lapsed} />
                      </div>
                    </td>
                    <td className="ltr nowrap">{p.phone}</td>
                    <td className="num">{p.age ?? '—'}</td>
                    <td className="nowrap">{p.lastVisit ? fmt.date(p.lastVisit) : '—'}</td>
                    <td className="nowrap">{p.nextVisit ? fmt.dateTime(p.nextVisit) : '—'}</td>
                    <td>{p.activePackages ? <Badge tone="accent">{p.activePackages}</Badge> : '—'}</td>
                    {showMoney && <td className="num" style={{ color: p.outstanding ? 'var(--warning)' : undefined }}>{p.outstanding ? fmt.money(p.outstanding) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Panel>
    </div>
  );
}
