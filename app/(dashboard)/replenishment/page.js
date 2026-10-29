'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCcw, ShoppingCart, Plus, Trash2, Pencil, Star, PackageCheck } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getReplenishment, orderReplenishment, getReorderRules, saveReorderRule, deleteReorderRule, getVendorPrices, saveVendorPrice, deleteVendorPrice } from '@/app/actions/replenishment';
import { getSuppliers } from '@/app/actions/purchases';
import { getProducts } from '@/app/actions/products';
import { getGodowns } from '@/app/actions/godowns';
import { Badge, Button, Card, EmptyState, Field, Loading, PageHeader, Tabs, inputClass, formatDate, formatINR, formatQty } from '@/components/erp/kit';
import { ProductPicker } from '@/components/erp/pickers';

const emptyRule = { id: null, product: null, godownId: '', minQty: 0, maxQty: 0, multipleQty: 1, supplierId: '', leadDays: 7, active: true };
const emptyVendor = { product: null, supplierId: '', price: 0, minQty: 0, leadDays: 7, supplierSku: '', isPreferred: false };

export default function ReplenishmentPage() {
  const { notify } = useAlertToast();
  const [tab, setTab] = useState('report');
  const [rows, setRows] = useState([]);
  const [rules, setRules] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState({});
  const [ordering, setOrdering] = useState(false);
  const [ruleForm, setRuleForm] = useState(null);
  const [vendorForm, setVendorForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('order');

  const load = useCallback(async () => {
    setLoading(true);
    const [report, ruleList, vendorList] = await Promise.all([getReplenishment(), getReorderRules(), getVendorPrices()]);
    if (report.success) {
      setRows(report.data);
      setSelected(Object.fromEntries(report.data.filter(row => row.toOrder > 0).map(row => [row.key, { checked: false, qty: row.toOrder, supplierId: row.supplier?.id ? String(row.supplier.id) : '' }])));
    } else notify(report.error, { variant: 'danger' });
    if (ruleList.success) setRules(ruleList.data);
    if (vendorList.success) setVendors(vendorList.data);
    setLoading(false);
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount / id change
    load();
    Promise.all([getSuppliers(), getProducts(), getGodowns()]).then(([s, p, g]) => {
      if (s.success) setSuppliers(s.data);
      if (p.success) setProducts(p.data);
      if (g.success) setGodowns(g.data);
    });
  }, [load]);

  const visible = useMemo(() => rows.filter(row => filter === 'all' || row.toOrder > 0), [rows, filter]);
  const chosen = Object.entries(selected).filter(([, value]) => value.checked);
  const chosenValue = chosen.reduce((sum, [key, value]) => {
    const row = rows.find(item => item.key === key);
    return sum + (Number(value.qty) || 0) * (row?.unitCost || 0);
  }, 0);

  const order = async () => {
    const items = chosen.map(([key, value]) => {
      const row = rows.find(item => item.key === key);
      return { productId: row.product.id, supplierId: Number(value.supplierId), godownId: row.godown?.id || undefined, quantity: Math.round(Number(value.qty) || 0), ruleId: row.ruleId || undefined };
    });
    if (items.some(item => !item.supplierId)) return notify('Choose a vendor for every selected line', { variant: 'warning' });
    if (items.some(item => item.quantity <= 0)) return notify('Quantities must be greater than zero', { variant: 'warning' });
    setOrdering(true);
    const res = await orderReplenishment({ items });
    setOrdering(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(`Draft PO${res.data.length > 1 ? 's' : ''} ${res.data.map(po => po.displayId).join(', ')} ready for approval in Purchases`, { variant: 'success' });
    load();
  };

  const submitRule = async () => {
    if (!ruleForm.product) return notify('Pick a product', { variant: 'warning' });
    setSaving(true);
    const res = await saveReorderRule({
      id: ruleForm.id || undefined, productId: ruleForm.product.id, godownId: ruleForm.godownId ? Number(ruleForm.godownId) : null,
      minQty: Number(ruleForm.minQty) || 0, maxQty: Number(ruleForm.maxQty) || 0, multipleQty: Number(ruleForm.multipleQty) || 1,
      supplierId: ruleForm.supplierId ? Number(ruleForm.supplierId) : null, leadDays: Number(ruleForm.leadDays) || 0, active: ruleForm.active,
    });
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setRuleForm(null);
    load();
  };

  const submitVendor = async () => {
    if (!vendorForm.product || !vendorForm.supplierId) return notify('Pick a product and a vendor', { variant: 'warning' });
    setSaving(true);
    const res = await saveVendorPrice({
      productId: vendorForm.product.id, supplierId: Number(vendorForm.supplierId), price: Math.round(Number(vendorForm.price) || 0),
      minQty: Number(vendorForm.minQty) || 0, leadDays: Number(vendorForm.leadDays) || 0, supplierSku: vendorForm.supplierSku || undefined, isPreferred: vendorForm.isPreferred,
    });
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setVendorForm(null);
    load();
  };

  const remove = async (fn, id) => {
    const res = await fn(id);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    load();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Replenishment"
        subtitle="Min/max reordering rules on forecasted stock — on hand − reserved for deliveries + incoming POs"
        breadcrumbs={[{ label: 'Inventory', href: '/operations' }, { label: 'Replenishment' }]}
        actions={(
          <>
            <Button icon={RefreshCcw} onClick={load}>Refresh</Button>
            {tab === 'rules' && <Button variant="primary" icon={Plus} onClick={() => setRuleForm({ ...emptyRule })}>New rule</Button>}
            {tab === 'vendors' && <Button variant="primary" icon={Plus} onClick={() => setVendorForm({ ...emptyVendor })}>New vendor price</Button>}
          </>
        )}
      />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'report', label: 'To order', count: rows.filter(row => row.toOrder > 0).length },
        { key: 'rules', label: 'Reordering rules', count: rules.length },
        { key: 'vendors', label: 'Vendor pricelists', count: vendors.length },
      ]} />

      {loading ? <Loading /> : tab === 'report' ? (
        <Card padded={false} title={(
          <span className="flex items-center gap-3">
            <Tabs value={filter} onChange={setFilter} tabs={[{ key: 'order', label: 'Needs ordering' }, { key: 'all', label: 'All monitored' }]} />
          </span>
        )} actions={chosen.length > 0 && <Button variant="primary" icon={ShoppingCart} loading={ordering} onClick={order}>Order {chosen.length} · {formatINR(chosenValue)}</Button>}>
          {visible.length === 0 ? (
            <EmptyState icon={PackageCheck} title="Stock is healthy" text="Nothing is below its minimum. Add reordering rules, or set a reorder level on products, to monitor more items." action={<Button icon={Plus} onClick={() => { setTab('rules'); setRuleForm({ ...emptyRule }); }}>New rule</Button>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-y border-border text-[11px] uppercase text-muted text-left">
                  <th className="px-3 py-2 w-8" />
                  {['Product', 'Location', 'On hand', 'Reserved', 'Incoming', 'In draft PO', 'Forecast', 'Min / Max', 'Vendor', 'To order', 'Value'].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                </tr></thead>
                <tbody>
                  {visible.map(row => {
                    const sel = selected[row.key];
                    return (
                      <tr key={row.key} className="border-b border-border/50">
                        <td className="px-3 py-2">{row.toOrder > 0 && <input type="checkbox" checked={!!sel?.checked} onChange={e => setSelected({ ...selected, [row.key]: { ...sel, checked: e.target.checked } })} className="accent-[var(--color-accent)]" />}</td>
                        <td className="px-3 py-2"><div className="text-foreground">{row.product.name}</div><div className="text-[11px] text-muted">{row.product.sku}{row.ruleId ? '' : row.minQty > 0 ? ' · from reorder level' : ' · negative forecast'}{row.manufacturing > 0 ? ` · ${formatQty(row.manufacturing)} reserved for production` : ''}{row.lastOrderedAt ? ` · last ordered ${formatDate(row.lastOrderedAt)}` : ''}</div></td>
                        <td className="px-3 py-2 text-muted">{row.godown?.name || 'All locations'}</td>
                        <td className="px-3 py-2 text-foreground">{formatQty(row.onHand)}</td>
                        <td className="px-3 py-2 text-muted">{formatQty(row.reserved)}</td>
                        <td className="px-3 py-2 text-blue-500">{formatQty(row.incoming)}</td>
                        <td className="px-3 py-2 text-purple-500">{row.onOrder ? <Link href="/purchases" className="underline">{formatQty(row.onOrder)}</Link> : '—'}</td>
                        <td className={`px-3 py-2 font-medium ${row.forecast < row.minQty ? 'text-red-500' : 'text-emerald-500'}`}>{formatQty(row.forecast)}</td>
                        <td className="px-3 py-2 text-muted">{formatQty(row.minQty)} / {formatQty(row.maxQty)}</td>
                        <td className="px-3 py-2">
                          {row.toOrder > 0 ? (
                            <select value={sel?.supplierId || ''} onChange={e => setSelected({ ...selected, [row.key]: { ...sel, supplierId: e.target.value } })} className={`${inputClass} min-w-[150px]`}>
                              <option value="">Choose vendor</option>
                              {row.vendors.map(vendor => <option key={vendor.supplierId} value={vendor.supplierId}>{vendor.name} · ₹{vendor.price}</option>)}
                              {suppliers.filter(s => !row.vendors.some(v => v.supplierId === s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          ) : <span className="text-muted">{row.supplier?.name || '—'}</span>}
                        </td>
                        <td className="px-3 py-2 w-24">{row.toOrder > 0 ? <input type="number" min="1" value={sel?.qty ?? row.toOrder} onChange={e => setSelected({ ...selected, [row.key]: { ...sel, qty: e.target.value } })} className={inputClass} /> : <Badge tone="green">OK</Badge>}</td>
                        <td className="px-3 py-2 text-muted">{row.toOrder > 0 ? formatINR((Number(sel?.qty) || 0) * row.unitCost) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-muted px-4 py-3">Ordering adds lines to the vendor’s open replenishment draft PO (or creates one). Approve it in <Link href="/purchases" className="text-accent">Purchases</Link> to make the quantity “incoming”.</p>
        </Card>
      ) : tab === 'rules' ? (
        <Card padded={false}>
          {rules.length === 0 ? <EmptyState icon={RefreshCcw} title="No reordering rules" text="A rule keeps a product between a minimum and maximum quantity, optionally per location." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-b border-border text-[11px] uppercase text-muted text-left">{['Product', 'Location', 'Min', 'Max', 'Multiple', 'Vendor', 'Lead time', 'Status', ''].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {rules.map(rule => (
                    <tr key={rule.id} className="border-b border-border/50">
                      <td className="px-4 py-2.5 text-foreground">{rule.product.name}<div className="text-[11px] text-muted">{rule.product.sku}</div></td>
                      <td className="px-4 py-2.5 text-muted">{rule.godown?.name || 'All locations'}</td>
                      <td className="px-4 py-2.5">{formatQty(rule.minQty)}</td>
                      <td className="px-4 py-2.5">{formatQty(rule.maxQty)}</td>
                      <td className="px-4 py-2.5 text-muted">{formatQty(rule.multipleQty)}</td>
                      <td className="px-4 py-2.5 text-muted">{rule.supplier?.name || 'Cheapest / preferred'}</td>
                      <td className="px-4 py-2.5 text-muted">{rule.leadDays} days</td>
                      <td className="px-4 py-2.5"><Badge tone={rule.active ? 'green' : 'gray'}>{rule.active ? 'Active' : 'Paused'}</Badge></td>
                      <td className="px-4 py-2.5 text-right">
                        <button type="button" onClick={() => setRuleForm({ id: rule.id, product: rule.product, godownId: rule.godownId ? String(rule.godownId) : '', minQty: rule.minQty, maxQty: rule.maxQty, multipleQty: rule.multipleQty, supplierId: rule.supplierId ? String(rule.supplierId) : '', leadDays: rule.leadDays, active: rule.active })} className="p-1.5 text-muted hover:text-foreground"><Pencil className="w-4 h-4" /></button>
                        <button type="button" onClick={() => remove(deleteReorderRule, rule.id)} className="p-1.5 text-muted hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <Card padded={false}>
          {vendors.length === 0 ? <EmptyState icon={Star} title="No vendor prices" text="Record what each supplier charges per product, their lead time and minimum quantity. Replenishment uses the preferred (or cheapest) vendor." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-b border-border text-[11px] uppercase text-muted text-left">{['Product', 'Vendor', 'Vendor SKU', 'Price', 'Min qty', 'Lead time', ''].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {vendors.map(vendor => (
                    <tr key={vendor.id} className="border-b border-border/50">
                      <td className="px-4 py-2.5 text-foreground">{vendor.product.name}<div className="text-[11px] text-muted">{vendor.product.sku}</div></td>
                      <td className="px-4 py-2.5 text-foreground">{vendor.supplier.name} {vendor.isPreferred && <Badge tone="accent"><Star className="w-3 h-3" /> Preferred</Badge>}</td>
                      <td className="px-4 py-2.5 text-muted">{vendor.supplierSku || '—'}</td>
                      <td className="px-4 py-2.5 font-medium">{formatINR(vendor.price)}</td>
                      <td className="px-4 py-2.5 text-muted">{formatQty(vendor.minQty)}</td>
                      <td className="px-4 py-2.5 text-muted">{vendor.leadDays} days</td>
                      <td className="px-4 py-2.5 text-right">
                        <button type="button" onClick={() => setVendorForm({ product: vendor.product, supplierId: String(vendor.supplierId), price: vendor.price, minQty: vendor.minQty, leadDays: vendor.leadDays, supplierSku: vendor.supplierSku || '', isPreferred: vendor.isPreferred })} className="p-1.5 text-muted hover:text-foreground"><Pencil className="w-4 h-4" /></button>
                        <button type="button" onClick={() => remove(deleteVendorPrice, vendor.id)} className="p-1.5 text-muted hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Modal isOpen={!!ruleForm} onClose={() => setRuleForm(null)} title={ruleForm?.id ? 'Edit reordering rule' : 'New reordering rule'}
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setRuleForm(null)}>Discard</Button><Button variant="primary" loading={saving} onClick={submitRule}>Save</Button></div>}>
        {ruleForm && (
          <div className="space-y-3">
            <Field label="Product">{ruleForm.product ? <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"><span>{ruleForm.product.name}</span>{!ruleForm.id && <button type="button" className="text-xs text-accent" onClick={() => setRuleForm({ ...ruleForm, product: null })}>Change</button>}</div> : <ProductPicker excludeRaw={false} products={products} onPick={product => setRuleForm({ ...ruleForm, product })} placeholder="Search product" />}</Field>
            <Field label="Location" hint="Leave on 'All locations' to watch total company stock.">
              <select value={ruleForm.godownId} onChange={e => setRuleForm({ ...ruleForm, godownId: e.target.value })} className={inputClass}>
                <option value="">All locations</option>
                {godowns.map(godown => <option key={godown.id} value={godown.id}>{godown.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Min qty"><input type="number" min="0" value={ruleForm.minQty} onChange={e => setRuleForm({ ...ruleForm, minQty: e.target.value })} className={inputClass} /></Field>
              <Field label="Max qty"><input type="number" min="0" value={ruleForm.maxQty} onChange={e => setRuleForm({ ...ruleForm, maxQty: e.target.value })} className={inputClass} /></Field>
              <Field label="Multiple of"><input type="number" min="1" value={ruleForm.multipleQty} onChange={e => setRuleForm({ ...ruleForm, multipleQty: e.target.value })} className={inputClass} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vendor">
                <select value={ruleForm.supplierId} onChange={e => setRuleForm({ ...ruleForm, supplierId: e.target.value })} className={inputClass}>
                  <option value="">Preferred / cheapest</option>
                  {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
                </select>
              </Field>
              <Field label="Lead time (days)"><input type="number" min="0" value={ruleForm.leadDays} onChange={e => setRuleForm({ ...ruleForm, leadDays: e.target.value })} className={inputClass} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={ruleForm.active} onChange={e => setRuleForm({ ...ruleForm, active: e.target.checked })} /> Active</label>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!vendorForm} onClose={() => setVendorForm(null)} title="Vendor price"
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setVendorForm(null)}>Discard</Button><Button variant="primary" loading={saving} onClick={submitVendor}>Save</Button></div>}>
        {vendorForm && (
          <div className="space-y-3">
            <Field label="Product">{vendorForm.product ? <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"><span>{vendorForm.product.name}</span><button type="button" className="text-xs text-accent" onClick={() => setVendorForm({ ...vendorForm, product: null })}>Change</button></div> : <ProductPicker excludeRaw={false} products={products} onPick={product => setVendorForm({ ...vendorForm, product, price: product.costPrice || 0 })} placeholder="Search product" />}</Field>
            <Field label="Vendor">
              <select value={vendorForm.supplierId} onChange={e => setVendorForm({ ...vendorForm, supplierId: e.target.value })} className={inputClass}>
                <option value="">Choose vendor</option>
                {suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Price (₹)"><input type="number" min="0" value={vendorForm.price} onChange={e => setVendorForm({ ...vendorForm, price: e.target.value })} className={inputClass} /></Field>
              <Field label="Min qty"><input type="number" min="0" value={vendorForm.minQty} onChange={e => setVendorForm({ ...vendorForm, minQty: e.target.value })} className={inputClass} /></Field>
              <Field label="Lead days"><input type="number" min="0" value={vendorForm.leadDays} onChange={e => setVendorForm({ ...vendorForm, leadDays: e.target.value })} className={inputClass} /></Field>
            </div>
            <Field label="Vendor product code"><input value={vendorForm.supplierSku} onChange={e => setVendorForm({ ...vendorForm, supplierSku: e.target.value })} className={inputClass} /></Field>
            <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={vendorForm.isPreferred} onChange={e => setVendorForm({ ...vendorForm, isPreferred: e.target.checked })} /> Preferred vendor for this product</label>
          </div>
        )}
      </Modal>
    </div>
  );
}
