'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, Search, ClipboardList, Truck, FileText, AlertTriangle, Trash2, IndianRupee } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getSalesOrders, getSalesOrderStats, createSalesOrder } from '@/app/actions/sales-orders';
import { getProducts } from '@/app/actions/products';
import { getGodowns } from '@/app/actions/godowns';
import { getStaff } from '@/app/actions/staff';
import { getPricelists, getPricesFor } from '@/app/actions/pricelists';
import {
  Badge, Button, Card, EmptyState, Field, Loading, PageHeader, Tabs, inputClass, formatDate, formatINR,
  SO_DELIVERY, SO_INVOICE, SO_STATUS,
} from '@/components/erp/kit';
import { CustomerPicker, ProductPicker } from '@/components/erp/pickers';

const AREA_UNITS = ['SQFT', 'SQM', 'SLAB'];

function lineValue(line) {
  const qty = Number(line.quantity) || 0;
  const price = Number(line.price) || 0;
  if (AREA_UNITS.includes(line.unitOfMeasure) && Number(line.areaSqft) > 0) {
    const area = line.unitOfMeasure === 'SQM' ? Number(line.areaSqft) / 10.763910416709722 : Number(line.areaSqft);
    return Math.round(area * price);
  }
  return Math.round(qty * price);
}

const emptyForm = () => ({
  customer: null, godownId: '', salespersonId: '', pricelistId: '', invoicePolicy: 'DELIVERED', commitmentDate: '', projectName: '',
  customerReference: '', dispatchAddress: '', supplyType: 'INTRASTATE', discountType: 'none', discountValue: 0,
  freightCharge: 0, loadingCharge: 0, installationCharge: 0, notes: '', lines: [],
});

