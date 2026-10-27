'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileInput, Search, Plus, AlertTriangle } from 'lucide-react';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getVendorBills, createBillFromPurchaseOrder } from '@/app/actions/vendor-bills';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Tabs, inputClass, formatDate, formatINR, BILL_STATUS } from '@/components/erp/kit';

export default function VendorBillsPage() {
  const router = useRouter();
  const { notify } = useAlertToast();
  const [data, setData] = useState({ bills: [], posToBill: [] });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getVendorBills({ status, search });
    if (res.success) setData(res.data); else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [status, search, notify]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const create = async (poId) => {
    setCreating(poId);
    const res = await createBillFromPurchaseOrder(poId);
    setCreating(null);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    router.push(`/vendor-bills/${res.data.id}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Vendor Bills" subtitle="Supplier invoices matched three ways: ordered, received and billed" breadcrumbs={[{ label: 'Purchase' }, { label: 'Vendor bills' }]} />

      {data.posToBill.length > 0 && (
        <Card title={<span className="flex items-center gap-2">Purchase orders waiting for a bill <Badge tone="amber">{data.posToBill.length}</Badge></span>}>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {data.posToBill.map(po => (
              <div key={po.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div><p className="text-sm font-medium text-foreground">{po.displayId}</p><p className="text-[11px] text-muted">{po.supplier} · {formatINR(po.billableValue)} received, unbilled</p></div>
                <Button size="sm" variant="primary" icon={Plus} loading={creating === po.id} onClick={() => create(po.id)}>Create bill</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <Tabs value={status} onChange={setStatus} tabs={[{ key: 'ALL', label: 'All' }, { key: 'DRAFT', label: 'Draft' }, { key: 'POSTED', label: 'Posted' }, { key: 'TO_CHECK', label: 'To check' }, { key: 'CANCELLED', label: 'Cancelled' }]} />
        <div className="relative md:ml-auto md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Bill, supplier invoice no., supplier, PO" className={`${inputClass} pl-9`} />
        </div>
      </div>

      <Card padded={false}>
        {loading ? <Loading /> : data.bills.length === 0 ? (
          <EmptyState icon={FileInput} title="No vendor bills" text="Create a bill from a received purchase order. Quantities come from goods received, prices from the PO." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Bill', 'Supplier', 'Supplier invoice', 'PO', 'Bill date', 'Due', 'Total', 'Open', 'Match', 'Status'].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {data.bills.map(bill => (
                  <tr key={bill.id} onClick={() => router.push(`/vendor-bills/${bill.id}`)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                    <td className="px-4 py-3 font-medium text-accent">{bill.displayId}</td>
                    <td className="px-4 py-3 text-foreground">{bill.supplier?.name}</td>
                    <td className="px-4 py-3 text-muted">{bill.vendorRef || '—'}</td>
                    <td className="px-4 py-3 text-muted">{bill.po?.displayId || '—'}</td>
                    <td className="px-4 py-3 text-muted">{formatDate(bill.billDate)}</td>
                    <td className="px-4 py-3 text-muted">{formatDate(bill.dueDate)}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{formatINR(bill.total)}</td>
                    <td className="px-4 py-3">{bill.paymentState === 'PAID' ? <Badge tone="green">Paid</Badge> : bill.paymentState ? <span className={bill.dueDate && new Date(bill.dueDate) < new Date() ? 'text-red-500 font-medium' : 'text-foreground'}>{formatINR(bill.residual)}</span> : <span className="text-muted">—</span>}</td>
                    <td className="px-4 py-3">{bill.matchStatus === 'MATCHED' ? <Badge tone="green">Matched</Badge> : <Badge tone="amber"><AlertTriangle className="w-3 h-3" /> To check</Badge>}</td>
                    <td className="px-4 py-3"><Badge tone={BILL_STATUS[bill.status]?.tone}>{BILL_STATUS[bill.status]?.label}</Badge></td>
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
