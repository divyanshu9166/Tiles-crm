'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowDownToLine, ArrowUpFromLine, ClipboardCheck, RefreshCcw, Search, ArrowLeftRight, AlertTriangle, PackageSearch } from 'lucide-react';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getOperationsOverview, getPickings, syncPurchaseReceipts } from '@/app/actions/operations';
import { Badge, Card, EmptyState, Loading, PageHeader, Tabs, inputClass, formatDate, PICKING_STATUS } from '@/components/erp/kit';

function OperationCard({ icon: Icon, title, primary, secondary, href, onClick, tone = 'accent' }) {
  const body = (
    <div className="glass-card p-4 h-full hover:border-accent/40 transition-colors">
      <div className="flex items-start justify-between">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tone === 'red' ? 'bg-red-500/10 text-red-500' : 'bg-accent/10 text-accent'}`}><Icon className="w-5 h-5" /></div>
        {secondary && <span className="text-[11px] text-red-500 font-medium">{secondary}</span>}
      </div>
      <p className="mt-3 text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted mt-0.5">{primary}</p>
    </div>
  );
  if (href) return <Link href={href}>{body}</Link>;
  return <button type="button" onClick={onClick} className="text-left">{body}</button>;
}

function OperationsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { notify } = useAlertToast();
  const [overview, setOverview] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState(params.get('type') || 'DELIVERY');
  const [status, setStatus] = useState(params.get('status') || 'READY');
  const [search, setSearch] = useState(params.get('search') || '');
  const [syncTick, setSyncTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const [summary, list] = await Promise.all([getOperationsOverview(), getPickings({ type, status, search })]);
    if (summary.success) setOverview(summary.data);
    if (list.success) setRows(list.data); else notify(list.error, { variant: 'danger' });
    setLoading(false);
  }, [type, status, search, notify, syncTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Approved POs from before goods receipts existed get their GRN here, once.
    syncPurchaseReceipts().then(res => { if (res.success && res.data.created) setSyncTick(tick => tick + 1); });
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <PageHeader title="Inventory Operations" subtitle="Receipts, delivery orders, counts and replenishment in one place" breadcrumbs={[{ label: 'Inventory' }, { label: 'Operations' }]} />

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <OperationCard icon={ArrowDownToLine} title="Receipts (GRN)" primary={`${overview?.receiptsReady ?? '–'} to process`} secondary={overview?.receiptsLate ? `${overview.receiptsLate} late` : null} onClick={() => { setType('RECEIPT'); setStatus('READY'); }} />
        <OperationCard icon={ArrowUpFromLine} title="Delivery Orders" primary={`${overview?.deliveriesReady ?? '–'} to deliver`} secondary={overview?.deliveriesLate ? `${overview.deliveriesLate} late` : null} onClick={() => { setType('DELIVERY'); setStatus('READY'); }} />
        <OperationCard icon={AlertTriangle} title="Backorders" primary={`${overview?.backorders ?? '–'} waiting`} onClick={() => setStatus('READY')} tone={overview?.backorders ? 'red' : 'accent'} />
        <OperationCard icon={ClipboardCheck} title="Physical Counts" primary={`${overview?.countsOpen ?? '–'} in progress`} href="/inventory-counts" />
        <OperationCard icon={RefreshCcw} title="Replenishment" primary={`${overview?.rules ?? '–'} reordering rules`} href="/replenishment" />
        <OperationCard icon={ArrowLeftRight} title="Internal Transfers" primary={`${overview?.transfersPending ?? '–'} pending`} href="/godowns" />
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <Tabs value={type} onChange={setType} tabs={[{ key: 'DELIVERY', label: 'Delivery orders' }, { key: 'RECEIPT', label: 'Receipts' }, { key: 'RETURN', label: 'Returns' }]} />
        <Tabs value={status} onChange={setStatus} tabs={[{ key: 'READY', label: 'Ready' }, { key: 'DONE', label: 'Done' }, { key: 'CANCELLED', label: 'Cancelled' }, { key: 'ALL', label: 'All' }]} />
        <div className="relative md:ml-auto md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search reference, SO/PO, partner" className={`${inputClass} pl-9`} />
        </div>
      </div>

      <Card padded={false}>
        {loading ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={PackageSearch} title="Nothing to process" text={type === 'DELIVERY' ? 'Delivery orders are created when a sales order is confirmed.' : 'Receipts are created when a purchase order is approved.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">
                {['Reference', type === 'DELIVERY' ? 'Customer' : 'Supplier', 'Source', 'Location', 'Scheduled', 'Units', 'Status'].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map(row => {
                  const demand = row.lines.reduce((sum, line) => sum + line.demandQty, 0);
                  const done = row.lines.reduce((sum, line) => sum + line.doneQty, 0);
                  return (
                    <tr key={row.id} onClick={() => router.push(`/operations/${row.id}`)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                      <td className="px-4 py-3 font-medium text-accent">{row.displayId}{row.backorderOf && <div className="text-[11px] text-muted font-normal">Backorder of {row.backorderOf.displayId}</div>}</td>
                      <td className="px-4 py-3 text-foreground">{row.contact?.name || row.supplier?.name || '—'}</td>
                      <td className="px-4 py-3 text-muted">{row.salesOrder?.displayId || row.purchaseOrder?.displayId || '—'}</td>
                      <td className="px-4 py-3 text-muted">{row.godown?.name}</td>
                      <td className={`px-4 py-3 ${row.isLate ? 'text-red-500 font-medium' : 'text-muted'}`}>{formatDate(row.scheduledDate)}</td>
                      <td className="px-4 py-3 text-muted">{row.status === 'DONE' ? done : demand}</td>
                      <td className="px-4 py-3"><Badge tone={row.isLate ? 'red' : PICKING_STATUS[row.status]?.tone}>{row.isLate ? 'Late' : PICKING_STATUS[row.status]?.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function OperationsPage() {
  return <Suspense fallback={<Loading />}><OperationsInner /></Suspense>;
}
