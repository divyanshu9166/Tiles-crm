'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, XCircle, Save, Plus, Trash2, Search, PackagePlus, Truck } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import Chatter from '@/components/erp/Chatter';
import { Badge, Button, Card, Field, InfoGrid, Loading, PageHeader, SmartButton, StatusBar, inputClass, formatDate, formatINR, formatQty, toInputDate, LANDED_CREDIT_TO } from '@/components/erp/kit';
import { getLandedCost, getLandedCostReceipts, saveLandedCost, postLandedCost, cancelLandedCost } from '@/app/actions/landed-costs';
import { getSuppliers } from '@/app/actions/purchases';

const COST_TYPES = [
  { key: 'FREIGHT', label: 'Freight / transport' },
  { key: 'DUTY', label: 'Customs / octroi duty' },
  { key: 'INSURANCE', label: 'Transit insurance' },
  { key: 'LOADING', label: 'Loading / unloading' },
  { key: 'OTHER', label: 'Other' },
];
const SPLIT_METHODS = [
  { key: 'BY_QUANTITY', label: 'By quantity' },
  { key: 'BY_VALUE', label: 'By value' },
  { key: 'EQUAL', label: 'Equally per line' },
];
const emptyLine = () => ({ name: 'Freight', costType: 'FREIGHT', amount: '', splitMethod: 'BY_QUANTITY' });

