'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, MessageSquareText, Phone, Mail, Users, ListTodo, FileUp, RefreshCw, X, ArrowRight } from 'lucide-react';
import { getChatter, postNote, scheduleActivity, markActivityDone, cancelActivity, getAssignableUsers } from '@/app/actions/chatter';
import { useAlertToast } from '@/components/AlertToastProvider';
import { Button, inputClass } from './kit';

export const ACTIVITY_META = {
  TODO: { label: 'To-Do', icon: ListTodo },
  CALL: { label: 'Call', icon: Phone },
  MEETING: { label: 'Meeting', icon: Users },
  EMAIL: { label: 'Email', icon: Mail },
  FOLLOW_UP: { label: 'Follow-up', icon: ArrowRight },
  DOCUMENT: { label: 'Upload document', icon: FileUp },
};

export const STATE_STYLE = {
  overdue: 'text-red-500',
  today: 'text-amber-500',
  planned: 'text-emerald-500',
};

function relativeDue(date, state) {
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (state === 'today') return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days < 0 ? `${Math.abs(days)} days overdue` : `Due in ${days} days`;
}

function timeAgo(value) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function plusDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Chatter — Odoo's mail.thread panel for any document: a log of notes and
 * tracked changes plus scheduled activities (call, meeting, to-do…) assigned
 * to team members. `resModel` must be one of lib/erp/chatter CHATTER_MODELS.
 */
