'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, XCircle, Save, Truck, AlertTriangle, Banknote } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import Chatter from '@/components/erp/Chatter';
import { Badge, Button, Card, Field, Loading, PageHeader, SmartButton, StatusBar, inputClass, formatDate, formatINR, toInputDate } from '@/components/erp/kit';
import { getVendorBill, updateVendorBill, postVendorBill, cancelVendorBill } from '@/app/actions/vendor-bills';
import { registerBillPayment, applyPoAdvancesToBill } from '@/app/actions/accounts-desk';

export default function VendorBillPage() {
  const { id } = useParams();
  const billId = Number(id);
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const [bill, setBill] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [variance, setVariance] = useState(null);
  const [chatterKey, setChatterKey] = useState(0);
  const [payment, setPayment] = useState(null);

  const load = useCallback(async () => {
    const res = await getVendorBill(billId);
    if (res.success) {
      setBill(res.data);
      setForm({
        vendorRef: res.data.vendorRef || '', billDate: toInputDate(res.data.billDate), dueDate: toInputDate(res.data.dueDate), notes: res.data.notes || '',
        lines: Object.fromEntries(res.data.lines.map(line => [line.id, { quantity: line.quantity, unitCost: line.unitCost }])),
      });
    } else notify(res.error, { variant: 'danger' });
    setLoading(false);
    setChatterKey(key => key + 1);
  }, [billId, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);

  if (loading) return <Loading />;
  if (!bill) return <p className="text-sm text-muted">Bill not found.</p>;

  const draft = bill.status === 'DRAFT';
  const save = async (quiet) => {
    setBusy('save');
    const res = await updateVendorBill({
      id: billId, vendorRef: form.vendorRef, billDate: form.billDate || undefined, dueDate: form.dueDate || null, notes: form.notes,
      lines: Object.entries(form.lines).map(([lineId, line]) => ({ id: Number(lineId), quantity: Math.max(0, Math.round(Number(line.quantity) || 0)), unitCost: Math.max(0, Math.round(Number(line.unitCost) || 0)) })),
    });
    setBusy('');
    if (!res.success) { notify(res.error, { variant: 'danger' }); return false; }
    if (!quiet) notify('Bill saved', { variant: 'success' });
    await load();
    return true;
  };

  const post = async (acceptVariance = false) => {
    if (!(await save(true))) return;
    setBusy('post');
    const res = await postVendorBill(billId, { acceptVariance });
    setBusy('');
    if (!res.success) {
      if (res.error.startsWith('Price differs') && isAdmin) setVariance(res.error);
      else notify(res.error, { variant: 'danger' });
      return;
    }
    setVariance(null);
    notify(res.data.matched ? 'Bill posted — matched to PO and receipts' : 'Bill posted with accepted price variance', { variant: 'success' });
    load();
  };

  const pay = async () => {
    setBusy('pay');
    const res = await registerBillPayment({ billId, amount: Math.round(Number(payment.amount) || 0), method: payment.method, reference: payment.reference || undefined, paidAt: payment.paidAt || undefined });
    setBusy('');
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(res.data.residual > 0 ? `Payment recorded — ${formatINR(res.data.residual)} still open` : 'Bill fully paid', { variant: 'success' });
    setPayment(null);
    load();
  };

  const cancel = async () => {
    setBusy('cancel');
    const res = await cancelVendorBill(billId);
    setBusy('');
    if (!res.success) return notify(res.error, { variant: 'danger' });
    load();
  };

  const previewTotal = bill.lines.reduce((sum, line) => {
    const value = form.lines[line.id] || line;
    const amount = (Number(value.quantity) || 0) * (Number(value.unitCost) || 0);
    return sum + amount + Math.round(amount * line.gstRate / 100);
  }, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={bill.displayId}
        subtitle={`${bill.supplier?.name}${bill.vendorRef ? ` · Invoice ${bill.vendorRef}` : ''}`}
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Vendor bills', href: '/vendor-bills' }, { label: bill.displayId }]}
        actions={(
          <>
            {draft && <Button variant="primary" icon={CheckCircle2} loading={busy === 'post'} onClick={() => post(false)}>Post bill</Button>}
            {draft && <Button icon={Save} loading={busy === 'save'} onClick={() => save(false)}>Save</Button>}
            {bill.status === 'POSTED' && bill.residual > 0 && <Button variant="primary" icon={Banknote} onClick={() => setPayment({ amount: bill.residual, method: 'Bank Transfer', reference: '', paidAt: new Date().toISOString().slice(0, 10) })}>Register payment</Button>}
            {bill.status !== 'CANCELLED' && <Button variant="danger" icon={XCircle} loading={busy === 'cancel'} onClick={cancel}>{bill.status === 'POSTED' ? 'Cancel (reverse)' : 'Cancel'}</Button>}
          </>
        )}
      />
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
        <StatusBar current={bill.status} steps={bill.status === 'CANCELLED' ? [{ key: 'DRAFT', label: 'Draft' }, { key: 'CANCELLED', label: 'Cancelled' }] : [{ key: 'DRAFT', label: 'Draft' }, { key: 'POSTED', label: 'Posted' }]} />
        <div className="flex gap-2 flex-wrap items-center">
          {bill.status === 'POSTED' && (bill.residual === 0 ? <Badge tone="green">Paid</Badge> : bill.amountPaid > 0 ? <Badge tone="blue">Partially paid · {formatINR(bill.residual)} open</Badge> : <Badge tone="amber">Not paid</Badge>)}
          {bill.matchStatus === 'MATCHED' ? <Badge tone="green">3-way matched</Badge> : <Badge tone="amber"><AlertTriangle className="w-3 h-3" /> To check</Badge>}
          {bill.po && <SmartButton icon={Truck} label={`Paid ${formatINR(bill.po.amountPaid)} · due ${formatINR(bill.po.balanceDue)}`} value={bill.po.displayId} href="/purchases" />}
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Field label="Supplier invoice no."><input disabled={!draft} value={form.vendorRef} onChange={e => setForm({ ...form, vendorRef: e.target.value })} placeholder="Required to post" className={inputClass} /></Field>
              <Field label="Bill date"><input disabled={!draft} type="date" value={form.billDate} onChange={e => setForm({ ...form, billDate: e.target.value })} className={inputClass} /></Field>
              <Field label="Due date"><input disabled={!draft} type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} className={inputClass} /></Field>
              <Field label="Supplier GSTIN"><input disabled value={bill.supplier?.gstNumber || '—'} className={inputClass} /></Field>
            </div>
          </Card>

          <Card title="Bill lines — ordered vs received vs billed" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-y border-border text-[11px] uppercase text-muted text-left">
                  <th className="px-4 py-2">Product</th><th className="px-4 py-2 text-right">Ordered</th><th className="px-4 py-2 text-right">Received</th><th className="px-4 py-2 text-right">Billable</th><th className="px-4 py-2 text-right w-28">Bill qty</th><th className="px-4 py-2 text-right">PO price</th><th className="px-4 py-2 text-right w-32">Bill price</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Match</th>
                </tr></thead>
                <tbody>
                  {bill.lines.map(line => {
                    const value = form.lines[line.id] || line;
                    const qty = Number(value.quantity) || 0;
                    const price = Number(value.unitCost) || 0;
                    const qtyOk = !line.poItem || qty <= line.match.billable;
                    const priceOk = !line.poItem || price === line.poItem.unitCost;
                    return (
                      <tr key={line.id} className="border-b border-border/50">
                        <td className="px-4 py-2.5 text-foreground">{line.name}<div className="text-[11px] text-muted">GST {line.gstRate}%</div></td>
                        <td className="px-4 py-2.5 text-right text-muted">{line.poItem?.quantity ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right text-muted">{line.poItem?.receivedQty ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right text-muted">{line.poItem ? line.match.billable : '—'}</td>
                        <td className="px-4 py-2.5">{draft ? <input type="number" min="0" value={value.quantity} onChange={e => setForm({ ...form, lines: { ...form.lines, [line.id]: { ...value, quantity: e.target.value } } })} className={`${inputClass} text-right ${qtyOk ? '' : 'border-red-500'}`} /> : <span className="block text-right">{line.quantity}</span>}</td>
                        <td className="px-4 py-2.5 text-right text-muted">{line.poItem ? formatINR(line.poItem.unitCost) : '—'}</td>
                        <td className="px-4 py-2.5">{draft ? <input type="number" min="0" value={value.unitCost} onChange={e => setForm({ ...form, lines: { ...form.lines, [line.id]: { ...value, unitCost: e.target.value } } })} className={`${inputClass} text-right ${priceOk ? '' : 'border-amber-500'}`} /> : <span className="block text-right">{formatINR(line.unitCost)}</span>}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-foreground">{formatINR(qty * price)}</td>
                        <td className="px-4 py-2.5">{!qtyOk ? <Badge tone="red">Exceeds receipt</Badge> : !priceOk ? <Badge tone="amber">Price {price > (line.poItem?.unitCost || 0) ? '+' : ''}{formatINR((price - (line.poItem?.unitCost || 0)) * qty)}</Badge> : <Badge tone="green">OK</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end p-4">
              <dl className="w-full max-w-xs text-sm space-y-1">
                <div className="flex justify-between"><dt className="text-muted">Untaxed</dt><dd className="text-foreground">{formatINR(bill.subtotal)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">{bill.supplyType === 'INTERSTATE' ? 'IGST' : 'CGST + SGST'}</dt><dd className="text-foreground">{formatINR(bill.gst)}</dd></div>
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><dt className="text-foreground">Total</dt><dd className="text-foreground">{formatINR(draft ? previewTotal : bill.total)}</dd></div>
              </dl>
            </div>
          </Card>
          {draft && <p className="text-[11px] text-muted">Quantities can never exceed goods received (from GRNs). A price different from the PO marks the bill “To check”; only an administrator can post it with the variance accepted.</p>}
          {bill.status === 'POSTED' && bill.residual > 0 && bill.outstandingAdvances > 0 && (
            <div className="glass-card p-3 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-foreground">{formatINR(bill.outstandingAdvances)} was paid on {bill.po?.displayId} before this bill and is not applied yet.</span>
              <Button size="sm" variant="primary" loading={busy === 'advance'} onClick={async () => {
                setBusy('advance');
                const res = await applyPoAdvancesToBill(billId);
                setBusy('');
                if (!res.success) return notify(res.error, { variant: 'danger' });
                notify(`Applied ${formatINR(res.data.applied)} — ${formatINR(res.data.residual)} still open`, { variant: 'success' });
                load();
              }}>Apply to this bill</Button>
            </div>
          )}
          {bill.payments?.length > 0 && (
            <Card title="Payments">
              <ul className="space-y-1 text-sm">
                {bill.payments.map(row => <li key={row.id} className="flex justify-between gap-3"><span className="text-muted">{formatDate(row.paidAt)} · {row.method}{row.reference ? ` · ${row.reference}` : ''}{row.createdBy ? ` · ${row.createdBy}` : ''}</span><span className="text-foreground font-medium">{formatINR(row.amount)}</span></li>)}
                <li className="flex justify-between border-t border-border pt-1 font-semibold"><span>Open amount</span><span>{formatINR(bill.residual)}</span></li>
              </ul>
            </Card>
          )}
          <Card title="Notes"><textarea disabled={!draft} rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className={inputClass} /></Card>
        </div>
        <Chatter resModel="VendorBill" resId={billId} resName={`${bill.displayId} · ${bill.supplier?.name || ''}`} refreshKey={chatterKey} />
      </div>

      <Modal isOpen={!!payment} onClose={() => setPayment(null)} title={`Pay ${bill.displayId}`} size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setPayment(null)}>Discard</Button><Button variant="primary" loading={busy === 'pay'} onClick={pay}>Record payment</Button></div>}>
        {payment && (
          <div className="space-y-3">
            <Field label={`Amount (open ${formatINR(bill.residual)})`}><input type="number" min="1" max={bill.residual} value={payment.amount} onChange={e => setPayment({ ...payment, amount: e.target.value })} className={inputClass} /></Field>
            <Field label="Method">
              <select value={payment.method} onChange={e => setPayment({ ...payment, method: e.target.value })} className={inputClass}>
                {['Bank Transfer', 'UPI', 'Cheque', 'Cash', 'Card'].map(method => <option key={method}>{method}</option>)}
              </select>
            </Field>
            <Field label="Reference (UTR / cheque no.)"><input value={payment.reference} onChange={e => setPayment({ ...payment, reference: e.target.value })} className={inputClass} /></Field>
            <Field label="Payment date"><input type="date" value={payment.paidAt} onChange={e => setPayment({ ...payment, paidAt: e.target.value })} className={inputClass} /></Field>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!variance} onClose={() => setVariance(null)} title="Accept price variance?" size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setVariance(null)}>Back</Button><Button variant="primary" loading={busy === 'post'} onClick={() => post(true)}>Accept and post</Button></div>}>
        <p className="text-sm text-muted">{variance}</p>
        <p className="text-sm text-muted mt-2">The bill will be posted and kept in the “To check” list for review.</p>
      </Modal>
    </div>
  );
}