export default function SalesOrdersPage() {
  const router = useRouter();
  const { notify } = useAlertToast();
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('open');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [products, setProducts] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [staff, setStaff] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [list, summary] = await Promise.all([getSalesOrders({ search }), getSalesOrderStats()]);
    if (list.success) setOrders(list.data); else notify(list.error, { variant: 'danger' });
    if (summary.success) setStats(summary.data);
    setLoading(false);
  }, [search, notify]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const openNew = async () => {
    setForm(emptyForm());
    setShowNew(true);
    if (products.length === 0) {
      const [p, g, s, pl] = await Promise.all([getProducts(), getGodowns(), getStaff(), getPricelists()]);
      if (pl.success) setPricelists(pl.data);
      if (p.success) setProducts(p.data);
      if (g.success) {
        setGodowns(g.data);
        const preferred = g.data.find(item => item.isDefault) || g.data[0];
        if (preferred) setForm(current => ({ ...current, godownId: String(preferred.id) }));
      }
      if (s.success) setStaff(s.data.filter(member => member.status !== 'Inactive'));
    } else {
      const preferred = godowns.find(item => item.isDefault) || godowns[0];
      if (preferred) setForm(current => ({ ...current, godownId: String(preferred.id) }));
    }
  };

  const filtered = useMemo(() => orders.filter(order => {
    if (tab === 'open') return order.status === 'CONFIRMED';
    if (tab === 'deliver') return order.status === 'CONFIRMED' && order.deliveryStatus !== 'DELIVERED';
    if (tab === 'invoice') return order.status !== 'CANCELLED' && order.invoiceStatus === 'TO_INVOICE';
    return true;
  }), [orders, tab]);

  const [pricelists, setPricelists] = useState([]);
  const priceRequest = useRef(0);

  // Re-price every line the user has not priced by hand (Odoo recomputes
  // unit prices from the pricelist when customer, list or quantity changes).
  const applyPrices = async (draft, overrides = {}) => {
    const lines = draft.lines.filter(line => !line.priceManual);
    if (lines.length === 0 && !overrides.resolveList) return;
    const request = ++priceRequest.current;
    const res = await getPricesFor({
      pricelistId: draft.pricelistId ? Number(draft.pricelistId) : null,
      contactId: draft.customer?.id || null,
      lines: lines.map(line => ({ productId: line.productId, quantity: Number(line.quantity) || 0 })),
    });
    // Only the latest request may write prices (fast typing races).
    if (!res.success || request !== priceRequest.current) return;
    setForm(current => ({
      ...current,
      pricelistId: current.pricelistId || (res.data.pricelist ? String(res.data.pricelist.id) : ''),
      lines: current.lines.map(line => {
        if (line.priceManual) return line;
        const priced = res.data.prices.find(row => row.productId === line.productId);
        return priced?.price != null ? { ...line, price: priced.price, listPrice: priced.listPrice } : line;
      }),
    }));
  };

  const addLine = (product) => {
    const next = {
      ...form,
      lines: [...form.lines, {
        key: crypto.randomUUID(), productId: product.id, name: product.name, sku: product.sku,
        // Stone is sold by slab count; its on-hand is the available slabs.
        isSlab: product.isSlabTracked, stock: product.isSlabTracked ? product.availableStoneSlabs : product.stock,
        unitOfMeasure: product.isSlabTracked ? 'SLAB' : product.unitOfMeasure || 'PCS', coveragePerBox: product.coveragePerBox || '', quantity: 1, areaSqft: '', price: product.price, listPrice: product.price,
      }],
    };
    setForm(next);
    applyPrices(next);
  };
  const updateLine = (key, patch) => {
    const next = {
      ...form,
      lines: form.lines.map(line => {
        if (line.key !== key) return line;
        const updated = { ...line, ...patch, ...('price' in patch ? { priceManual: true } : {}) };
        // Area-driven box quantity, as on quotations.
        if ('areaSqft' in patch && updated.unitOfMeasure === 'BOX' && Number(updated.coveragePerBox) > 0 && Number(updated.areaSqft) > 0) {
          updated.quantity = Math.ceil(Number(updated.areaSqft) / Number(updated.coveragePerBox));
        }
        return updated;
      }),
    };
    setForm(next);
    // Quantity breaks: a bigger quantity may reach a cheaper pricelist rule.
    if ('quantity' in patch || 'areaSqft' in patch) applyPrices(next);
  };

  const subtotal = form.lines.reduce((sum, line) => sum + lineValue(line), 0);
  const discount = form.discountType === 'percent' ? Math.round(subtotal * Math.min(Number(form.discountValue) || 0, 100) / 100) : form.discountType === 'flat' ? Math.min(Number(form.discountValue) || 0, subtotal) : 0;

  const submit = async () => {
    if (!form.customer?.id && !(form.customer?.name && form.customer?.phone)) return notify('Select a customer or enter a name and phone', { variant: 'warning' });
    if (form.lines.length === 0) return notify('Add at least one product', { variant: 'warning' });
    setSaving(true);
    const res = await createSalesOrder({
      contactId: form.customer.id || undefined,
      customer: form.customer.id ? undefined : form.customer.name,
      phone: form.customer.id ? undefined : form.customer.phone,
      godownId: form.godownId ? Number(form.godownId) : undefined,
      salespersonId: form.salespersonId ? Number(form.salespersonId) : undefined,
      invoicePolicy: form.invoicePolicy,
      pricelistId: form.pricelistId ? Number(form.pricelistId) : undefined,
      commitmentDate: form.commitmentDate || undefined,
      projectName: form.projectName || undefined,
      customerReference: form.customerReference || undefined,
      dispatchAddress: form.dispatchAddress || undefined,
      supplyType: form.supplyType,
      discountType: form.discountType,
      discountValue: Number(form.discountValue) || 0,
      freightCharge: Number(form.freightCharge) || 0,
      loadingCharge: Number(form.loadingCharge) || 0,
      installationCharge: Number(form.installationCharge) || 0,
      notes: form.notes || undefined,
      lines: form.lines.map(line => ({
        productId: line.productId,
        quantity: Math.round(Number(line.quantity) || 0),
        price: Math.round(Number(line.price) || 0),
        unitOfMeasure: line.unitOfMeasure,
        areaSqft: Number(line.areaSqft) > 0 ? Number(line.areaSqft) : undefined,
        coveragePerBox: Number(line.coveragePerBox) > 0 ? Number(line.coveragePerBox) : undefined,
      })),
    });
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    if (res.data.warnings?.length) notify(`Confirmed with stock warnings: ${res.data.warnings.join('; ')}`, { variant: 'warning' });
    else notify(`${res.data.displayId} confirmed — delivery order created`, { variant: 'success' });
    setShowNew(false);
    router.push(`/sales-orders/${res.data.id}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sales Orders"
        subtitle="Confirmed orders → staged deliveries → invoices for what was delivered"
        breadcrumbs={[{ label: 'Sales' }, { label: 'Orders' }]}
        actions={<Button variant="primary" icon={Plus} onClick={openNew}>New order</Button>}
      />

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Open orders', value: stats.open, icon: ClipboardList },
            { label: 'Open value', value: formatINR(stats.openValue), icon: IndianRupee },
            { label: 'To deliver', value: stats.toDeliver, icon: Truck },
            { label: 'To invoice', value: stats.toInvoice, icon: FileText },
            { label: 'Late deliveries', value: stats.lateDeliveries, icon: AlertTriangle, danger: stats.lateDeliveries > 0 },
          ].map(card => (
            <div key={card.label} className="glass-card p-3.5 flex items-center gap-3">
              <card.icon className={`w-5 h-5 ${card.danger ? 'text-red-500' : 'text-accent'}`} />
              <div>
                <p className={`text-lg font-semibold ${card.danger ? 'text-red-500' : 'text-foreground'}`}>{card.value}</p>
                <p className="text-[11px] text-muted">{card.label}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[
          { key: 'open', label: 'Open' },
          { key: 'deliver', label: 'To deliver' },
          { key: 'invoice', label: 'To invoice' },
          { key: 'all', label: 'All' },
        ]} />
        <div className="relative md:ml-auto md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search order, customer, phone, project" className={`${inputClass} pl-9`} />
        </div>
      </div>

      <Card padded={false}>
        {loading ? <Loading /> : filtered.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No sales orders here" text="Confirm an approved quotation, or create an order directly for counter and project sales." action={<Button variant="primary" icon={Plus} onClick={openNew}>New order</Button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase text-muted">
                  {['Order', 'Customer', 'Project', 'Order date', 'Delivery date', 'Salesperson', 'Total', 'Delivery', 'Invoicing', 'Status'].map(h => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {filtered.map(order => {
                  const late = order.status === 'CONFIRMED' && order.commitmentDate && new Date(order.commitmentDate) < new Date(new Date().setHours(0, 0, 0, 0)) && order.deliveryStatus !== 'DELIVERED';
                  return (
                    <tr key={order.id} onClick={() => router.push(`/sales-orders/${order.id}`)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                      <td className="px-4 py-3 font-medium text-accent"><Link href={`/sales-orders/${order.id}`} onClick={e => e.stopPropagation()}>{order.displayId}</Link></td>
                      <td className="px-4 py-3 text-foreground">{order.contact?.name}<div className="text-[11px] text-muted">{order.contact?.phone}</div></td>
                      <td className="px-4 py-3 text-muted">{order.projectName || '—'}</td>
                      <td className="px-4 py-3 text-muted">{formatDate(order.orderDate)}</td>
                      <td className={`px-4 py-3 ${late ? 'text-red-500 font-medium' : 'text-muted'}`}>{formatDate(order.commitmentDate)}</td>
                      <td className="px-4 py-3 text-muted">{order.salesperson?.name || '—'}</td>
                      <td className="px-4 py-3 font-medium text-foreground">{formatINR(order.total)}</td>
                      <td className="px-4 py-3"><Badge tone={SO_DELIVERY[order.deliveryStatus]?.tone}>{SO_DELIVERY[order.deliveryStatus]?.label}</Badge></td>
                      <td className="px-4 py-3"><Badge tone={SO_INVOICE[order.invoiceStatus]?.tone}>{SO_INVOICE[order.invoiceStatus]?.label}</Badge></td>
                      <td className="px-4 py-3"><Badge tone={SO_STATUS[order.status]?.tone}>{SO_STATUS[order.status]?.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal isOpen={showNew} onClose={() => setShowNew(false)} title="New sales order" size="xl" fullScreenMobile
        footer={(
          <div className="flex items-center justify-between gap-3 w-full">
            <div className="text-sm text-muted">Untaxed <span className="text-foreground font-semibold">{formatINR(subtotal - discount)}</span></div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setShowNew(false)}>Discard</Button>
              <Button variant="primary" loading={saving} onClick={submit}>Confirm order</Button>
            </div>
          </div>
        )}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Customer"><CustomerPicker value={form.customer} onChange={customer => {
              const next = { ...form, customer, dispatchAddress: customer?.address || form.dispatchAddress, ...(customer?.id ? { pricelistId: '' } : {}) };
              setForm(next);
              if (customer?.id) applyPrices(next, { resolveList: true });
            }} /></Field>
            <Field label="Pricelist" hint="Defaults to the customer's price level. Prices you type by hand are kept.">
              <select value={form.pricelistId} onChange={e => { const next = { ...form, pricelistId: e.target.value }; setForm(next); applyPrices(next); }} className={inputClass}>
                <option value="">List price</option>
                {pricelists.filter(list => list.active).map(list => <option key={list.id} value={list.id}>{list.name}{list.isDefault ? ' (default)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Project / site"><input value={form.projectName} onChange={e => setForm({ ...form, projectName: e.target.value })} placeholder="e.g. Green Valley Villa – Flooring" className={inputClass} /></Field>
            <Field label="Ship from (location)">
              <select value={form.godownId} onChange={e => setForm({ ...form, godownId: e.target.value })} className={inputClass}>
                {godowns.map(godown => <option key={godown.id} value={godown.id}>{godown.name}{godown.isDefault ? ' (default)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Delivery date (commitment)"><input type="date" value={form.commitmentDate} onChange={e => setForm({ ...form, commitmentDate: e.target.value })} className={inputClass} /></Field>
            <Field label="Salesperson">
              <select value={form.salespersonId} onChange={e => setForm({ ...form, salespersonId: e.target.value })} className={inputClass}>
                <option value="">—</option>
                {staff.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </Field>
            <Field label="Invoicing policy" hint={form.invoicePolicy === 'DELIVERED' ? 'Invoice only what has been delivered (staged project supply).' : 'Invoice the full order upfront (advance billing).'}>
              <select value={form.invoicePolicy} onChange={e => setForm({ ...form, invoicePolicy: e.target.value })} className={inputClass}>
                <option value="DELIVERED">Delivered quantities</option>
                <option value="ORDERED">Ordered quantities</option>
              </select>
            </Field>
          </div>

          <div>
            <p className="text-xs text-muted mb-1">Order lines</p>
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-[11px] uppercase text-muted text-left">
                  <th className="px-3 py-2">Product</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2">Area (sq.ft)</th><th className="px-3 py-2">Qty</th><th className="px-3 py-2">Rate</th><th className="px-3 py-2 text-right">Amount</th><th />
                </tr></thead>
                <tbody>
                  {form.lines.map(line => (
                    <tr key={line.key} className="border-b border-border/50">
                      <td className="px-3 py-2 min-w-[180px]"><div className="text-foreground">{line.name}</div><div className={`text-[11px] ${line.stock < line.quantity ? 'text-amber-500' : 'text-muted'}`}>{line.sku} · {line.stock} {line.isSlab ? 'slabs available' : 'on hand'}</div></td>
                      <td className="px-3 py-2 text-muted">{line.unitOfMeasure}</td>
                      <td className="px-3 py-2 w-28">{['BOX', 'SQFT', 'SQM', 'SLAB'].includes(line.unitOfMeasure) ? <input type="number" min="0" value={line.areaSqft} onChange={e => updateLine(line.key, { areaSqft: e.target.value })} className={inputClass} /> : <span className="text-muted">—</span>}</td>
                      <td className="px-3 py-2 w-24"><input type="number" min="1" step="1" value={line.quantity} onChange={e => updateLine(line.key, { quantity: e.target.value })} className={inputClass} /></td>
                      <td className="px-3 py-2 w-28"><input type="number" min="0" value={line.price} onChange={e => updateLine(line.key, { price: e.target.value })} className={inputClass} />{Number(line.listPrice) > 0 && Number(line.price) !== Number(line.listPrice) && <div className="text-[10px] text-muted mt-0.5 line-through">₹{line.listPrice}</div>}</td>
                      <td className="px-3 py-2 text-right font-medium text-foreground">{formatINR(lineValue(line))}</td>
                      <td className="px-2"><button type="button" onClick={() => setForm({ ...form, lines: form.lines.filter(item => item.key !== line.key) })} className="p-1.5 text-muted hover:text-red-500"><Trash2 className="w-4 h-4" /></button></td>
                    </tr>
                  ))}
                  <tr><td colSpan={7} className="p-2"><ProductPicker products={products} onPick={addLine} excludeSlab={false} /></td></tr>
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted mt-1">Qty is in stock units (pcs/boxes) and drives delivery. For BOX lines, entering the area calculates boxes from coverage. Stone: Qty = number of slabs, area = total sq.ft (billed on the measured slabs actually delivered).</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Discount">
              <div className="flex gap-1">
                <select value={form.discountType} onChange={e => setForm({ ...form, discountType: e.target.value })} className={`${inputClass} w-24`}>
                  <option value="none">None</option><option value="percent">%</option><option value="flat">₹</option>
                </select>
                <input type="number" min="0" disabled={form.discountType === 'none'} value={form.discountValue} onChange={e => setForm({ ...form, discountValue: e.target.value })} className={inputClass} />
              </div>
            </Field>
            <Field label="Freight (₹)"><input type="number" min="0" value={form.freightCharge} onChange={e => setForm({ ...form, freightCharge: e.target.value })} className={inputClass} /></Field>
            <Field label="Loading (₹)"><input type="number" min="0" value={form.loadingCharge} onChange={e => setForm({ ...form, loadingCharge: e.target.value })} className={inputClass} /></Field>
            <Field label="Installation (₹)"><input type="number" min="0" value={form.installationCharge} onChange={e => setForm({ ...form, installationCharge: e.target.value })} className={inputClass} /></Field>
            <Field label="Supply type">
              <select value={form.supplyType} onChange={e => setForm({ ...form, supplyType: e.target.value })} className={inputClass}>
                <option value="INTRASTATE">Intrastate (CGST+SGST)</option><option value="INTERSTATE">Interstate (IGST)</option>
              </select>
            </Field>
            <Field label="Customer PO / ref"><input value={form.customerReference} onChange={e => setForm({ ...form, customerReference: e.target.value })} className={inputClass} /></Field>
            <Field label="Dispatch address" className="col-span-2"><input value={form.dispatchAddress} onChange={e => setForm({ ...form, dispatchAddress: e.target.value })} className={inputClass} /></Field>
          </div>
          <Field label="Internal notes"><textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className={inputClass} /></Field>
        </div>
      </Modal>
    </div>
  );
}