export default function Chatter({ resModel, resId, resName, refreshKey = 0 }) {
  const { notify } = useAlertToast();
  const [data, setData] = useState({ messages: [], activities: [] });
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState(null); // 'note' | 'activity'
  const [note, setNote] = useState('');
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState({ activityType: 'TODO', summary: '', dueDate: plusDays(1), assignedToId: '', note: '' });
  const [doneFor, setDoneFor] = useState(null);
  const [feedback, setFeedback] = useState('');

  const load = useCallback(async () => {
    if (!resId) return;
    setLoading(true);
    const res = await getChatter(resModel, resId);
    if (res.success) setData(res.data);
    setLoading(false);
  }, [resModel, resId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (mode === 'activity' && users.length === 0) getAssignableUsers().then(res => res.success && setUsers(res.data));
  }, [mode, users.length]);

  const submitNote = async () => {
    setBusy(true);
    const res = await postNote({ resModel, resId, body: note });
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setNote('');
    setMode(null);
    load();
  };

  const submitActivity = async () => {
    setBusy(true);
    const res = await scheduleActivity({
      resModel, resId, resName,
      activityType: activity.activityType,
      summary: activity.summary || ACTIVITY_META[activity.activityType].label,
      dueDate: activity.dueDate,
      note: activity.note || undefined,
      assignedToId: activity.assignedToId ? Number(activity.assignedToId) : undefined,
    });
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify('Activity scheduled', { variant: 'success' });
    setActivity({ activityType: 'TODO', summary: '', dueDate: plusDays(1), assignedToId: '', note: '' });
    setMode(null);
    load();
  };

  const completeActivity = async (id) => {
    setBusy(true);
    const res = await markActivityDone(id, feedback || undefined);
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setDoneFor(null);
    setFeedback('');
    load();
  };

  const dropActivity = async (id) => {
    const res = await cancelActivity(id);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    load();
  };

  return (
    <aside className="glass-card p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant={mode === 'note' ? 'primary' : 'secondary'} icon={MessageSquareText} onClick={() => setMode(mode === 'note' ? null : 'note')}>Log note</Button>
        <Button size="sm" variant={mode === 'activity' ? 'primary' : 'secondary'} icon={CalendarClock} onClick={() => setMode(mode === 'activity' ? null : 'activity')}>Activity</Button>
        <button type="button" onClick={load} className="ml-auto p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-surface-hover" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>

      {mode === 'note' && (
        <div className="space-y-2">
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="Log an internal note… (visible to the team only)" className={inputClass} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Discard</Button>
            <Button size="sm" variant="primary" loading={busy} disabled={!note.trim()} onClick={submitNote}>Log</Button>
          </div>
        </div>
      )}

      {mode === 'activity' && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <select value={activity.activityType} onChange={e => setActivity({ ...activity, activityType: e.target.value })} className={inputClass}>
              {Object.entries(ACTIVITY_META).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
            </select>
            <input type="date" value={activity.dueDate} onChange={e => setActivity({ ...activity, dueDate: e.target.value })} className={inputClass} />
          </div>
          <div className="flex gap-1 flex-wrap">
            {[['Today', 0], ['Tomorrow', 1], ['In 3 days', 3], ['Next week', 7]].map(([label, days]) => (
              <button key={label} type="button" onClick={() => setActivity({ ...activity, dueDate: plusDays(days) })} className="px-2 py-0.5 rounded-md border border-border text-[11px] text-muted hover:text-foreground">{label}</button>
            ))}
          </div>
          <input value={activity.summary} onChange={e => setActivity({ ...activity, summary: e.target.value })} placeholder="Summary (e.g. Confirm site measurements)" className={inputClass} />
          <select value={activity.assignedToId} onChange={e => setActivity({ ...activity, assignedToId: e.target.value })} className={inputClass}>
            <option value="">Assign to me</option>
            {users.map(user => <option key={user.id} value={user.id}>{user.name} · {user.role.toLowerCase()}</option>)}
          </select>
          <textarea value={activity.note} onChange={e => setActivity({ ...activity, note: e.target.value })} rows={2} placeholder="Notes (optional)" className={inputClass} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Discard</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={submitActivity}>Schedule</Button>
          </div>
        </div>
      )}

      {data.activities.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-2">Planned activities</p>
          <ul className="space-y-2">
            {data.activities.map(item => {
              const meta = ACTIVITY_META[item.activityType] || ACTIVITY_META.TODO;
              const Icon = meta.icon;
              return (
                <li key={item.id} className="rounded-lg border border-border p-2.5">
                  <div className="flex items-start gap-2">
                    <Icon className={`w-4 h-4 mt-0.5 ${STATE_STYLE[item.state]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground"><span className={`font-semibold ${STATE_STYLE[item.state]}`}>{relativeDue(item.dueDate, item.state)}</span> · {item.summary}</p>
                      <p className="text-[11px] text-muted">{meta.label} for {item.assignedTo?.name || 'unassigned'}{item.note ? ` — ${item.note}` : ''}</p>
                    </div>
                    <button type="button" onClick={() => setDoneFor(doneFor === item.id ? null : item.id)} className="p-1 rounded-md text-emerald-500 hover:bg-emerald-500/10" title="Mark done"><Check className="w-4 h-4" /></button>
                    <button type="button" onClick={() => dropActivity(item.id)} className="p-1 rounded-md text-muted hover:text-red-500 hover:bg-red-500/10" title="Cancel"><X className="w-4 h-4" /></button>
                  </div>
                  {doneFor === item.id && (
                    <div className="mt-2 flex gap-2">
                      <input value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Feedback (optional)" className={inputClass} />
                      <Button size="sm" variant="primary" loading={busy} onClick={() => completeActivity(item.id)}>Done</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-2">History</p>
        {loading ? <p className="text-xs text-muted">Loading…</p> : data.messages.length === 0 ? (
          <p className="text-xs text-muted">No activity on this record yet.</p>
        ) : (
          <ol className="space-y-3">
            {data.messages.map(message => (
              <li key={message.id} className="flex gap-2.5">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0 ${message.kind === 'NOTE' ? 'bg-accent/15 text-accent' : 'bg-surface-hover text-muted'}`}>
                  {(message.authorName || 'S').split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-muted"><span className="text-foreground font-medium">{message.authorName || 'System'}</span> · {timeAgo(message.createdAt)}</p>
                  <p className={`text-sm whitespace-pre-wrap break-words ${message.kind === 'NOTE' ? 'text-foreground rounded-lg bg-accent/5 px-2.5 py-1.5 mt-1' : 'text-foreground/90'}`}>{message.body}</p>
                  {Array.isArray(message.tracking) && message.tracking.map((change, index) => (
                    <p key={index} className="text-xs text-muted mt-0.5">
                      {change.field}: <span className="line-through">{String(change.from ?? '—')}</span> → <span className="text-foreground">{String(change.to ?? '—')}</span>
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
