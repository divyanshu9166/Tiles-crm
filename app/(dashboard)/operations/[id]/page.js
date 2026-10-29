'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, XCircle, Printer, CalendarDays, ClipboardList, Truck, Wand2, Undo2, PackagePlus } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import Chatter from '@/components/erp/Chatter';
import { Button, Card, Field, InfoGrid, Loading, PageHeader, SmartButton, StatusBar, inputClass, formatDate, toInputDate } from '@/components/erp/kit';
import { getPicking, validatePicking, cancelPicking, reschedulePicking, reserveDeliverySlabs, returnDelivery } from '@/app/actions/operations';
import { useRouter } from 'next/navigation';
import { getGodowns } from '@/app/actions/godowns';
import { getStoreSettings } from '@/app/actions/settings';
import { confirmDialog } from '@/components/AlertToastProvider';

export default function PickingPage() {
  const { id } = useParams();
  const pickingId = Number(id);
  const { notify } = useAlertToast();
  const [picking, setPicking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState({});
  const [batches, setBatches] = useState({});
  const [slabSel, setSlabSel] = useState({});
  const [transport, setTransport] = useState({ vehicleNumber: '', driverName: '', driverPhone: '', notes: '' });
  const [busy, setBusy] = useState('');
  const [askBackorder, setAskBackorder] = useState(false);
  const [schedule, setSchedule] = useState(null);
  const [godowns, setGodowns] = useState([]);
  const [chatterKey, setChatterKey] = useState(0);
  const [returnForm, setReturnForm] = useState(null);
  const router = useRouter();

  const load = useCallback(async () => {
    const res = await getPicking(pickingId);
    if (res.success) {
      setPicking(res.data);
      setDone(Object.fromEntries(res.data.lines.map(line => [line.id, res.data.status === 'READY' ? '' : line.doneQty])));
      setBatches(Object.fromEntries(res.data.lines.map(line => [line.id, line.batchId ? String(line.batchId) : ''])));
      // Slabs already reserved for this order start selected.
      setSlabSel(Object.fromEntries(res.data.lines.map(line => [line.id, res.data.status === 'READY'
        ? (line.slabs || []).filter(slab => slab.status === 'RESERVED').slice(0, line.demandQty).map(slab => slab.id)
        : line.slabIds || []])));
      setTransport({ vehicleNumber: res.data.vehicleNumber || '', driverName: res.data.driverName || '', driverPhone: res.data.driverPhone || '', notes: res.data.notes || '' });
    } else notify(res.error, { variant: 'danger' });
    setLoading(false);
    setChatterKey(key => key + 1);
  }, [pickingId, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);

  if (loading) return <Loading />;
  if (!picking) return <p className="text-sm text-muted">Transfer not found.</p>;

  const isDelivery = picking.pickingType === 'DELIVERY';
  const ready = picking.status === 'READY';
  const isSlab = (line) => line.product?.isSlabTracked;
  const qty = (line) => (isSlab(line) ? (slabSel[line.id] || []).length : Math.max(0, Math.round(Number(done[line.id]) || 0)));
  const toggleSlab = (line, slabId) => setSlabSel(current => {
    const chosen = current[line.id] || [];
    if (chosen.includes(slabId)) return { ...current, [line.id]: chosen.filter(id => id !== slabId) };
    if (chosen.length >= line.demandQty) {
      notify(`Only ${line.demandQty} slab(s) are needed for ${line.name}`, { variant: 'warning' });
      return current;
    }
    return { ...current, [line.id]: [...chosen, slabId] };
  });
  const reserve = async (line, release) => {
    const ids = (slabSel[line.id] || []).filter(id => line.slabs.find(slab => slab.id === id)?.status === (release ? 'RESERVED' : 'AVAILABLE'));
    if (ids.length === 0) return notify(release ? 'Select reserved slabs to release' : 'Select available slabs to reserve', { variant: 'warning' });
    setBusy('reserve');
    const res = await reserveDeliverySlabs({ pickingId, slabIds: ids, release });
    setBusy('');
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(`${res.data.count} slab(s) ${release ? 'released' : 'reserved for this order'}`, { variant: 'success' });
    load();
  };
  const anyDone = picking.lines.some(line => qty(line) > 0);
  const short = picking.lines.some(line => qty(line) < line.demandQty);

  const fillAll = () => setDone(Object.fromEntries(picking.lines.map(line => [line.id, isDelivery ? Math.min(line.demandQty, Math.max(0, Math.floor(line.onHand))) : line.demandQty])));

  const submit = async (createBackorder) => {
    setBusy('validate');
    const res = await validatePicking({
      id: pickingId,
      createBackorder,
      ...transport,
      lines: picking.lines.map(line => ({ lineId: line.id, doneQty: qty(line), batchId: isSlab(line) ? null : batches[line.id] ? Number(batches[line.id]) : null, ...(isSlab(line) ? { slabIds: slabSel[line.id] || [] } : {}) })),
    });
    setBusy('');
    setAskBackorder(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(res.data.backorder ? `Validated. Backorder ${res.data.backorder.displayId} created for the rest.` : 'Validated — stock updated', { variant: 'success' });
    load();
  };

  const validate = () => {
    if (!anyDone) return notify('Enter done quantities, or use "Set quantities" to fill them from demand', { variant: 'warning' });
    if (short) setAskBackorder(true);
    else submit(false);
  };

  const cancel = async () => {
    if (!await confirmDialog(`Cancel ${picking.displayId}? This cannot be undone.`)) return;
    setBusy('cancel');
    const res = await cancelPicking(pickingId);
    setBusy('');
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify('Transfer cancelled', { variant: 'success' });
    load();
  };

  const openSchedule = async () => {
    setSchedule({ scheduledDate: toInputDate(picking.scheduledDate), godownId: String(picking.godownId) });
    if (godowns.length === 0) { const res = await getGodowns(); if (res.success) setGodowns(res.data); }
  };

  const saveSchedule = async () => {
    setBusy('schedule');
    const res = await reschedulePicking({ id: pickingId, scheduledDate: schedule.scheduledDate, godownId: Number(schedule.godownId) });
    setBusy('');
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setSchedule(null);
    load();
  };

  const printChallan = async () => {
    const settings = await getStoreSettings();
    const store = settings.success ? settings.data : {};
    const rows = picking.lines.map((line, index) => `<tr><td>${index + 1}</td><td>${line.name}<br/><small>${line.sku}${line.batch ? ` · Batch ${line.batch.batchNumber}${line.batch.shadeCode ? ` / Shade ${line.batch.shadeCode}` : ''}` : ''}</small></td><td style="text-align:right">${line.demandQty}</td><td style="text-align:right">${picking.status === 'DONE' ? line.doneQty : ''}</td><td>${line.product?.unitOfMeasure || ''}</td></tr>`).join('');
    const partner = picking.contact || picking.supplier || {};
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<html><head><title>${picking.displayId}</title><style>body{font-family:Segoe UI,sans-serif;padding:32px;color:#111}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #e5e7eb;padding:8px;font-size:13px;text-align:left}th{font-size:11px;text-transform:uppercase;color:#6b7280;background:#f9fafb}.sig{display:flex;justify-content:space-between;margin-top:64px;font-size:12px}</style></head><body>
      <h2 style="margin:0">${store.storeName || ''}</h2><div style="font-size:12px;color:#555">${store.address || ''}${store.gstNumber ? ` · GSTIN ${store.gstNumber}` : ''}</div>
      <h3>${isDelivery ? 'Delivery Challan' : 'Goods Receipt Note'} — ${picking.displayId}</h3>
      <p><b>${isDelivery ? 'Deliver to' : 'Received from'}:</b> ${partner.name || ''} ${partner.phone ? `· ${partner.phone}` : ''}<br/>${picking.deliveryAddress || partner.address || ''}</p>
      <p>Source: ${picking.salesOrder?.displayId || picking.purchaseOrder?.displayId || '-'} · Location: ${picking.godown?.name} · Date: ${formatDate(picking.doneAt || picking.scheduledDate)}<br/>Vehicle: ${transport.vehicleNumber || '-'} · Driver: ${transport.driverName || '-'} ${transport.driverPhone || ''}</p>
      <table><thead><tr><th>#</th><th>Product</th><th>Demand</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="sig"><span>Prepared by</span><span>Driver</span><span>${isDelivery ? 'Received by (customer)' : 'Checked by'}</span></div>
      <script>window.print()</script></body></html>`);
    win.document.close();
  };

  const isReturn = picking.pickingType === 'RETURN';
  const title = isDelivery ? 'Delivery order' : isReturn ? 'Customer return' : 'Receipt';
  const canReturn = isDelivery && picking.status === 'DONE' && picking.lines.some(line => line.doneQty - (line.returnedQty || 0) > 0);

  const openReturn = () => setReturnForm({ reason: '', lines: Object.fromEntries(picking.lines.map(line => [line.id, { quantity: 0, slabIds: [] }])) });
  const submitReturn = async () => {
    setBusy('return');
    const res = await returnDelivery({
      deliveryId: pickingId,
      reason: returnForm.reason || undefined,
      lines: picking.lines.map(line => ({ lineId: line.id, quantity: isSlab(line) ? 0 : Math.max(0, Math.round(Number(returnForm.lines[line.id]?.quantity) || 0)), ...(isSlab(line) ? { slabIds: returnForm.lines[line.id]?.slabIds || [] } : {}) })),
    });
    setBusy('');
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(`Return ${res.data.displayId} received back into ${picking.godown?.name}. Create the refund from the sales order if it was invoiced.`, { variant: 'success' });
    setReturnForm(null);
    router.push(`/operations/${res.data.id}`);
  };
  const partner = picking.contact || picking.supplier;

  return (
    <div className="space-y-4">
      <PageHeader
        title={picking.displayId}
        subtitle={`${title}${partner ? ` · ${partner.name}` : ''}`}
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Operations', href: `/operations?type=${picking.pickingType}` }, { label: picking.displayId }]}
        actions={(
          <>
            {ready && <Button variant="primary" icon={CheckCircle2} loading={busy === 'validate'} onClick={validate}>Validate</Button>}
            {ready && <Button icon={Wand2} onClick={fillAll}>Set quantities</Button>}
            {ready && <Button icon={CalendarDays} onClick={openSchedule}>Reschedule</Button>}
            {canReturn && <Button icon={Undo2} onClick={openReturn}>Return</Button>}
            {picking.pickingType === 'RECEIPT' && picking.status === 'DONE' && <Link href={`/landed-costs/new?picking=${picking.id}`}><Button icon={PackagePlus}>Landed cost</Button></Link>}
            <Button icon={Printer} onClick={printChallan}>{isDelivery ? 'Delivery challan' : isReturn ? 'Return note' : 'Print GRN'}</Button>
            {ready && <Button variant="danger" icon={XCircle} loading={busy === 'cancel'} onClick={cancel}>Cancel</Button>}
          </>
        )}
      />

      <div className="flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
        <StatusBar current={picking.status} steps={picking.status === 'CANCELLED' ? [{ key: 'READY', label: 'Ready' }, { key: 'CANCELLED', label: 'Cancelled' }] : [{ key: 'READY', label: 'Ready' }, { key: 'DONE', label: 'Done' }]} />
        <div className="flex gap-2 flex-wrap">
          {picking.salesOrder && <SmartButton icon={ClipboardList} label="Sales order" value={picking.salesOrder.displayId} href={`/sales-orders/${picking.salesOrder.id}`} />}
          {picking.purchaseOrder && <SmartButton icon={Truck} label="Purchase order" value={picking.purchaseOrder.displayId} href="/purchases" />}
          {picking.returnOf && <SmartButton icon={Undo2} label="Returned from" value={picking.returnOf.displayId} href={`/operations/${picking.returnOf.id}`} />}
          {picking.returns?.length > 0 && <SmartButton icon={Undo2} label="Returns" value={picking.returns.length} href={`/operations/${picking.returns[0].id}`} />}
          {picking.backorders.length > 0 && <SmartButton icon={Truck} label="Backorders" value={picking.backorders.length} href={`/operations/${picking.backorders[0].id}`} />}
          {picking.landedCosts?.length > 0 && <SmartButton icon={PackagePlus} label="Landed costs" value={picking.landedCosts.length} href={picking.landedCosts.length === 1 ? `/landed-costs/${picking.landedCosts[0].id}` : `/landed-costs?search=${picking.displayId}`} />}
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card>
            <InfoGrid items={[
              { label: isDelivery || isReturn ? 'Customer' : 'Supplier', value: partner?.name },
              { label: 'Phone', value: partner?.phone },
              { label: isDelivery ? 'Source location' : 'Destination', value: picking.godown?.name },
              isReturn && picking.notes && { label: 'Reason', value: picking.notes },
              { label: 'Scheduled', value: formatDate(picking.scheduledDate) },
              picking.doneAt && { label: 'Done on', value: `${formatDate(picking.doneAt)}${picking.doneBy ? ` by ${picking.doneBy}` : ''}` },
              picking.backorderOf && { label: 'Backorder of', value: <Link className="text-accent" href={`/operations/${picking.backorderOf.id}`}>{picking.backorderOf.displayId}</Link> },
              isDelivery && { label: 'Deliver to', value: picking.deliveryAddress || picking.contact?.address },
            ]} />
          </Card>

          <Card title="Operations" padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-y border-border text-[11px] uppercase text-muted text-left">
                  <th className="px-4 py-2">Product</th>
                  {isDelivery && <th className="px-4 py-2">Batch / shade</th>}
                  <th className="px-4 py-2 text-right">{isDelivery ? 'On hand here' : isReturn ? '' : 'Unit cost'}</th>
                  <th className="px-4 py-2 text-right">Demand</th>
                  <th className="px-4 py-2 text-right w-32">Quantity</th>
                </tr></thead>
                <tbody>
                  {picking.lines.map(line => {
                    const shortHere = isDelivery && ready && !isSlab(line) && qty(line) > line.onHand;
                    const slabRow = isDelivery && isSlab(line);
                    const chosen = slabSel[line.id] || [];
                    const chosenSqft = (line.slabs || []).filter(slab => chosen.includes(slab.id)).reduce((sum, slab) => sum + slab.sqft, 0);
                    return (
                      <Fragment key={line.id}>
                      <tr className="border-b border-border/50">
                        <td className="px-4 py-2.5"><div className="text-foreground">{line.name}</div><div className="text-[11px] text-muted">{line.sku} · {line.product?.unitOfMeasure}</div></td>
                        {isDelivery && (
                          <td className="px-4 py-2.5">
                            {slabRow ? <span className="text-xs text-muted">{chosen.length} slab(s) · {chosenSqft.toFixed(1)} sq.ft</span> : ready ? (
                              <select value={batches[line.id] || ''} onChange={e => setBatches({ ...batches, [line.id]: e.target.value })} className={`${inputClass} min-w-[160px]`}>
                                <option value="">Unassigned stock</option>
                                {line.batches.map(batch => <option key={batch.id} value={batch.id}>{batch.batchNumber}{batch.shadeCode ? ` · ${batch.shadeCode}` : ''} ({batch.remainingQty})</option>)}
                              </select>
                            ) : <span className="text-muted">{line.batch ? `${line.batch.batchNumber}${line.batch.shadeCode ? ` · ${line.batch.shadeCode}` : ''}` : '—'}</span>}
                          </td>
                        )}
                        <td className={`px-4 py-2.5 text-right ${shortHere ? 'text-red-500 font-medium' : 'text-muted'}`}>{slabRow ? `${line.slabs.filter(slab => slab.status !== 'SOLD').length} slabs` : isDelivery ? line.onHand : isReturn ? '' : line.unitCost != null ? `₹${line.unitCost.toLocaleString('en-IN')}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-foreground">{line.demandQty}</td>
                        <td className="px-4 py-2.5 text-right">
                          {slabRow ? <span className={chosen.length === line.demandQty ? 'text-emerald-500' : 'text-amber-500'}>{ready ? chosen.length : line.doneQty}</span> : ready ? <input type="number" min="0" max={line.demandQty} step="1" value={done[line.id]} placeholder="0" onChange={e => setDone({ ...done, [line.id]: e.target.value })} className={`${inputClass} text-right`} /> : <span className={line.doneQty < line.demandQty ? 'text-amber-500' : 'text-emerald-500'}>{line.doneQty}</span>}
                        </td>
                      </tr>
                      {slabRow && (
                        <tr className="border-b border-border/50 bg-surface-hover/40">
                          <td colSpan={5} className="px-4 py-3">
                            {line.slabs.length === 0 ? <p className="text-xs text-amber-500">No available slabs of this product in {picking.godown?.name}. Receive a lot or move slabs to this location.</p> : (
                              <>
                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                  <span className="text-xs text-muted">{ready ? `Pick ${line.demandQty} slab(s) to load` : 'Slabs delivered'}</span>
                                  {ready && <Button size="sm" loading={busy === 'reserve'} onClick={() => reserve(line, false)}>Reserve selected</Button>}
                                  {ready && <Button size="sm" variant="ghost" onClick={() => reserve(line, true)}>Release</Button>}
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                                  {line.slabs.filter(slab => ready || chosen.includes(slab.id)).map(slab => {
                                    const picked = chosen.includes(slab.id);
                                    return (
                                      <button key={slab.id} type="button" disabled={!ready} onClick={() => toggleSlab(line, slab.id)}
                                        className={`text-left rounded-lg border px-2.5 py-2 transition-colors ${picked ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-hover'}`}>
                                        <div className="flex items-center justify-between gap-1">
                                          <span className="text-sm font-medium text-foreground">{slab.slabNumber}</span>
                                          {slab.status === 'RESERVED' && <span className="text-[10px] text-purple-500">Reserved</span>}
                                          {slab.bookMatchPairId && <span className="text-[10px] text-blue-500">Book-match</span>}
                                        </div>
                                        <div className="text-[11px] text-muted">Lot {slab.lot.lotNumber}{slab.lot.shadeCode ? ` · ${slab.lot.shadeCode}` : ''}</div>
                                        <div className="text-[11px] text-muted">{slab.lengthInches} in × {slab.widthInches} in · {slab.sqft.toFixed(1)} sq.ft</div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {ready && <p className="text-[11px] text-muted px-4 py-3">Enter what is physically {isDelivery ? 'loaded' : 'received'}. If less than the demand, you choose whether the rest becomes a backorder.{!isDelivery && ' Receipts update the weighted average cost of each product.'}</p>}
          </Card>

          <Card title={isDelivery ? 'Dispatch details' : isReturn ? 'Return details' : 'Receipt details'}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Vehicle number"><input disabled={!ready} value={transport.vehicleNumber} onChange={e => setTransport({ ...transport, vehicleNumber: e.target.value.toUpperCase() })} placeholder="MH 12 AB 1234" className={inputClass} /></Field>
              <Field label="Driver name"><input disabled={!ready} value={transport.driverName} onChange={e => setTransport({ ...transport, driverName: e.target.value })} className={inputClass} /></Field>
              <Field label="Driver phone"><input disabled={!ready} value={transport.driverPhone} onChange={e => setTransport({ ...transport, driverPhone: e.target.value })} className={inputClass} /></Field>
              <Field label="Notes" className="sm:col-span-3"><textarea disabled={!ready} rows={2} value={transport.notes} onChange={e => setTransport({ ...transport, notes: e.target.value })} className={inputClass} /></Field>
            </div>
          </Card>
        </div>
        <Chatter resModel="StockPicking" resId={pickingId} resName={`${picking.displayId}${partner ? ` · ${partner.name}` : ''}`} refreshKey={chatterKey} />
      </div>

      <Modal isOpen={!!returnForm} onClose={() => setReturnForm(null)} title={`Return from ${picking.displayId}`} size="lg"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setReturnForm(null)}>Discard</Button><Button variant="primary" loading={busy === 'return'} onClick={submitReturn}>Receive return</Button></div>}>
        {returnForm && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Goods come back into {picking.godown?.name}. The sales order&apos;s delivered quantity goes down; if it was already invoiced, the order shows “To refund”.</p>
            {picking.lines.map(line => {
              const left = line.doneQty - (line.returnedQty || 0);
              const value = returnForm.lines[line.id];
              return (
                <div key={line.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-sm text-foreground">{line.name}</p><p className="text-[11px] text-muted">Delivered {line.doneQty} · already returned {line.returnedQty || 0}</p></div>
                    {!isSlab(line) && <div className="w-24 shrink-0"><input type="number" min="0" max={left} disabled={left === 0} value={value.quantity} onChange={e => setReturnForm({ ...returnForm, lines: { ...returnForm.lines, [line.id]: { ...value, quantity: e.target.value } } })} className={`${inputClass} text-right`} /></div>}
                  </div>
                  {isSlab(line) && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                      {line.slabs.filter(slab => !(line.returnedSlabIds || []).includes(slab.id)).map(slab => {
                        const picked = value.slabIds.includes(slab.id);
                        return (
                          <button key={slab.id} type="button" onClick={() => setReturnForm({ ...returnForm, lines: { ...returnForm.lines, [line.id]: { ...value, slabIds: picked ? value.slabIds.filter(id => id !== slab.id) : [...value.slabIds, slab.id] } } })}
                            className={`text-left rounded-lg border px-2.5 py-2 ${picked ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-hover'}`}>
                            <span className="text-sm font-medium text-foreground">{slab.slabNumber}</span>
                            <span className="block text-[11px] text-muted">Lot {slab.lot.lotNumber} · {slab.sqft.toFixed(1)} sq.ft</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <Field label="Reason"><textarea rows={2} value={returnForm.reason} onChange={e => setReturnForm({ ...returnForm, reason: e.target.value })} placeholder="e.g. Shade mismatch, 2 boxes broken in transit" className={inputClass} /></Field>
          </div>
        )}
      </Modal>

      <Modal isOpen={askBackorder} onClose={() => setAskBackorder(false)} title="Create backorder?" size="sm"
        footer={<div className="flex flex-col sm:flex-row justify-end gap-2 w-full">
          <Button variant="ghost" onClick={() => setAskBackorder(false)}>Discard</Button>
          <Button loading={busy === 'validate'} onClick={() => submit(false)}>No backorder</Button>
          <Button variant="primary" loading={busy === 'validate'} onClick={() => submit(true)}>Create backorder</Button>
        </div>}>
        <p className="text-sm text-muted">You have processed less than the demand. Create a backorder if you expect to {isDelivery ? 'deliver' : 'receive'} the remaining quantity later. Choose “No backorder” to close the rest{isDelivery ? '' : ' — the purchase order is closed short'}.</p>
      </Modal>

      <Modal isOpen={!!schedule} onClose={() => setSchedule(null)} title="Reschedule" size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setSchedule(null)}>Discard</Button><Button variant="primary" loading={busy === 'schedule'} onClick={saveSchedule}>Save</Button></div>}>
        {schedule && (
          <div className="space-y-3">
            <Field label="Scheduled date"><input type="date" value={schedule.scheduledDate} onChange={e => setSchedule({ ...schedule, scheduledDate: e.target.value })} className={inputClass} /></Field>
            <Field label={isDelivery ? 'Ship from' : 'Receive into'}>
              <select value={schedule.godownId} onChange={e => setSchedule({ ...schedule, godownId: e.target.value })} className={inputClass}>
                {godowns.map(godown => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
              </select>
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