function LandedCostInner() {
  const { id } = useParams();
  const isNew = id === 'new';
  const costId = isNew ? null : Number(id);
  const router = useRouter();
  const params = useSearchParams();
  const { notify } = useAlertToast();
  const [cost, setCost] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState({ date: toInputDate(new Date()), supplierId: '', vendorRef: '', creditTo: 'EXPENSE', notes: '' });
  const [receipts, setReceipts] = useState([]);
  const [lines, setLines] = useState([emptyLine()]);
  const [dirty, setDirty] = useState(isNew);
  const [busy, setBusy] = useState('');
  const [picker, setPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerRows, setPickerRows] = useState([]);
  const [confirm, setConfirm] = useState(null);
  const [chatterKey, setChatterKey] = useState(0);

  const load = useCallback(async () => {
    if (!costId) return;
    const res = await getLandedCost(costId);
    if (res.success) {
      const data = res.data;
      setCost(data);
      setForm({ date: toInputDate(data.date), supplierId: data.supplier?.id || '', vendorRef: data.vendorRef || '', creditTo: data.creditTo, notes: data.notes || '' });
      setReceipts(data.receipts);
      setLines(data.lines.length ? data.lines.map(line => ({ name: line.name, costType: line.costType, amount: line.amount, splitMethod: line.splitMethod })) : [emptyLine()]);
      setDirty(false);
    } else notify(res.error, { variant: 'danger' });
    setLoading(false);
    setChatterKey(key => key + 1);
  }, [costId, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);
  useEffect(() => {
    getSuppliers().then(res => res.success && setSuppliers(res.data));
  }, []);
  // "Landed cost" from a receipt preselects it.
  useEffect(() => {
    const pickingId = Number(params.get('picking'));
    if (!isNew || !pickingId) return;
    getLandedCostReceipts('').then(res => {
      const match = res.success && res.data.find(row => row.id === pickingId);
      if (match) setReceipts([match]);
    });
  }, [isNew, params]);
  useEffect(() => {
    if (!picker) return;
    const timer = setTimeout(async () => {
      const res = await getLandedCostReceipts(pickerSearch);
      if (res.success) setPickerRows(res.data); else notify(res.error, { variant: 'danger' });
    }, pickerSearch ? 300 : 0);
    return () => clearTimeout(timer);
  }, [picker, pickerSearch, notify]);

  const editable = isNew || cost?.status === 'DRAFT';
  const total = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const allocation = useMemo(() => cost?.allocation || [], [cost]);
  const totals = allocation.reduce((acc, row) => ({ toStock: acc.toStock + row.toStock, toCogs: acc.toCogs + row.toCogs }), { toStock: 0, toCogs: 0 });

  const change = (patch) => { setForm(current => ({ ...current, ...patch })); setDirty(true); };
  const changeLine = (index, patch) => { setLines(current => current.map((line, i) => (i === index ? { ...line, ...patch } : line))); setDirty(true); };

  const save = async (navigate = true) => {
    const payload = {
      id: costId || undefined,
      date: form.date || undefined,
      supplierId: form.supplierId ? Number(form.supplierId) : null,
      vendorRef: form.vendorRef || null,
      creditTo: form.creditTo,
      notes: form.notes || null,
      pickingIds: receipts.map(receipt => receipt.id),
      lines: lines.filter(line => line.name || line.amount).map(line => ({ name: line.name, costType: line.costType, amount: Math.round(Number(line.amount) || 0), splitMethod: line.splitMethod })),
    };
    const res = await saveLandedCost(payload);
    if (!res.success) { notify(res.error, { variant: 'danger' }); return null; }
    if (isNew) { if (navigate) router.replace(`/landed-costs/${res.data.id}`); return res.data.id; }
    await load();
    return res.data.id;
  };

  const run = async (key, fn) => { setBusy(key); try { await fn(); } finally { setBusy(''); } };

  const validate = () => run('post', async () => {
    setConfirm(null);
    const savedId = dirty ? await save(false) : costId;
    if (!savedId) return;
    const res = await postLandedCost(savedId);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(`Validated: ${formatINR(res.data.toStock)} added to stock value${res.data.toCogs ? `, ${formatINR(res.data.toCogs)} to cost of goods sold` : ''}`, { variant: 'success' });
    if (isNew) router.replace(`/landed-costs/${savedId}`); else load();
  });

  const cancel = () => run('cancel', async () => {
    setConfirm(null);
    const res = await cancelLandedCost(costId);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify('Landed cost cancelled', { variant: 'success' });
    load();
  });

  if (loading) return <Loading />;
  if (!isNew && !cost) return <p className="text-sm text-muted">Landed cost not found.</p>;

  const status = cost?.status || 'DRAFT';
  const title = cost?.displayId || 'New landed cost';
  const canValidate = editable && receipts.length > 0 && total > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        subtitle="Extra costs of bringing goods in, added to their valuation"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Landed costs', href: '/landed-costs' }, { label: title }]}
        actions={editable && (
          <>
            <Button variant="primary" icon={CheckCircle2} disabled={!canValidate} loading={busy === 'post'} onClick={() => setConfirm('post')}>Validate</Button>
            <Button icon={Save} disabled={!dirty} loading={busy === 'save'} onClick={() => run('save', async () => { if (await save()) notify('Saved', { variant: 'success' }); })}>Save draft</Button>
            {!isNew && <Button variant="danger" icon={XCircle} loading={busy === 'cancel'} onClick={() => setConfirm('cancel')}>Cancel</Button>}
          </>
        )}
      />

      <div className="flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
        <StatusBar current={status} steps={status === 'CANCELLED' ? [{ key: 'DRAFT', label: 'Draft' }, { key: 'CANCELLED', label: 'Cancelled' }] : [{ key: 'DRAFT', label: 'Draft' }, { key: 'POSTED', label: 'Validated' }]} />
        <div className="flex gap-2 flex-wrap">
          {receipts.map(receipt => <SmartButton key={receipt.id} icon={Truck} label={receipt.po ? `Receipt · ${receipt.po}` : 'Receipt'} value={receipt.displayId} href={`/operations/${receipt.id}`} />)}
        </div>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card title="Details">
            {editable ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Date"><input type="date" value={form.date} onChange={e => change({ date: e.target.value })} className={inputClass} /></Field>
                <Field label="Transporter / clearing agent"><select value={form.supplierId} onChange={e => change({ supplierId: e.target.value })} className={inputClass}><option value="">—</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                <Field label="Their bill / LR no."><input value={form.vendorRef} onChange={e => change({ vendorRef: e.target.value })} className={inputClass} placeholder="e.g. LR-2291" /></Field>
                <Field label="Paid / booked as" hint={form.creditTo === 'EXPENSE' ? 'Moves the cost out of the expense it was recorded under (Expenses → Transport/Freight) into stock value.' : form.creditTo === 'PAYABLE' ? 'Records the amount as owed to the transporter / agent.' : 'Records the payment out of cash or bank.'}>
                  <select value={form.creditTo} onChange={e => change({ creditTo: e.target.value })} className={inputClass}>{Object.entries(LANDED_CREDIT_TO).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
                </Field>
                <Field label="Notes" className="sm:col-span-2"><textarea rows={2} value={form.notes} onChange={e => change({ notes: e.target.value })} className={inputClass} /></Field>
              </div>
            ) : (
              <InfoGrid items={[
                { label: 'Date', value: formatDate(cost.date) },
                { label: 'Transporter / agent', value: cost.supplier?.name },
                { label: 'Bill / LR no.', value: cost.vendorRef },
                { label: 'Booked as', value: LANDED_CREDIT_TO[cost.creditTo] },
                cost.postedAt && { label: 'Validated', value: `${formatDate(cost.postedAt)}${cost.postedBy ? ` by ${cost.postedBy}` : ''}` },
                cost.notes && { label: 'Notes', value: cost.notes },
              ]} />
            )}
          </Card>

          <Card title="Receipts" actions={editable && <Button size="sm" icon={Plus} onClick={() => { setPickerSearch(''); setPicker(true); }}>Add receipt</Button>}>
            {receipts.length === 0 ? <p className="text-sm text-muted">Add the goods receipts (GRNs) this cost relates to.</p> : (
              <div className="space-y-2">
                {receipts.map(receipt => (
                  <div key={receipt.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                    <div>
                      <Link href={`/operations/${receipt.id}`} className="font-medium text-accent">{receipt.displayId}</Link>
                      <span className="text-muted"> · {[receipt.po, receipt.supplier, formatDate(receipt.doneAt)].filter(Boolean).join(' · ')}</span>
                    </div>
                    {editable && <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove receipt" onClick={() => { setReceipts(current => current.filter(row => row.id !== receipt.id)); setDirty(true); }} />}
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title={<span>Costs <span className="text-muted font-normal">· {formatINR(total)}</span></span>} actions={editable && <Button size="sm" icon={Plus} onClick={() => { setLines(current => [...current, emptyLine()]); setDirty(true); }}>Add cost</Button>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Description', 'Type', 'Split', 'Amount', ''].map(h => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={index} className="border-b border-border/50">
                      <td className="px-2 py-2 min-w-[160px]">{editable ? <input value={line.name} onChange={e => changeLine(index, { name: e.target.value })} className={inputClass} /> : line.name}</td>
                      <td className="px-2 py-2 min-w-[150px]">{editable ? <select value={line.costType} onChange={e => changeLine(index, { costType: e.target.value })} className={inputClass}>{COST_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select> : COST_TYPES.find(t => t.key === line.costType)?.label}</td>
                      <td className="px-2 py-2 min-w-[140px]">{editable ? <select value={line.splitMethod} onChange={e => changeLine(index, { splitMethod: e.target.value })} className={inputClass}>{SPLIT_METHODS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select> : SPLIT_METHODS.find(t => t.key === line.splitMethod)?.label}</td>
                      <td className="px-2 py-2 w-36">{editable ? <input type="number" min="0" value={line.amount} onChange={e => changeLine(index, { amount: e.target.value })} className={inputClass} placeholder="₹" /> : formatINR(line.amount)}</td>
                      <td className="px-2 py-2 w-10">{editable && lines.length > 1 && <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove cost" onClick={() => { setLines(current => current.filter((_, i) => i !== index)); setDirty(true); }} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={status === 'POSTED' ? 'How the cost was split' : 'Split preview'} actions={editable && dirty && !isNew && <Badge tone="amber">Save to refresh</Badge>}>
            {allocation.length === 0 ? <p className="text-sm text-muted">{isNew ? 'Save the draft to preview how the cost is split over the received lines.' : 'Add receipts and costs, then save to preview the split.'}</p> : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Product', 'Receipt', 'Qty', 'Value', 'Landed', 'To stock', 'To COGS', 'Unit cost'].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                    <tbody>
                      {allocation.map(row => (
                        <tr key={row.pickingLineId} className="border-b border-border/50">
                          <td className="px-3 py-2"><p className="text-foreground">{row.name}</p><p className="text-[11px] text-muted">{row.sku}</p></td>
                          <td className="px-3 py-2 text-muted">{row.pickingDisplayId}</td>
                          <td className="px-3 py-2">{formatQty(row.quantity)}{row.inStockQty < row.quantity && <span className="text-[11px] text-muted"> ({formatQty(row.inStockQty)} on hand)</span>}</td>
                          <td className="px-3 py-2 text-muted">{formatINR(row.originalValue)}</td>
                          <td className="px-3 py-2 font-medium text-foreground">{formatINR(row.additionalCost)}</td>
                          <td className="px-3 py-2">{formatINR(row.toStock)}</td>
                          <td className="px-3 py-2">{row.toCogs ? <span className="text-amber-500">{formatINR(row.toCogs)}</span> : '—'}</td>
                          <td className="px-3 py-2">{formatINR(row.costBefore)} → <span className="font-medium text-foreground">{formatINR(row.costAfter)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted mt-3">{formatINR(totals.toStock)} raises the average cost of goods still on hand.{totals.toCogs > 0 && ` ${formatINR(totals.toCogs)} belongs to goods already sold and goes to cost of goods sold.`}</p>
              </>
            )}
          </Card>
        </div>

        {!isNew && <Chatter resModel="LandedCost" resId={costId} resName={title} refreshKey={chatterKey} />}
      </div>

      <Modal isOpen={picker} onClose={() => setPicker(false)} title="Add receipts" size="lg">
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input autoFocus value={pickerSearch} onChange={e => setPickerSearch(e.target.value)} placeholder="GRN, PO or supplier" className={`${inputClass} pl-9`} />
          </div>
          <div className="max-h-[50vh] overflow-y-auto space-y-2">
            {pickerRows.length === 0 && <p className="text-sm text-muted py-6 text-center">No completed receipts found.</p>}
            {pickerRows.map(row => {
              const added = receipts.some(receipt => receipt.id === row.id);
              return (
                <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                  <div className="text-sm min-w-0">
                    <p className="font-medium text-foreground">{row.displayId}{row.po && <span className="text-muted font-normal"> · {row.po}</span>}{row.landed > 0 && <Badge tone="blue" className="ml-2">{row.landed} landed</Badge>}</p>
                    <p className="text-[11px] text-muted truncate">{[row.supplier, formatDate(row.doneAt), `${row.lines} line(s)`, `${formatQty(row.quantity)} units`, formatINR(row.value)].filter(Boolean).join(' · ')}</p>
                  </div>
                  <Button size="sm" variant={added ? 'ghost' : 'primary'} disabled={added} icon={added ? CheckCircle2 : PackagePlus} onClick={() => { setReceipts(current => [...current, row]); setDirty(true); }}>{added ? 'Added' : 'Add'}</Button>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!confirm} onClose={() => setConfirm(null)} title={confirm === 'post' ? 'Validate this landed cost?' : 'Cancel this landed cost?'} size="sm"
        footer={<div className="flex justify-end gap-2"><Button onClick={() => setConfirm(null)}>Back</Button>{confirm === 'post' ? <Button variant="primary" icon={CheckCircle2} loading={busy === 'post'} onClick={validate}>Validate</Button> : <Button variant="danger" icon={XCircle} loading={busy === 'cancel'} onClick={cancel}>Cancel it</Button>}</div>}>
        <p className="text-sm text-muted">
          {confirm === 'post'
            ? `${formatINR(total)} will be split over ${receipts.length} receipt(s) and added to the average cost of the goods still in stock. Validated landed costs cannot be undone.`
            : 'The draft will be kept for reference but can no longer be validated.'}
        </p>
      </Modal>
    </div>
  );
}

export default function LandedCostPage() {
  return <Suspense fallback={<Loading />}><LandedCostInner /></Suspense>;
}
