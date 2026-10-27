'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Receipt, AlertTriangle, CalendarClock, FileInput, Banknote, Landmark, Scale, Phone, Mail, FileText, Handshake, Printer, Plus, Trash2 } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import { getAccountsDesk, executeFollowUp, getCustomerStatement, saveFollowUpLevels, registerBillPayment } from '@/app/actions/accounts-desk';
import { Badge, Button, Card, EmptyState, Field, Loading, PageHeader, Tabs, inputClass, formatDate, formatINR } from '@/components/erp/kit';

function QueueCard({ icon: Icon, title, value, sub, tone, href, onClick }) {
  const body = (
    <div className="glass-card p-4 h-full hover:border-accent/40 transition-colors">
      <div className="flex items-center gap-2 text-xs text-muted"><Icon className={`w-4 h-4 ${tone === 'red' ? 'text-red-500' : tone === 'amber' ? 'text-amber-500' : 'text-accent'}`} />{title}</div>
      <p className={`mt-2 text-xl font-semibold ${tone === 'red' ? 'text-red-500' : 'text-foreground'}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
    </div>
  );
  if (href) return <Link href={href}>{body}</Link>;
  return <button type="button" onClick={onClick} className="text-left">{body}</button>;
}

const ACTIONS = { EMAIL: { label: 'Email reminder', icon: Mail }, CALL: { label: 'Log / schedule call', icon: Phone }, LETTER: { label: 'Final notice', icon: FileText }, PROMISE: { label: 'Promise to pay', icon: Handshake }, NOTE: { label: 'Note', icon: FileText } };

export default function AccountsDeskPage() {
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('followups');
  const [showAll, setShowAll] = useState(false);
  const [action, setAction] = useState(null);
  const [payment, setPayment] = useState(null);
  const [levels, setLevels] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await getAccountsDesk();
    if (res.success) setData(res.data); else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
  }, [load]);

  const submitAction = async () => {
    setBusy(true);
    const res = await executeFollowUp({ contactId: action.row.contactId, action: action.type, note: action.note || undefined, nextDate: action.nextDate || null });
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(action.type === 'EMAIL' ? 'Reminder emailed and logged' : action.type === 'CALL' ? 'Call scheduled in your activities and logged' : 'Follow-up recorded', { variant: 'success' });
    if (action.type === 'LETTER') printStatement(action.row.contactId, true);
    setAction(null);
    load();
  };

  const printStatement = async (contactId, finalNotice = false) => {
    const res = await getCustomerStatement(contactId);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    const { contact, store, invoices, balance } = res.data;
    const rows = invoices.map(invoice => `<tr><td>${invoice.displayId}</td><td>${new Date(invoice.date).toLocaleDateString('en-IN')}</td><td>${new Date(invoice.due).toLocaleDateString('en-IN')}</td><td style="text-align:right">₹${invoice.total.toLocaleString('en-IN')}</td><td style="text-align:right">₹${invoice.amountPaid.toLocaleString('en-IN')}</td><td style="text-align:right">₹${invoice.balanceDue.toLocaleString('en-IN')}</td><td>${invoice.daysOverdue ? `${invoice.daysOverdue} days` : ''}</td></tr>`).join('');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<html><head><title>Statement ${contact.name}</title><style>body{font-family:Segoe UI,sans-serif;padding:32px;color:#111}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #e5e7eb;padding:8px;font-size:13px;text-align:left}th{font-size:11px;text-transform:uppercase;color:#6b7280}</style></head><body>
      <h2 style="margin:0">${store?.storeName || ''}</h2><div style="font-size:12px;color:#555">${store?.address || ''}${store?.gstNumber ? ` · GSTIN ${store.gstNumber}` : ''}</div>
      <h3>${finalNotice ? 'FINAL NOTICE — ' : ''}Statement of account</h3>
      <p><b>${contact.name}</b> · ${contact.phone || ''}<br/>${contact.address || ''}${contact.gstNumber ? `<br/>GSTIN ${contact.gstNumber}` : ''}</p>
      <p>As of ${new Date().toLocaleDateString('en-IN')}</p>
      <table><thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th>Amount</th><th>Paid</th><th>Balance</th><th>Overdue</th></tr></thead><tbody>${rows}</tbody></table>
      <h3 style="text-align:right">Balance due: ₹${balance.toLocaleString('en-IN')}</h3>
      ${finalNotice ? '<p>Despite our reminders this balance is unpaid. Please settle it within 7 days.</p>' : ''}
      <script>window.print()</script></body></html>`);
    win.document.close();
  };

  const submitPayment = async () => {
    setBusy(true);
    const res = await registerBillPayment({ billId: payment.bill.id, amount: Math.round(Number(payment.amount) || 0), method: payment.method, reference: payment.reference || undefined, paidAt: payment.paidAt || undefined });
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(res.data.residual > 0 ? `Paid — ${formatINR(res.data.residual)} still open on ${payment.bill.displayId}` : `${payment.bill.displayId} fully paid`, { variant: 'success' });
    setPayment(null);
    load();
  };

  const submitLevels = async () => {
    setBusy(true);
    const res = await saveFollowUpLevels({ levels: levels.map(level => ({ id: level.id, name: level.name, days: Math.round(Number(level.days) || 0), action: level.action, message: level.message || undefined })) });
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify('Reminder levels saved', { variant: 'success' });
    setLevels(null);
    load();
  };

  if (loading) return <Loading />;
  if (!data) return null;
  const c = data.cards;
  const followUps = data.followUps.filter(row => showAll || row.needsAction);

  return (
    <div className="space-y-5">
      <PageHeader title="Accounts Desk" subtitle="The accounts team's daily work: collect receivables, chase overdue customers, pay suppliers, keep the books reconciled" breadcrumbs={[{ label: 'Accounting' }, { label: 'Accounts desk' }]} />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <QueueCard icon={Receipt} title="Customers owe" value={formatINR(c.receivable.amount)} sub={`${c.receivable.count} unpaid invoices`} href="/billing" />
        <QueueCard icon={AlertTriangle} title="Overdue" value={formatINR(c.overdue.amount)} sub={`${c.overdue.count} invoices · ${c.overdue.customers} customers`} tone={c.overdue.amount > 0 ? 'red' : undefined} onClick={() => setTab('followups')} />
        <QueueCard icon={CalendarClock} title="Due in 7 days" value={formatINR(c.dueSoon.amount)} sub={`${c.dueSoon.count} invoices`} tone="amber" href="/billing" />
        <QueueCard icon={Phone} title="Follow-ups to do" value={c.followUpsToDo} sub="customers needing action today" tone={c.followUpsToDo ? 'amber' : undefined} onClick={() => { setTab('followups'); setShowAll(false); }} />
        <QueueCard icon={FileInput} title="Bills to pay" value={formatINR(c.billsToPay.amount)} sub={`${c.billsToPay.count} bills · ${c.billsOverdue.count} overdue · ${c.billsDraft} draft to post`} tone={c.billsOverdue.count ? 'red' : undefined} onClick={() => setTab('bills')} />
        <QueueCard icon={Landmark} title="Bank & cash (books)" value={formatINR((c.bank || 0) + (c.cash || 0))} sub={`Bank ${formatINR(c.bank || 0)} · Cash ${formatINR(c.cash || 0)}`} href="/accounting" />
        <QueueCard icon={Scale} title="GST payable (net)" value={c.gstNet == null ? '—' : formatINR(c.gstNet)} sub="output − input credit, from the journal" href="/gst" />
        <QueueCard icon={Banknote} title="Daily payments to reconcile" value={c.unreconciled} sub="pending in Daily Payments" href="/payments" />
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ key: 'followups', label: 'Payment follow-ups', count: c.followUpsToDo }, { key: 'bills', label: 'Bills to pay', count: c.billsToPay.count }, { key: 'levels', label: 'Reminder levels' }]} />
        {tab === 'followups' && <label className="flex items-center gap-2 text-sm text-muted md:ml-auto"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show snoozed / promised customers too</label>}
      </div>

      {tab === 'followups' && (
        <Card padded={false}>
          {followUps.length === 0 ? <EmptyState icon={Handshake} title={data.followUps.length ? 'All caught up' : 'No overdue customers'} text={data.followUps.length ? 'Every overdue customer has a follow-up scheduled or a promised date.' : 'Nothing is past due.'} /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Customer', 'Overdue', 'Oldest', 'Level', 'Last follow-up', 'Next action', ''].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {followUps.map(row => (
                    <tr key={row.contactId} className="border-b border-border/50 align-top">
                      <td className="px-4 py-3"><p className="text-foreground font-medium">{row.name}</p><p className="text-[11px] text-muted">{row.phone}{row.email ? ` · ${row.email}` : ''}</p><p className="text-[11px] text-muted">{row.invoices.map(invoice => invoice.displayId).join(', ')}</p></td>
                      <td className="px-4 py-3"><p className="text-red-500 font-semibold">{formatINR(row.overdueAmount)}</p>{row.totalDue > row.overdueAmount && <p className="text-[11px] text-muted">of {formatINR(row.totalDue)} due</p>}</td>
                      <td className="px-4 py-3">{row.oldestDays} days</td>
                      <td className="px-4 py-3">{row.level ? <Badge tone={row.level.action === 'LETTER' ? 'red' : row.level.action === 'CALL' ? 'amber' : 'blue'}>{row.level.name}</Badge> : <span className="text-muted">Before first level</span>}</td>
                      <td className="px-4 py-3 text-xs text-muted">{row.lastAction ? <>{ACTIONS[row.lastAction.action]?.label || row.lastAction.action} · {formatDate(row.lastAction.at)}<br />{row.lastAction.by}{row.lastAction.note ? ` — ${row.lastAction.note}` : ''}</> : 'Never'}</td>
                      <td className="px-4 py-3 text-xs">{row.nextDate ? <span className={row.needsAction ? 'text-red-500' : 'text-muted'}>{formatDate(row.nextDate)}</span> : <span className="text-amber-500">Today</span>}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1 justify-end">
                          {row.level && <Button size="sm" variant="primary" icon={ACTIONS[row.level.action].icon} onClick={() => setAction({ row, type: row.level.action, note: '', nextDate: '' })}>{ACTIONS[row.level.action].label}</Button>}
                          <Button size="sm" icon={Handshake} onClick={() => setAction({ row, type: 'PROMISE', note: '', nextDate: '' })}>Promise</Button>
                          <Button size="sm" icon={Printer} onClick={() => printStatement(row.contactId)}>Statement</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'bills' && (
        <Card padded={false}>
          {data.bills.length === 0 ? <EmptyState icon={FileInput} title="No open vendor bills" text="Posted bills with an open amount appear here, oldest due date first." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Bill', 'Supplier', 'Supplier invoice', 'Due', 'Total', 'Paid', 'Open', ''].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {data.bills.map(bill => (
                    <tr key={bill.id} className="border-b border-border/50">
                      <td className="px-4 py-3"><Link href={`/vendor-bills/${bill.id}`} className="text-accent font-medium">{bill.displayId}</Link><div className="text-[11px] text-muted">{bill.po?.displayId}</div></td>
                      <td className="px-4 py-3 text-foreground">{bill.supplier?.name}</td>
                      <td className="px-4 py-3 text-muted">{bill.vendorRef || '—'}</td>
                      <td className={`px-4 py-3 ${bill.overdue ? 'text-red-500 font-medium' : 'text-muted'}`}>{formatDate(bill.dueDate)}{bill.overdue ? ' · overdue' : ''}</td>
                      <td className="px-4 py-3">{formatINR(bill.total)}</td>
                      <td className="px-4 py-3 text-muted">{formatINR(bill.amountPaid)}</td>
                      <td className="px-4 py-3 font-semibold">{formatINR(bill.residual)}</td>
                      <td className="px-4 py-3 text-right"><Button size="sm" variant="primary" icon={Banknote} onClick={() => setPayment({ bill, amount: bill.residual, method: 'Bank Transfer', reference: '', paidAt: new Date().toISOString().slice(0, 10) })}>Pay</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'levels' && (
        <Card title="Reminder levels" actions={isAdmin && !levels && <Button size="sm" onClick={() => setLevels(data.levels.map(level => ({ ...level, message: level.message || '' })))}>Edit levels</Button>}>
          {!levels ? (
            <ul className="space-y-2">
              {data.levels.map(level => (
                <li key={level.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2">
                  <Badge tone={level.action === 'LETTER' ? 'red' : level.action === 'CALL' ? 'amber' : 'blue'}>{level.days}+ days</Badge>
                  <div><p className="text-sm text-foreground font-medium">{level.name} · {ACTIONS[level.action]?.label}</p>{level.message && <p className="text-xs text-muted">{level.message}</p>}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3">
              {levels.map((level, index) => (
                <div key={level.id || `new-${index}`} className="grid grid-cols-1 md:grid-cols-[1fr_90px_160px_auto] gap-2 items-start rounded-lg border border-border p-3">
                  <div className="space-y-2">
                    <input value={level.name} onChange={e => setLevels(levels.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} placeholder="Level name" className={inputClass} />
                    <textarea rows={2} value={level.message} onChange={e => setLevels(levels.map((item, i) => i === index ? { ...item, message: e.target.value } : item))} placeholder="Message used in the reminder" className={inputClass} />
                  </div>
                  <input type="number" min="1" value={level.days} onChange={e => setLevels(levels.map((item, i) => i === index ? { ...item, days: e.target.value } : item))} title="Days after due" className={inputClass} />
                  <select value={level.action} onChange={e => setLevels(levels.map((item, i) => i === index ? { ...item, action: e.target.value } : item))} className={inputClass}>
                    <option value="EMAIL">Email reminder</option><option value="CALL">Phone call</option><option value="LETTER">Final notice</option>
                  </select>
                  <button type="button" onClick={() => setLevels(levels.filter((_, i) => i !== index))} className="p-2 text-muted hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button size="sm" icon={Plus} onClick={() => setLevels([...levels, { name: '', days: 45, action: 'CALL', message: '' }])}>Add level</Button>
                <Button size="sm" variant="ghost" onClick={() => setLevels(null)}>Discard</Button>
                <Button size="sm" variant="primary" loading={busy} onClick={submitLevels}>Save levels</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Modal isOpen={!!action} onClose={() => setAction(null)} title={action ? `${ACTIONS[action.type].label} · ${action.row.name}` : ''} size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setAction(null)}>Discard</Button><Button variant="primary" loading={busy} onClick={submitAction}>{action?.type === 'EMAIL' ? 'Send & log' : 'Record'}</Button></div>}>
        {action && (
          <div className="space-y-3">
            <p className="text-sm text-muted">{formatINR(action.row.overdueAmount)} overdue, oldest {action.row.oldestDays} days.{action.type === 'EMAIL' && (action.row.email ? ` A reminder with the overdue invoices goes to ${action.row.email}.` : ' This customer has no email address.')}{action.type === 'CALL' && ' A call is added to your activities for today.'}{action.type === 'LETTER' && ' A final-notice statement opens for printing.'}</p>
            <Field label={action.type === 'PROMISE' ? 'Promised payment date' : 'Next follow-up (default: in 7 days)'}><input type="date" value={action.nextDate} onChange={e => setAction({ ...action, nextDate: e.target.value })} className={inputClass} /></Field>
            <Field label="Note"><textarea rows={2} value={action.note} onChange={e => setAction({ ...action, note: e.target.value })} placeholder={action.type === 'PROMISE' ? 'e.g. Will pay ₹50,000 by NEFT on Friday' : 'What was said / agreed'} className={inputClass} /></Field>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!payment} onClose={() => setPayment(null)} title={payment ? `Pay ${payment.bill.displayId} · ${payment.bill.supplier?.name}` : ''} size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setPayment(null)}>Discard</Button><Button variant="primary" loading={busy} onClick={submitPayment}>Record payment</Button></div>}>
        {payment && (
          <div className="space-y-3">
            <Field label={`Amount (open ${formatINR(payment.bill.residual)})`}><input type="number" min="1" value={payment.amount} onChange={e => setPayment({ ...payment, amount: e.target.value })} className={inputClass} /></Field>
            <Field label="Method"><select value={payment.method} onChange={e => setPayment({ ...payment, method: e.target.value })} className={inputClass}>{['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Card'].map(method => <option key={method}>{method}</option>)}</select></Field>
            <Field label="Reference (UTR / cheque no.)"><input value={payment.reference} onChange={e => setPayment({ ...payment, reference: e.target.value })} className={inputClass} /></Field>
            <Field label="Payment date"><input type="date" value={payment.paidAt} onChange={e => setPayment({ ...payment, paidAt: e.target.value })} className={inputClass} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
