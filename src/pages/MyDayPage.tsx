// "My day": what is waiting for the signed-in person right now, chosen by their permissions.
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Banknote,
  Cake,
  CalendarCheck,
  CalendarPlus,
  ClipboardList,
  CreditCard,
  FilePenLine,
  Hourglass,
  LogIn,
  MessageCircle,
  Package,
  PhoneCall,
  PiggyBank,
  Receipt,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { initials } from '@/lib/hooks';
import { useFmt } from '@/lib/format';
import { useRef_, useSession } from '@/lib/session';
import { useI18n } from '@/i18n';
import { Badge, Button, ErrorState, Loading } from '@/components/ui';
import { useActions } from '@/layout/actions';
import type { TKey } from '@/i18n/en';

interface TaskItem {
  label: string;
  sub?: string | null;
  at?: string | null;
  date?: string | null;
  amount?: number | null;
  late?: boolean;
  patientId?: number | null;
  appointmentId?: number | null;
  link?: string | null;
}
interface Task {
  key: string;
  tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral';
  count: number;
  items: TaskItem[];
  link: string;
  params?: Record<string, string | number>;
}
interface MyDay {
  today: string;
  summary: {
    appointments: number;
    completed: number;
    waiting: number;
    next: { id: number; startAt: string; patientName: string | null; serviceId: number; practitionerId: number } | null;
    mine: boolean;
  };
  tasks: Task[];
}

const ICONS: Record<string, LucideIcon> = {
  waiting_for_me: Users,
  unfinished_sessions: FilePenLine,
  arrivals: LogIn,
  confirm_tomorrow: PhoneCall,
  risky_bookings: AlertTriangle,
  deposits_due: Banknote,
  collect_today: Wallet,
  day_close: PiggyBank,
  installments_overdue: Receipt,
  deposit_decisions: CreditCard,
  followups: MessageCircle,
  growth: TrendingUp,
  birthdays: Cake,
  waitlist: Hourglass,
  stock: Package,
  aftercare: ShieldCheck,
};

