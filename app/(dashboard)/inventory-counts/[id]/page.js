'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle2, XCircle, Search, Printer, AlertTriangle } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import Chatter from '@/components/erp/Chatter';
import { Badge, Button, Card, InfoGrid, Loading, PageHeader, StatusBar, Tabs, inputClass, formatDate, formatINR, formatQty } from '@/components/erp/kit';
import { ProductPicker } from '@/components/erp/pickers';
import { getInventoryCount, setCountedQty, applyInventoryCount, cancelInventoryCount, addCountLine } from '@/app/actions/inventory-counts';
import { getProducts } from '@/app/actions/products';

// A saved counted value is compared with the stock at the moment it was
// counted; a value being typed (saved on blur) with today's stock.
const baseFor = (line, value) => (line.countedQty !== null && Number(value) === line.countedQty ? line.baseQty ?? line.systemQty : line.currentQty);

export default function InventoryCountPage() {
  const { id } = useParams();
  const countId = Number(id);
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const canManage = ['ADMIN', 'MANAGER'].includes(session?.user?.role);
  const [count, setCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState([]);
  const [chatterKey, setChatterKey] = useState(0);

  const load = useCallback(async () => {
    const res = await getInventoryCount(countId);
    if (res.success) {
      setCount(res.data);
      setValues(Object.fromEntries(res.data.lines.map(line => [line.id, line.countedQty ?? ''])));
    } else notify(res.error, { variant: 'danger' });
    setLoading(false);
    setChatterKey(key => key + 1);
  }, [countId, notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);
  useEffect(() => {
    if (canManage) getProducts().then(res => res.success && setProducts(res.data));
  }, [canManage]);

  const lines = useMemo(() => {
    if (!count) return [];
    const q = search.trim().toLowerCase();
    return count.lines.filter(line => {
      if (q && !line.product.name.toLowerCase().includes(q) && !line.product.sku.toLowerCase().includes(q)) return false;
      const value = values[line.id];
      if (filter === 'todo') return value === '' || value === null;
      if (filter === 'diff') return value !== '' && value !== null && Number(value) !== baseFor(line, value);
      return true;
    });
  }, [count, values, filter, search]);

  if (loading) return <Loading />;
  if (!count) return <p className="text-sm text-muted">Count not found.</p>;

  const open = count.status === 'IN_PROGRESS';
  const counted = count.lines.filter(line => values[line.id] !== '' && values[line.id] !== null).length;
  const diffValue = count.lines.reduce((sum, line) => {
    if (count.status === 'DONE') return sum + (line.appliedDelta || 0) * line.unitCost;
    const value = values[line.id];
    if (value === '' || value === null) return sum;
    return sum + (Number(value) - baseFor(line, value)) * line.unitCost;
  }, 0);

  const save = async (line) => {
    const raw = values[line.id];
    const countedQty = raw === '' || raw === null ? null : Number(raw);
    if (countedQty === line.countedQty) return;
    if (countedQty !== null && (!Number.isFinite(countedQty) || countedQty < 0)) return notify('Counted quantity must be zero or more', { variant: 'warning' });
    setSaving(current => ({ ...current, [line.id]: true }));
    const res = await setCountedQty({ lineId: line.id, countedQty });
    setSaving(current => ({ ...current, [line.id]: false }));
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setCount(current => ({ ...current, lines: current.lines.map(item => item.id === line.id ? { ...item, countedQty } : item) }));
  };

  const act = async () => {
    setBusy(true);
    const res = confirm === 'apply' ? await applyInventoryCount(countId) : await cancelInventoryCount(countId);
    setBusy(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(confirm === 'apply' ? `Applied: ${res.data.adjusted} adjustments (${formatINR(res.data.value)})` : 'Count cancelled', { variant: 'success' });
    setConfirm(null);
    load();
  };

  const addProduct = async (product) => {
    const res = await addCountLine({ countId, productId: product.id });
    if (!res.success) return notify(res.error, { variant: 'danger' });
    load();
  };

  const printSheet = () => {
    const rows = count.lines.map((line, index) => `<tr><td>${index + 1}</td><td>${line.product.name}</td><td>${line.product.sku}</td><td>${line.product.unitOfMeasure}</td><td style="width:120px"></td></tr>`).join('');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<html><head><title>${count.displayId}</title><style>body{font-family:Segoe UI,sans-serif;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;font-size:13px;text-align:left}</style></head><body><h3>Count sheet ${count.displayId} — ${count.godown?.name}</h3><p>Date: ${formatDate(count.scheduledDate)} · Counted by: ____________</p><table><thead><tr><th>#</th><th>Product</th><th>SKU</th><th>Unit</th><th>Counted</th></tr></thead><tbody>${rows}</tbody></table><script>window.print()</script></body></html>`);
    win.document.close();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={count.displayId}
        subtitle={`${count.name || 'Physical count'} · ${count.godown?.name}`}
        breadcrumbs={[{ label: 'Inventory', href: '/operations' }, { label: 'Physical counts', href: '/inventory-counts' }, { label: count.displayId }]}
        actions={(
          <>
            {open && canManage && <Button variant="primary" icon={CheckCircle2} onClick={() => setConfirm('apply')}>Apply count</Button>}
            <Button icon={Printer} onClick={printSheet}>Count sheet</Button>
            {open && canManage && <Button variant="danger" icon={XCircle} onClick={() => setConfirm('cancel')}>Cancel</Button>}
          </>
        )}
      />
      <StatusBar current={count.status} steps={count.status === 'CANCELLED' ? [{ key: 'IN_PROGRESS', label: 'In progress' }, { key: 'CANCELLED', label: 'Cancelled' }] : [{ key: 'IN_PROGRESS', label: 'In progress' }, { key: 'DONE', label: 'Applied' }]} />

      <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <Card>
            <InfoGrid items={[
              { label: 'Location', value: count.godown?.name },
              { label: 'Scheduled', value: formatDate(count.scheduledDate) },
              { label: 'Counted by', value: count.assignedTo?.name },
              { label: 'Progress', value: `${counted} of ${count.lines.length} counted` },
              { label: 'Difference value', value: <span className={diffValue < 0 ? 'text-red-500' : diffValue > 0 ? 'text-emerald-500' : ''}>{formatINR(diffValue)}</span> },
              count.appliedAt && { label: 'Applied', value: `${formatDate(count.appliedAt)} by ${count.appliedBy || '—'}` },
            ]} />
          </Card>

          <Card padded={false} title={<Tabs value={filter} onChange={setFilter} tabs={[{ key: 'all', label: 'All', count: count.lines.length }, { key: 'todo', label: 'To count', count: count.lines.length - counted }, { key: 'diff', label: 'Differences' }]} />}
            actions={<div className="relative w-56"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find product" className={`${inputClass} pl-9`} /></div>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-y border-border text-[11px] uppercase text-muted text-left">
                  <th className="px-4 py-2">Product</th><th className="px-4 py-2 text-right">On hand</th><th className="px-4 py-2 text-right w-36">Counted</th><th className="px-4 py-2 text-right">Difference</th><th className="px-4 py-2 text-right">Value</th>
                </tr></thead>
                <tbody>
                  {lines.map(line => {
                    const value = values[line.id];
                    const has = value !== '' && value !== null;
                    const diff = count.status === 'DONE' ? line.appliedDelta : has ? Number(value) - baseFor(line, value) : null;
                    return (
                      <tr key={line.id} className="border-b border-border/50">
                        <td className="px-4 py-2"><div className="text-foreground">{line.product.name}</div><div className="text-[11px] text-muted">{line.product.sku} · {line.product.category?.name}</div></td>
                        <td className="px-4 py-2 text-right text-muted">{formatQty(line.currentQty)} {line.movedSinceSnapshot && <span title={`Stock moved after this line was counted (was ${line.systemQty}). Those moves are kept when the count is applied.`}><AlertTriangle className="inline w-3.5 h-3.5 text-amber-500" /></span>}</td>
                        <td className="px-4 py-2">
                          {open ? <input type="number" min="0" step="any" value={value} onChange={e => setValues({ ...values, [line.id]: e.target.value })} onBlur={() => save(line)} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} placeholder="—" className={`${inputClass} text-right ${saving[line.id] ? 'opacity-60' : ''}`} /> : <span className="block text-right">{line.countedQty ?? '—'}</span>}
                        </td>
                        <td className={`px-4 py-2 text-right font-medium ${diff === null ? 'text-muted' : diff < 0 ? 'text-red-500' : diff > 0 ? 'text-emerald-500' : 'text-muted'}`}>{diff === null ? '—' : diff > 0 ? `+${formatQty(diff)}` : formatQty(diff)}</td>
                        <td className="px-4 py-2 text-right text-muted">{diff ? formatINR(diff * line.unitCost) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {open && canManage && <div className="p-3 border-t border-border"><ProductPicker excludeRaw={false} products={products} onPick={addProduct} placeholder="Add a product to this count…" /></div>}
          </Card>
          {open && <p className="text-[11px] text-muted">Quantities save when you leave the field. Lines left empty are not adjusted. Applying compares against the live on-hand quantity, so sales made during the count are not double-counted.</p>}
        </div>
        <Chatter resModel="InventoryCount" resId={countId} resName={`${count.displayId} · ${count.godown?.name || ''}`} refreshKey={chatterKey} />
      </div>

      <Modal isOpen={!!confirm} onClose={() => setConfirm(null)} title={confirm === 'apply' ? 'Apply this count?' : 'Cancel this count?'} size="sm"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setConfirm(null)}>Back</Button><Button variant={confirm === 'apply' ? 'primary' : 'danger'} loading={busy} onClick={act}>{confirm === 'apply' ? 'Apply' : 'Cancel count'}</Button></div>}>
        <p className="text-sm text-muted">{confirm === 'apply' ? `${counted} counted lines will be posted as stock adjustments worth ${formatINR(diffValue)}. This updates on-hand stock and the stock ledger.` : 'No stock will change. The count stays in history as cancelled.'}</p>
        {confirm === 'apply' && <div className="mt-2"><Badge tone={diffValue < 0 ? 'red' : 'green'}>{formatINR(diffValue)}</Badge></div>}
      </Modal>
    </div>
  );
}
