'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Truck, FileText, Receipt, Lock, XCircle, Pencil, PackagePlus, Printer } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import Chatter from '@/components/erp/Chatter';
import {
  Badge, Button, Card, Field, InfoGrid, Loading, PageHeader, SmartButton, StatusBar, inputClass,
  formatDate, formatINR, formatQty, toInputDate, SO_DELIVERY, SO_INVOICE, SO_STATUS, PICKING_STATUS,
} from '@/components/erp/kit';
import {
  getSalesOrder, createInvoiceFromSalesOrder, lockSalesOrder, cancelSalesOrder, updateSalesOrder, planSalesOrderDelivery, createRefundFromSalesOrder,
} from '@/app/actions/sales-orders';
import { getStaff } from '@/app/actions/staff';

export default function SalesOrderPage() {
  const { id } = useParams();
  const orderId = Number(id);
  const router = useRouter();
  const { notify } = useAlertToast();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [chatterKey, setChatterKey] = useState(0);
  const [invoiceDraft, setInvoiceDraft] = useState(null);
  const [edit, setEdit] = useState(null);
  const [staff, setStaff] = useState([]);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    const res = await getSalesOrder(orderId);
    if (res.success) setOrder(res.data);
    else notify(res.error, { variant: 'danger' });
    setLoading(false);
    setChatterKey(key => key + 1);
  }, [orderId, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);

  const run = async (key, action, success) => {
    setBusy(key);
    const res = await action();
    setBusy('');
    if (!res.success) { notify(res.error, { variant: 'danger' }); return null; }
    if (success) notify(success, { variant: 'success' });
    await load();
    return res;
  };

  if (loading) return <Loading />;
  if (!order) return <p className="text-sm text-muted">Sales order not found.</p>;

  const open = order.status === 'CONFIRMED';
  const toInvoice = order.lines.reduce((sum, line) => sum + line.toInvoice, 0);
  const openDeliveries = order.pickings.filter(picking => picking.status === 'READY');
  const unplanned = order.lines.some(line => line.quantity > line.qtyDelivered) && openDeliveries.length === 0;

  const openInvoiceDraft = () => setInvoiceDraft({
    dueDate: '',
    lines: Object.fromEntries(order.lines.map(line => [line.id, line.toInvoice])),
  });

  const submitInvoice = async () => {
    const res = await run('invoice', () => createInvoiceFromSalesOrder({
      orderId,
      dueDate: invoiceDraft.dueDate || undefined,
      lines: Object.entries(invoiceDraft.lines).map(([lineId, quantity]) => ({ lineId: Number(lineId), quantity: Math.max(0, Math.round(Number(quantity) || 0)) })),
    }), null);
    if (res) {
      setInvoiceDraft(null);
      notify(`Invoice ${res.data.displayId} created for ${formatINR(res.data.total)}. Record payments in Billing.`, { variant: 'success' });
    }
  };

  const openEdit = async () => {
    setEdit({
      commitmentDate: toInputDate(order.commitmentDate), invoicePolicy: order.invoicePolicy, salespersonId: order.salespersonId ? String(order.salespersonId) : '',
      dispatchAddress: order.dispatchAddress || '', customerReference: order.customerReference || '', notes: order.notes || '',
    });
    if (staff.length === 0) { const res = await getStaff(); if (res.success) setStaff(res.data); }
  };

  const submitEdit = async () => {
    const res = await run('edit', () => updateSalesOrder({
      id: orderId,
      commitmentDate: edit.commitmentDate || null,
      invoicePolicy: edit.invoicePolicy,
      salespersonId: edit.salespersonId ? Number(edit.salespersonId) : null,
      dispatchAddress: edit.dispatchAddress,
      customerReference: edit.customerReference,
      notes: edit.notes,
    }), 'Order updated');
    if (res) setEdit(null);
  };

  const print = () => {
    const rows = order.lines.map((line, index) => `<tr><td>${index + 1}</td><td>${line.name}<br/><small>${line.sku}</small></td><td>${line.unitOfMeasure}</td><td style="text-align:right">${line.quantity}</td><td style="text-align:right">${line.areaSqft ? formatQty(line.areaSqft) : '-'}</td><td style="text-align:right">₹${line.price.toLocaleString('en-IN')}</td><td style="text-align:right">₹${line.amount.toLocaleString('en-IN')}</td></tr>`).join('');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<html><head><title>${order.displayId}</title><style>body{font-family:Segoe UI,sans-serif;padding:32px;color:#111}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border-bottom:1px solid #e5e7eb;padding:8px;font-size:13px;text-align:left}th{font-size:11px;text-transform:uppercase;color:#6b7280}.tot{margin-top:16px;text-align:right;font-size:14px}</style></head><body>
      <h2>Sales Order ${order.displayId}</h2>
      <p><b>${order.contact?.name}</b> · ${order.contact?.phone || ''}<br/>${order.dispatchAddress || ''}</p>
      <p>Order date: ${formatDate(order.orderDate)} · Delivery: ${formatDate(order.commitmentDate)}${order.projectName ? ` · Project: ${order.projectName}` : ''}</p>
      <table><thead><tr><th>#</th><th>Product</th><th>Unit</th><th>Qty</th><th>Area</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="tot">Subtotal ₹${order.subtotal.toLocaleString('en-IN')}<br/>Discount −₹${order.discountAmount.toLocaleString('en-IN')}<br/>GST ₹${order.gst.toLocaleString('en-IN')}<br/>Charges ₹${order.charges.toLocaleString('en-IN')}<br/><b>Total ₹${order.total.toLocaleString('en-IN')}</b></div>
      <script>window.print()</script></body></html>`);
    win.document.close();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={order.displayId}
        subtitle={`${order.contact?.name}${order.projectName ? ` · ${order.projectName}` : ''}`}
        breadcrumbs={[{ label: 'Sales' }, { label: 'Orders', href: '/sales-orders' }, { label: order.displayId }]}
        actions={(
          <>
            {order.invoiceStatus === 'TO_REFUND' && <Button variant="danger" icon={Receipt} loading={busy === 'refund'} onClick={async () => { const res = await run('refund', () => createRefundFromSalesOrder(orderId), null); if (res) notify(`Credit note(s) issued: ${res.data.join('; ')}`, { variant: 'success' }); }}>Create refund</Button>}
            {order.status !== 'CANCELLED' && toInvoice > 0 && <Button variant="primary" icon={Receipt} onClick={openInvoiceDraft}>Create invoice</Button>}
            {open && unplanned && <Button icon={PackagePlus} loading={busy === 'plan'} onClick={() => run('plan', () => planSalesOrderDelivery(orderId), 'Delivery planned')}>Plan delivery</Button>}
            {open && <Button icon={Pencil} onClick={openEdit}>Edit</Button>}
            <Button icon={Printer} onClick={print}>Print</Button>
            {open && <Button icon={Lock} onClick={() => setConfirm('lock')}>Lock</Button>}
            {open && <Button variant="danger" icon={XCircle} onClick={() => setConfirm('cancel')}>Cancel</Button>}
          </>
        )}
      />

      <div className="flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
        <StatusBar current={order.status === 'CANCELLED' ? 'CANCELLED' : order.status} steps={order.status === 'CANCELLED'
          ? [{ key: 'QUOTATION', label: 'Quotation' }, { key: 'CANCELLED', label: 'Cancelled' }]
          : [{ key: 'QUOTATION', label: 'Quotation' }, { key: 'CONFIRMED', label: 'Sales Order' }, { key: 'DONE', label: 'Locked' }]} />
        <div className="flex gap-2 flex-wrap">
          <SmartButton icon={Truck} label="Deliveries" value={order.pickings.length} href={`/operations?type=DELIVERY&search=${encodeURIComponent(order.displayId)}`} />
          <SmartButton icon={Receipt} label="Invoiced" value={formatINR(order.invoicedTotal)} href="/billing" />
          {order.quotation && <SmartButton icon={FileText} label="Quotation" value={order.quotation.displayId} href="/quotations" />}
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="flex flex-wrap gap-2 mb-4">
              <Badge tone={SO_STATUS[order.status]?.tone}>{SO_STATUS[order.status]?.label}</Badge>
              <Badge tone={SO_DELIVERY[order.deliveryStatus]?.tone}>{SO_DELIVERY[order.deliveryStatus]?.label}</Badge>
              <Badge tone={SO_INVOICE[order.invoiceStatus]?.tone}>{SO_INVOICE[order.invoiceStatus]?.label}</Badge>
            </div>
            <InfoGrid items={[
              { label: 'Customer', value: <Link className="text-accent" href={`/leads`}>{order.contact?.name}</Link> },
              { label: 'Phone', value: order.contact?.phone },
              { label: 'Order date', value: formatDate(order.orderDate) },
              { label: 'Delivery date', value: formatDate(order.commitmentDate) },
              { label: 'Ship from', value: order.godown?.name },
              { label: 'Salesperson', value: order.salesperson?.name },
              { label: 'Invoicing', value: order.invoicePolicy === 'DELIVERED' ? 'Delivered quantities' : 'Ordered quantities' },
              { label: 'Supply', value: `${order.supplyType === 'INTERSTATE' ? 'Interstate (IGST)' : 'Intrastate'}${order.placeOfSupply ? ` · ${order.placeOfSupply}` : ''}` },
              { label: 'Customer ref', value: order.customerReference },
              { label: 'Dispatch to', value: order.dispatchAddress },
            ]} />
          </Card>

          <Card title="Order lines" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-y border-border text-[11px] uppercase text-muted text-left">
                  <th className="px-4 py-2">Product</th><th className="px-4 py-2 text-right">Ordered</th><th className="px-4 py-2 text-right">Delivered</th><th className="px-4 py-2 text-right">Invoiced</th><th className="px-4 py-2 text-right">Free stock</th><th className="px-4 py-2 text-right">Rate</th><th className="px-4 py-2 text-right">Amount</th>
                </tr></thead>
                <tbody>
                  {order.lines.map(line => (
                    <tr key={line.id} className="border-b border-border/50">
                      <td className="px-4 py-2.5"><div className="text-foreground">{line.name}</div><div className="text-[11px] text-muted">{line.sku}{line.areaSqft ? ` · ${formatQty(line.areaSqft)} sq.ft` : ''} · GST {line.gstRate}%</div></td>
                      <td className="px-4 py-2.5 text-right text-foreground">{line.quantity} <span className="text-muted text-xs">{line.unitOfMeasure}</span></td>
                      <td className={`px-4 py-2.5 text-right ${line.qtyDelivered >= line.quantity ? 'text-emerald-500' : line.qtyDelivered > 0 ? 'text-blue-500' : 'text-muted'}`}>{line.qtyDelivered}</td>
                      <td className={`px-4 py-2.5 text-right ${line.qtyInvoiced >= line.quantity ? 'text-emerald-500' : line.toInvoice > 0 ? 'text-amber-500' : 'text-muted'}`}>{line.qtyInvoiced}</td>
                      <td className={`px-4 py-2.5 text-right ${line.forecast && line.forecast.free < 0 ? 'text-red-500 font-medium' : 'text-muted'}`} title={line.forecast ? `On hand ${line.forecast.onHand} · reserved ${line.forecast.reserved} · incoming ${line.forecast.incoming}` : ''}>{line.forecast ? formatQty(line.forecast.free) : '—'}</td>
                      <td className="px-4 py-2.5 text-right text-muted">{formatINR(line.price)}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-foreground">{formatINR(line.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end p-4">
              <dl className="w-full max-w-xs text-sm space-y-1">
                <div className="flex justify-between"><dt className="text-muted">Untaxed amount</dt><dd className="text-foreground">{formatINR(order.subtotal - order.discountAmount)}</dd></div>
                {order.discountAmount > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="text-foreground">−{formatINR(order.discountAmount)}</dd></div>}
                <div className="flex justify-between"><dt className="text-muted">GST</dt><dd className="text-foreground">{formatINR(order.gst)}</dd></div>
                {order.charges > 0 && <div className="flex justify-between"><dt className="text-muted">Freight / loading / installation</dt><dd className="text-foreground">{formatINR(order.charges)}</dd></div>}
                <div className="flex justify-between border-t border-border pt-1.5 font-semibold"><dt className="text-foreground">Total</dt><dd className="text-foreground">{formatINR(order.total)}</dd></div>
              </dl>
            </div>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card title="Delivery orders">
              {order.pickings.length === 0 ? <p className="text-xs text-muted">No deliveries yet.</p> : (
                <ul className="space-y-2">
                  {order.pickings.map(picking => {
                    const done = picking.lines.reduce((sum, l) => sum + l.doneQty, 0);
                    const demand = picking.lines.reduce((sum, l) => sum + l.demandQty, 0);
                    return (
                      <li key={picking.id}>
                        <Link href={`/operations/${picking.id}`} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 hover:bg-surface-hover">
                          <span><span className="text-sm font-medium text-accent">{picking.displayId}</span><span className="block text-[11px] text-muted">{picking.status === 'DONE' ? `Delivered ${formatDate(picking.doneAt)} · ${done} units` : `Scheduled ${formatDate(picking.scheduledDate)} · ${demand} units`}</span></span>
                          <Badge tone={PICKING_STATUS[picking.status]?.tone}>{PICKING_STATUS[picking.status]?.label}</Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title="Invoices">
              {order.invoices.length === 0 ? <p className="text-xs text-muted">Nothing invoiced yet.</p> : (
                <ul className="space-y-2">
                  {order.invoices.map(invoice => (
                    <li key={invoice.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                      <span><span className="text-sm font-medium text-foreground">{invoice.displayId}</span><span className="block text-[11px] text-muted">{formatDate(invoice.date)} · {formatINR(invoice.total)} · due {formatINR(invoice.balanceDue)}</span></span>
                      <Badge tone={invoice.invoiceStatus !== 'ACTIVE' ? 'red' : invoice.paymentStatus === 'PAID' ? 'green' : invoice.paymentStatus === 'PARTIAL' ? 'blue' : 'amber'}>{invoice.invoiceStatus !== 'ACTIVE' ? invoice.invoiceStatus.toLowerCase() : invoice.paymentStatus.toLowerCase()}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          {order.notes && <Card title="Notes"><p className="text-sm text-foreground whitespace-pre-wrap">{order.notes}</p></Card>}
        </div>

        <Chatter resModel="SalesOrder" resId={orderId} resName={`${order.displayId} · ${order.contact?.name || ''}`} refreshKey={chatterKey} />
      </div>

      <Modal isOpen={!!invoiceDraft} onClose={() => setInvoiceDraft(null)} title="Create invoice" size="lg"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setInvoiceDraft(null)}>Discard</Button><Button variant="primary" loading={busy === 'invoice'} onClick={submitInvoice}>Create invoice</Button></div>}>
        {invoiceDraft && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{order.invoicePolicy === 'DELIVERED' ? 'Invoicing delivered quantities that are not invoiced yet.' : 'Invoicing ordered quantities that are not invoiced yet.'} {!order.chargesInvoiced && order.charges > 0 ? `Freight/loading/installation (${formatINR(order.charges)} + GST) is added to this invoice.` : ''}</p>
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] uppercase text-muted text-left border-b border-border"><th className="py-2">Product</th><th className="py-2 text-right">Invoiceable</th><th className="py-2 text-right w-28">Invoice now</th></tr></thead>
              <tbody>
                {order.lines.map(line => (
                  <tr key={line.id} className="border-b border-border/50">
                    <td className="py-2 text-foreground">{line.name}</td>
                    <td className="py-2 text-right text-muted">{line.toInvoice}</td>
                    <td className="py-2 pl-3"><input type="number" min="0" max={line.toInvoice} disabled={line.toInvoice === 0} value={invoiceDraft.lines[line.id]} onChange={e => setInvoiceDraft({ ...invoiceDraft, lines: { ...invoiceDraft.lines, [line.id]: e.target.value } })} className={inputClass} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Field label="Payment due date"><input type="date" value={invoiceDraft.dueDate} onChange={e => setInvoiceDraft({ ...invoiceDraft, dueDate: e.target.value })} className={inputClass} /></Field>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!edit} onClose={() => setEdit(null)} title={`Edit ${order.displayId}`}
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setEdit(null)}>Discard</Button><Button variant="primary" loading={busy === 'edit'} onClick={submitEdit}>Save</Button></div>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Delivery date"><input type="date" value={edit.commitmentDate} onChange={e => setEdit({ ...edit, commitmentDate: e.target.value })} className={inputClass} /></Field>
            <Field label="Invoicing policy">
              <select value={edit.invoicePolicy} onChange={e => setEdit({ ...edit, invoicePolicy: e.target.value })} className={inputClass}>
                <option value="DELIVERED">Delivered quantities</option><option value="ORDERED">Ordered quantities</option>
              </select>
            </Field>
            <Field label="Salesperson">
              <select value={edit.salespersonId} onChange={e => setEdit({ ...edit, salespersonId: e.target.value })} className={inputClass}>
                <option value="">—</option>
                {staff.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </Field>
            <Field label="Customer ref"><input value={edit.customerReference} onChange={e => setEdit({ ...edit, customerReference: e.target.value })} className={inputClass} /></Field>
            <Field label="Dispatch address"><input value={edit.dispatchAddress} onChange={e => setEdit({ ...edit, dispatchAddress: e.target.value })} className={inputClass} /></Field>
            <Field label="Notes"><textarea rows={3} value={edit.notes} onChange={e => setEdit({ ...edit, notes: e.target.value })} className={inputClass} /></Field>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!confirm} onClose={() => setConfirm(null)} title={confirm === 'lock' ? 'Lock this order?' : 'Cancel this order?'} size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button>
          <Button variant={confirm === 'cancel' ? 'danger' : 'primary'} loading={busy === confirm} onClick={async () => {
            const res = await run(confirm, () => (confirm === 'lock' ? lockSalesOrder(orderId) : cancelSalesOrder(orderId)), confirm === 'lock' ? 'Order locked' : 'Order cancelled');
            if (res) setConfirm(null);
          }}>{confirm === 'lock' ? 'Lock order' : 'Cancel order'}</Button></div>}>
        <p className="text-sm text-muted">{confirm === 'lock'
          ? 'Locking closes the order: open delivery orders are cancelled and no further deliveries are planned. Delivered quantities can still be invoiced.'
          : 'Cancelling is only possible before anything is delivered or invoiced. Open delivery orders are cancelled.'}</p>
      </Modal>
    </div>
  );
}
