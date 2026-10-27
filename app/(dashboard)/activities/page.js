'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, Check, X, ExternalLink } from 'lucide-react';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import { getMyActivities, markActivityDone, cancelActivity } from '@/app/actions/chatter';
import { ACTIVITY_META, STATE_STYLE } from '@/components/erp/Chatter';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Tabs, inputClass, formatDate } from '@/components/erp/kit';
import { MODEL_LABELS, recordHref } from '@/lib/erp/record-links';

const GROUPS = [
  { key: 'overdue', label: 'Overdue', tone: 'red' },
  { key: 'today', label: 'Today', tone: 'amber' },
  { key: 'planned', label: 'Planned', tone: 'green' },
];

export default function ActivitiesPage() {
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const isManager = ['ADMIN', 'MANAGER'].includes(session?.user?.role);
  const [scope, setScope] = useState('mine');
  const [data, setData] = useState({ rows: [], counts: { overdue: 0, today: 0, planned: 0 } });
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('ALL');
  const [doneFor, setDoneFor] = useState(null);
  const [feedback, setFeedback] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getMyActivities(scope);
    if (res.success) setData(res.data); else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [scope, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);

  const rows = useMemo(() => data.rows.filter(row => type === 'ALL' || row.activityType === type), [data.rows, type]);

  const done = async (id) => {
    const res = await markActivityDone(id, feedback || undefined);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setDoneFor(null);
    setFeedback('');
    load();
  };

  const drop = async (id) => {
    const res = await cancelActivity(id);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    load();
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Activities" subtitle="Calls, meetings, follow-ups and to-dos scheduled on any record" breadcrumbs={[{ label: 'Team' }, { label: 'Activities' }]} />
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        {isManager && <Tabs value={scope} onChange={setScope} tabs={[{ key: 'mine', label: 'My activities' }, { key: 'team', label: 'Whole team' }]} />}
        <Tabs value={type} onChange={setType} tabs={[{ key: 'ALL', label: 'All types' }, ...Object.entries(ACTIVITY_META).map(([key, meta]) => ({ key, label: meta.label }))]} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {GROUPS.map(group => (
          <div key={group.key} className="glass-card p-3.5">
            <p className={`text-2xl font-semibold ${STATE_STYLE[group.key]}`}>{data.counts[group.key]}</p>
            <p className="text-xs text-muted">{group.label}</p>
          </div>
        ))}
      </div>

      {loading ? <Loading /> : rows.length === 0 ? (
        <Card><EmptyState icon={CalendarClock} title="All clear" text="Schedule activities from the chatter on any sales order, transfer, count or purchase order." /></Card>
      ) : GROUPS.map(group => {
        const items = rows.filter(row => row.state === group.key);
        if (items.length === 0) return null;
        return (
          <Card key={group.key} title={<span className="flex items-center gap-2">{group.label} <Badge tone={group.tone}>{items.length}</Badge></span>} padded={false}>
            <ul className="divide-y divide-border/60">
              {items.map(item => {
                const meta = ACTIVITY_META[item.activityType] || ACTIVITY_META.TODO;
                const Icon = meta.icon;
                return (
                  <li key={item.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <Icon className={`w-4 h-4 mt-0.5 ${STATE_STYLE[item.state]}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground font-medium">{item.summary}</p>
                        <p className="text-xs text-muted">
                          {meta.label} · due {formatDate(item.dueDate)}{scope === 'team' ? ` · ${item.assignedTo?.name || 'unassigned'}` : ''} ·{' '}
                          <Link href={recordHref(item.resModel, item.resId)} className="text-accent inline-flex items-center gap-0.5">{item.resName || `${MODEL_LABELS[item.resModel] || item.resModel} #${item.resId}`}<ExternalLink className="w-3 h-3" /></Link>
                        </p>
                        {item.note && <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{item.note}</p>}
                        {doneFor === item.id && (
                          <div className="mt-2 flex gap-2 max-w-md">
                            <input value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Feedback (optional)" className={inputClass} />
                            <Button size="sm" variant="primary" onClick={() => done(item.id)}>Done</Button>
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={() => setDoneFor(doneFor === item.id ? null : item.id)} className="p-1.5 rounded-md text-emerald-500 hover:bg-emerald-500/10" title="Mark done"><Check className="w-4 h-4" /></button>
                      <button type="button" onClick={() => drop(item.id)} className="p-1.5 rounded-md text-muted hover:text-red-500 hover:bg-red-500/10" title="Cancel"><X className="w-4 h-4" /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
