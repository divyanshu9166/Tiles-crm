'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PackagePlus, Search, Plus } from 'lucide-react';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getLandedCosts } from '@/app/actions/landed-costs';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Tabs, inputClass, formatDate, formatINR, LANDED_STATUS, LANDED_CREDIT_TO } from '@/components/erp/kit';

function LandedCostsInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { notify } = useAlertToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState(params.get('search') || '');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getLandedCosts({ status, search });
    if (res.success) setRows(res.data); else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [status, search, notify]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Landed Costs"
        subtitle="Freight, duty and unloading added to the cost of the goods they brought in"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Landed costs' }]}
        actions={<Button variant="primary" icon={Plus} onClick={() => router.push('/landed-costs/new')}>New landed cost</Button>}
      />

      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <Tabs value={status} onChange={setStatus} tabs={[{ key: 'ALL', label: 'All' }, { key: 'DRAFT', label: 'Draft' }, { key: 'POSTED', label: 'Validated' }, { key: 'CANCELLED', label: 'Cancelled' }]} />
        <div className="relative md:ml-auto md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="LC no., receipt, PO, transporter" className={`${inputClass} pl-9`} />
        </div>
      </div>

      <Card padded={false}>
        {loading ? <Loading /> : rows.length === 0 ? (
          <EmptyState icon={PackagePlus} title="No landed costs" text="When a transporter's or clearing agent's bill comes in, add it here against the receipts it relates to. It raises the average cost of those goods instead of sitting in expenses." action={<Button variant="primary" icon={Plus} onClick={() => router.push('/landed-costs/new')}>New landed cost</Button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Reference', 'Date', 'Receipts', 'Transporter / agent', 'Bill no.', 'Booked as', 'Amount', 'Status'].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} onClick={() => router.push(`/landed-costs/${row.id}`)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                    <td className="px-4 py-3 font-medium text-accent">{row.displayId}</td>
                    <td className="px-4 py-3 text-muted">{formatDate(row.date)}</td>
                    <td className="px-4 py-3 text-foreground">{row.receipts.map(receipt => receipt.po ? `${receipt.displayId} (${receipt.po})` : receipt.displayId).join(', ') || '—'}</td>
                    <td className="px-4 py-3 text-foreground">{row.supplier || '—'}</td>
                    <td className="px-4 py-3 text-muted">{row.vendorRef || '—'}</td>
                    <td className="px-4 py-3 text-muted">{LANDED_CREDIT_TO[row.creditTo] || row.creditTo}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{formatINR(row.amountTotal)}</td>
                    <td className="px-4 py-3"><Badge tone={LANDED_STATUS[row.status]?.tone}>{LANDED_STATUS[row.status]?.label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function LandedCostsPage() {
  return <Suspense fallback={<Loading />}><LandedCostsInner /></Suspense>;
}