export function MyDayPage() {
  const { t, tx } = useI18n();
  const fmt = useFmt();
  const ref = useRef_();
  const navigate = useNavigate();
  const { me, can } = useSession();
  const actions = useActions();
  const q = useQuery({ queryKey: ['my-day'], queryFn: () => api.get<MyDay>('/my-day'), refetchInterval: 60_000 });
  const hour = Number(fmt.localTime(new Date().toISOString()).slice(0, 2));
  const greeting = hour < 12 ? t('md.morning') : hour < 17 ? t('md.afternoon') : t('md.evening');
  const first = me.user.name.replace(/^Dr\.?\s+/i, '').split(' ')[0];
  const d = q.data;

  const open = (item: TaskItem, task: Task) => {
    if (item.link) navigate(item.link);
    else if (item.appointmentId) actions.openAppointment(item.appointmentId);
    else if (item.patientId) navigate(`/patients/${item.patientId}`);
    else navigate(task.link);
  };

  const quick: { show: boolean; label: TKey; icon: LucideIcon; run: () => void; primary?: boolean }[] = [
    { show: can('appointments.manage'), label: 'dash.book', icon: CalendarPlus, run: () => actions.book(), primary: true },
    { show: can('appointments.checkin'), label: 'md.q.queue', icon: CalendarCheck, run: () => navigate('/appointments?view=queue') },
    { show: can('patients.edit'), label: 'dash.addPatient', icon: UserPlus, run: () => actions.newPatient((id) => navigate(`/patients/${id}`)) },
    { show: can('payments.record'), label: 'dash.collect', icon: CreditCard, run: () => actions.collectPayment() },
    { show: can('appointments.manage'), label: 'wl.add', icon: Hourglass, run: () => actions.addToWaitlist() },
    { show: can('followup.view'), label: 'nav.growth', icon: Sparkles, run: () => navigate('/growth') },
    { show: can('payments.record'), label: 'dc.tab', icon: PiggyBank, run: () => navigate('/billing?tab=close') },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div className="greeting">
          <span className="avatar" aria-hidden>
            {initials(me.user.name)}
          </span>
          <div>
            <h1>
              {t('md.hello', { greeting, name: first })}
            </h1>
            <p className="sub">
              {t(`role.${me.user.role}` as TKey)} · {fmt.dayLong(fmt.today())}
            </p>
          </div>
        </div>
        <div className="toolbar">
          {quick
            .filter((x) => x.show)
            .map((x) => (
              <Button key={x.label} size="sm" variant={x.primary ? 'primary' : 'default'} icon={<x.icon size={15} />} onClick={x.run}>
                {t(x.label)}
              </Button>
            ))}
        </div>
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <>
          {can('appointments.view') && (
            <div className="metrics">
              <button className="metric" onClick={() => navigate(`/appointments?view=day${d.summary.mine && me.user.practitionerId ? `&practitionerId=${me.user.practitionerId}` : ''}`)}>
                <span className="metric-label">{d.summary.mine ? t('md.myAppointments') : t('md.appointments')}</span>
                <span className="metric-value">{fmt.num(d.summary.appointments)}</span>
                <span className="metric-sub">{t('md.doneOf', { done: d.summary.completed, n: d.summary.appointments })}</span>
              </button>
              <button className={`metric ${d.summary.waiting ? 'tone-warning' : ''}`} onClick={() => navigate('/appointments?view=queue')}>
                <span className="metric-label">{t('dash.waiting')}</span>
                <span className="metric-value">{fmt.num(d.summary.waiting)}</span>
              </button>
              <button className="metric" disabled={!d.summary.next} onClick={() => d.summary.next && actions.openAppointment(d.summary.next.id)}>
                <span className="metric-label">{t('md.next')}</span>
                <span className="metric-value">{d.summary.next ? fmt.time(d.summary.next.startAt) : '—'}</span>
                <span className="metric-sub truncate">{d.summary.next ? `${d.summary.next.patientName ?? t('appt.busy')} · ${ref.serviceName(d.summary.next.serviceId)}` : t('md.noNext')}</span>
              </button>
            </div>
          )}

          <h2 className="row" style={{ gap: 8 }}>
            <ClipboardList size={18} aria-hidden /> {t('md.tasks')}
          </h2>
          {!d.tasks.length ? (
            <div className="all-clear">
              <ShieldCheck size={20} aria-hidden /> {t('md.allClear')}
            </div>
          ) : (
            <div className="task-grid">
              {d.tasks.map((task) => {
                const Icon = ICONS[task.key] ?? ClipboardList;
                const params = { ...task.params, n: task.count, total: task.params?.total !== undefined ? fmt.money(Number(task.params.total)) : '' };
                return (
                  <section key={task.key} className={`task-card tone-${task.tone}`} aria-labelledby={`task-${task.key}`}>
                    <div className="task-head">
                      <Icon size={18} aria-hidden style={{ color: `var(--${task.tone === 'neutral' ? 'text-muted' : task.tone})` }} />
                      <span className="task-count">{task.count}</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <h3 id={`task-${task.key}`} style={{ fontSize: 'var(--fs-md)' }}>
                          {tx(`md.task.${task.key}`, params)}
                        </h3>
                        <div className="xs muted">{tx(`md.desc.${task.key}`, params)}</div>
                      </div>
                    </div>
                    {task.items.length > 0 && (
                      <ul className="task-items">
                        {task.items.map((item, i) => (
                          <li key={i}>
                            <button className="link-btn truncate" style={{ textAlign: 'start' }} onClick={() => open(item, task)}>
                              {item.date && item.label === item.date ? fmt.dayShort(item.date) : item.label}
                            </button>
                            <span className="xs muted nowrap">
                              {item.late && <Badge tone="warning">{t('md.late')}</Badge>} {item.at ? (fmt.localDate(item.at) === d.today ? fmt.time(item.at) : fmt.dateTime(item.at)) : ''}
                              {item.amount !== undefined && item.amount !== null ? fmt.money(item.amount) : ''}
                              {item.date && item.at === undefined && item.label !== item.date ? fmt.dayShort(item.date) : ''}
                              {item.sub ? ` ${item.sub}` : ''}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="task-foot">
                      <Button size="xs" variant="soft" onClick={() => navigate(task.link)}>
                        {t('md.open')}
                      </Button>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
