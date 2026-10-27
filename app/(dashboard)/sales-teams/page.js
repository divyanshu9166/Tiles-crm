'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Users, Target, Settings2, ChevronRight, UserCheck, AlertTriangle } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import { getSalesTeams, saveSalesTeam, getTeamDashboard, assignUnassignedLeads, setMemberCapacity } from '@/app/actions/sales-teams';
import { Badge, Button, Card, EmptyState, Field, Loading, PageHeader, inputClass, formatINR } from '@/components/erp/kit';

const FLOW_LINKS = { NEW: '/leads', CONTACTED: '/leads', SHOWROOM_VISIT: '/leads', QUOTATION: '/quotations', ORDER: '/sales-orders', TO_DELIVER: '/operations?type=DELIVERY', TO_INVOICE: '/sales-orders', INVOICED: '/billing', PAID: '/payments' };

function Progress({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  return (
    <div className="h-2 rounded-full bg-surface-hover overflow-hidden">
      <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : pct >= 60 ? 'bg-accent' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function SalesTeamsPage() {
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const canManage = ['ADMIN', 'MANAGER'].includes(session?.user?.role);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dashboard, setDashboard] = useState(null);
  const [config, setConfig] = useState({ teams: [], staff: [] });
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [assigning, setAssigning] = useState(null);

  const load = useCallback(async () => {
    const [dash, cfg] = await Promise.all([getTeamDashboard(month), getSalesTeams()]);
    if (dash.success) setDashboard(dash.data); else notify(dash.error, { variant: 'danger' });
    if (cfg.success) setConfig(cfg.data);
    setLoading(false);
  }, [month, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / month change
    load();
  }, [load]);

  const openForm = (team) => setForm(team
    ? { id: team.id, name: team.name, leaderId: team.leader?.id ? String(team.leader.id) : '', monthlyTarget: team.monthlyTarget, autoAssign: team.autoAssign, active: team.active, memberIds: team.members.map(member => member.id), capacities: Object.fromEntries(team.members.map(member => [member.id, member.leadCapacity])) }
    : { name: '', leaderId: '', monthlyTarget: 0, autoAssign: false, active: true, memberIds: [], capacities: {} });

  const submit = async () => {
    setSaving(true);
    const res = await saveSalesTeam({ id: form.id, name: form.name, leaderId: form.leaderId ? Number(form.leaderId) : null, monthlyTarget: Math.round(Number(form.monthlyTarget) || 0), autoAssign: form.autoAssign, active: form.active, memberIds: form.memberIds });
    if (res.success) {
      for (const [staffId, capacity] of Object.entries(form.capacities)) {
        if (form.memberIds.includes(Number(staffId))) await setMemberCapacity(Number(staffId), Math.max(0, Math.round(Number(capacity) || 0)));
      }
    }
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setForm(null);
    load();
  };

  const assign = async (teamId) => {
    setAssigning(teamId);
    const res = await assignUnassignedLeads(teamId);
    setAssigning(null);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(`${res.data.assigned} lead(s) assigned round-robin${res.data.waiting ? ` · ${res.data.waiting} waiting (members at capacity)` : ''}`, { variant: 'success' });
    load();
  };

  if (loading) return <Loading />;
  const teams = dashboard?.teams || [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales Teams"
        subtitle="Lead → quotation → sales order → delivery → invoice → collection, per team and salesperson"
        breadcrumbs={[{ label: 'Sales' }, { label: 'Teams' }]}
        actions={(
          <>
            <input type="month" value={month} onChange={e => setMonth(e.target.value)} className={`${inputClass} w-40`} />
            {canManage && <Button variant="primary" icon={Plus} onClick={() => openForm(null)}>New team</Button>}
          </>
        )}
      />

      {dashboard?.unassignedLeads > 0 && (
        <div className="glass-card p-3 flex items-center gap-3 text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <span className="text-foreground">{dashboard.unassignedLeads} open lead(s) have no salesperson.</span>
          <span className="text-muted">Assign them to a team below, or turn on auto-assignment so new leads are shared round-robin.</span>
        </div>
      )}

      {teams.length === 0 ? (
        <Card><EmptyState icon={Users} title="No sales teams yet" text="Group salespeople into teams (e.g. Showroom, Projects/Builders, Dealers), give each a monthly target and let new leads be shared automatically." action={canManage && <Button variant="primary" icon={Plus} onClick={() => openForm(null)}>Create a team</Button>} /></Card>
      ) : teams.map(team => {
        const configTeam = config.teams.find(item => item.id === team.id);
        return (
          <Card key={team.id} title={(
            <span className="flex items-center gap-2 flex-wrap">
              {team.name}
              {team.leader && <span className="text-xs text-muted font-normal">· Leader {team.leader.name}</span>}
              {team.autoAssign && <Badge tone="blue">Auto-assigns leads</Badge>}
            </span>
          )} actions={(
            <div className="flex gap-2">
              {canManage && dashboard.unassignedLeads > 0 && <Button size="sm" icon={UserCheck} loading={assigning === team.id} onClick={() => assign(team.id)}>Assign leads</Button>}
              {canManage && configTeam && <Button size="sm" icon={Settings2} onClick={() => openForm(configTeam)}>Configure</Button>}
            </div>
          )}>
            <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-5">
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm"><Target className="w-4 h-4 text-accent" /><span className="text-muted">Invoiced this month</span></div>
                <p className="text-2xl font-semibold text-foreground">{formatINR(team.invoiced)}</p>
                {team.monthlyTarget > 0 ? (
                  <>
                    <Progress value={team.progress} />
                    <p className="text-xs text-muted">{team.progress}% of {formatINR(team.monthlyTarget)} target · {formatINR(Math.max(0, team.monthlyTarget - team.invoiced))} to go</p>
                  </>
                ) : <p className="text-xs text-muted">No monthly target set.</p>}
                <div className="grid grid-cols-3 gap-2 pt-2">
                  <div><p className="text-lg font-semibold text-foreground">{formatINR(team.collected)}</p><p className="text-[11px] text-muted">Collected</p></div>
                  <div><p className="text-lg font-semibold text-emerald-500">{team.won}</p><p className="text-[11px] text-muted">Won</p></div>
                  <div><p className="text-lg font-semibold text-red-500">{team.lost}</p><p className="text-[11px] text-muted">Lost</p></div>
                </div>
              </div>

              <div className="space-y-4 min-w-0">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-2">Team flow</p>
                  <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
                    {team.funnel.map((step, index) => (
                      <Fragment key={step.key}>
                        {index > 0 && <ChevronRight className="w-4 h-4 text-muted self-center shrink-0" />}
                        <Link href={FLOW_LINKS[step.key]} className="shrink-0 min-w-[110px] rounded-lg border border-border px-3 py-2 hover:bg-surface-hover">
                          <p className="text-lg font-semibold text-foreground">{step.count}</p>
                          <p className="text-[11px] text-muted whitespace-nowrap">{step.label}</p>
                          {step.value != null && <p className="text-[11px] text-accent">{formatINR(step.value)}</p>}
                        </Link>
                      </Fragment>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead><tr className="border-y border-border text-left text-[11px] uppercase text-muted">
                      {['Salesperson', 'Open leads', 'Won / lost', 'Win rate', 'Quotations', 'Orders (month)', 'Invoiced', 'Collected', 'Overdue activities'].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {team.members.length === 0 ? <tr><td colSpan={9} className="px-3 py-4 text-xs text-muted">No members yet — configure the team to add salespeople.</td></tr> : team.members.map((member, index) => (
                        <tr key={member.staffId} className="border-b border-border/50">
                          <td className="px-3 py-2"><span className="text-foreground">{index === 0 && member.invoiced > 0 ? '🏆 ' : ''}{member.name}</span><div className="text-[11px] text-muted">{member.role}</div></td>
                          <td className="px-3 py-2">{member.openLeads}</td>
                          <td className="px-3 py-2"><span className="text-emerald-500">{member.wonLeads}</span> / <span className="text-red-500">{member.lostLeads}</span></td>
                          <td className="px-3 py-2">{member.conversion == null ? '—' : `${member.conversion}%`}</td>
                          <td className="px-3 py-2">{member.quotations}<div className="text-[11px] text-muted">{formatINR(member.quotationValue)}</div></td>
                          <td className="px-3 py-2">{member.orders}<div className="text-[11px] text-muted">{formatINR(member.orderValue)}</div></td>
                          <td className="px-3 py-2 font-medium">{formatINR(member.invoiced)}</td>
                          <td className="px-3 py-2">{formatINR(member.collected)}</td>
                          <td className="px-3 py-2">{member.overdueActivities > 0 ? <Badge tone="red">{member.overdueActivities}</Badge> : <span className="text-muted">0</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </Card>
        );
      })}

      <Modal isOpen={!!form} onClose={() => setForm(null)} title={form?.id ? 'Configure team' : 'New sales team'} size="lg"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setForm(null)}>Discard</Button><Button variant="primary" loading={saving} onClick={submit}>Save team</Button></div>}>
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Team name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Projects & Builders" className={inputClass} /></Field>
              <Field label="Monthly invoicing target (₹)"><input type="number" min="0" value={form.monthlyTarget} onChange={e => setForm({ ...form, monthlyTarget: e.target.value })} className={inputClass} /></Field>
              <Field label="Team leader">
                <select value={form.leaderId} onChange={e => setForm({ ...form, leaderId: e.target.value })} className={inputClass}>
                  <option value="">—</option>
                  {config.staff.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
                </select>
              </Field>
              <div className="space-y-2 pt-5">
                <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={form.autoAssign} onChange={e => setForm({ ...form, autoAssign: e.target.checked })} /> Auto-assign new leads round-robin</label>
                <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Active</label>
              </div>
            </div>
            <div>
              <p className="text-xs text-muted mb-2">Members (a salesperson belongs to one team; capacity = max open leads for auto-assignment, 0 = no limit)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                {config.staff.map(member => {
                  const checked = form.memberIds.includes(member.id);
                  const elsewhere = member.salesTeamId && member.salesTeamId !== form.id;
                  return (
                    <div key={member.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${checked ? 'border-accent bg-accent/5' : 'border-border'}`}>
                      <input type="checkbox" checked={checked} onChange={e => setForm({ ...form, memberIds: e.target.checked ? [...form.memberIds, member.id] : form.memberIds.filter(id => id !== member.id) })} />
                      <div className="flex-1 min-w-0"><p className="text-sm text-foreground truncate">{member.name}</p><p className="text-[11px] text-muted truncate">{member.role}{elsewhere ? ' · in another team' : ''}</p></div>
                      {checked && <input type="number" min="0" title="Lead capacity" value={form.capacities[member.id] ?? 0} onChange={e => setForm({ ...form, capacities: { ...form.capacities, [member.id]: e.target.value } })} className={`${inputClass} !w-16 text-right`} />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
