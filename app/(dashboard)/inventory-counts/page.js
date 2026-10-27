'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardCheck, Plus } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import { getInventoryCounts, createInventoryCount } from '@/app/actions/inventory-counts';
import { getGodowns } from '@/app/actions/godowns';
import { getCategories, getProducts } from '@/app/actions/products';
import { getAssignableUsers } from '@/app/actions/chatter';
import { Badge, Button, Card, EmptyState, Field, Loading, PageHeader, inputClass, formatDate, formatINR } from '@/components/erp/kit';
import { ProductPicker } from '@/components/erp/pickers';

const STATUS = { IN_PROGRESS: { label: 'In progress', tone: 'blue' }, DONE: { label: 'Applied', tone: 'green' }, CANCELLED: { label: 'Cancelled', tone: 'red' } };

export default function InventoryCountsPage() {
  const router = useRouter();
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const canManage = ['ADMIN', 'MANAGER'].includes(session?.user?.role);
  const [counts, setCounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [lookups, setLookups] = useState({ godowns: [], categories: [], products: [], users: [] });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getInventoryCounts();
    if (res.success) setCounts(res.data); else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
  }, [load]);

  const openNew = async () => {
    setForm({ godownId: '', scope: 'LOCATION', categoryId: '', products: [], assignedToId: '', scheduledDate: new Date().toISOString().slice(0, 10), name: '' });
    const [g, c, p, u] = await Promise.all([getGodowns(), getCategories(), getProducts(), getAssignableUsers()]);
    const godowns = g.success ? g.data : [];
    setLookups({ godowns, categories: Array.isArray(c) ? c : [], products: p.success ? p.data : [], users: u.success ? u.data : [] });
    const preferred = godowns.find(item => item.isDefault) || godowns[0];
    if (preferred) setForm(current => current && ({ ...current, godownId: String(preferred.id) }));
  };

  const submit = async () => {
    setSaving(true);
    const res = await createInventoryCount({
      godownId: Number(form.godownId), scope: form.scope, name: form.name || undefined,
      categoryId: form.categoryId ? Number(form.categoryId) : undefined,
      productIds: form.products.map(product => product.id),
      assignedToId: form.assignedToId ? Number(form.assignedToId) : undefined,
      scheduledDate: form.scheduledDate || undefined,
    });
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    router.push(`/inventory-counts/${res.data.id}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Physical Inventory"
        subtitle="Count a location, review the differences, then post them as stock adjustments"
        breadcrumbs={[{ label: 'Inventory', href: '/operations' }, { label: 'Physical counts' }]}
        actions={canManage && <Button variant="primary" icon={Plus} onClick={openNew}>New count</Button>}
      />
      <Card padded={false}>
        {loading ? <Loading /> : counts.length === 0 ? (
          <EmptyState icon={ClipboardCheck} title="No counts yet" text="Cycle counts keep the system in step with the godown: count a location or a category every week instead of a once-a-year stock take." action={canManage && <Button variant="primary" icon={Plus} onClick={openNew}>Start a count</Button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="border-b border-border text-[11px] uppercase text-muted text-left">{['Reference', 'Name', 'Location', 'Scheduled', 'Assigned to', 'Progress', 'Difference value', 'Status'].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {counts.map(count => (
                  <tr key={count.id} onClick={() => router.push(`/inventory-counts/${count.id}`)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                    <td className="px-4 py-3 font-medium text-accent">{count.displayId}</td>
                    <td className="px-4 py-3 text-foreground">{count.name}</td>
                    <td className="px-4 py-3 text-muted">{count.godown?.name}</td>
                    <td className="px-4 py-3 text-muted">{formatDate(count.scheduledDate)}</td>
                    <td className="px-4 py-3 text-muted">{count.assignedTo?.name || '—'}</td>
                    <td className="px-4 py-3 text-muted">{count.countedCount} / {count.lineCount}</td>
                    <td className={`px-4 py-3 font-medium ${count.differenceValue < 0 ? 'text-red-500' : count.differenceValue > 0 ? 'text-emerald-500' : 'text-muted'}`}>{formatINR(count.differenceValue)}</td>
                    <td className="px-4 py-3"><Badge tone={STATUS[count.status]?.tone}>{STATUS[count.status]?.label}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal isOpen={!!form} onClose={() => setForm(null)} title="New physical count"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setForm(null)}>Discard</Button><Button variant="primary" loading={saving} onClick={submit}>Start counting</Button></div>}>
        {form && (
          <div className="space-y-3">
            <Field label="Location">
              <select value={form.godownId} onChange={e => setForm({ ...form, godownId: e.target.value })} className={inputClass}>
                {lookups.godowns.map(godown => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
              </select>
            </Field>
            <Field label="What to count">
              <select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })} className={inputClass}>
                <option value="LOCATION">Everything stocked in this location</option>
                <option value="CATEGORY">One category</option>
                <option value="PRODUCTS">Selected products</option>
              </select>
            </Field>
            {form.scope === 'CATEGORY' && (
              <Field label="Category">
                <select value={form.categoryId} onChange={e => setForm({ ...form, categoryId: e.target.value })} className={inputClass}>
                  <option value="">Choose…</option>
                  {lookups.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </Field>
            )}
            {form.scope === 'PRODUCTS' && (
              <Field label="Products">
                <div className="flex flex-wrap gap-1 mb-2">{form.products.map(product => <Badge key={product.id} tone="accent">{product.name} <button type="button" onClick={() => setForm({ ...form, products: form.products.filter(item => item.id !== product.id) })}>×</button></Badge>)}</div>
                <ProductPicker excludeRaw={false} products={lookups.products} onPick={product => !form.products.some(item => item.id === product.id) && setForm({ ...form, products: [...form.products, product] })} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Scheduled"><input type="date" value={form.scheduledDate} onChange={e => setForm({ ...form, scheduledDate: e.target.value })} className={inputClass} /></Field>
              <Field label="Counted by">
                <select value={form.assignedToId} onChange={e => setForm({ ...form, assignedToId: e.target.value })} className={inputClass}>
                  <option value="">—</option>
                  {lookups.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Name (optional)"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Weekly count – Wall tiles" className={inputClass} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
