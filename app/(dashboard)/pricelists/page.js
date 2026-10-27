'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Tags, Trash2, Pencil, Star, UserPlus, X } from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getPricelists, savePricelist, savePricelistItem, deletePricelistItem, getPricelistCustomers, assignContactPricelist } from '@/app/actions/pricelists';
import { getProducts, getCategories } from '@/app/actions/products';
import { Badge, Button, Card, EmptyState, Field, Loading, PageHeader, inputClass, formatDate, formatINR } from '@/components/erp/kit';
import { CustomerPicker, ProductPicker } from '@/components/erp/pickers';
import { describeRule, rulePrice } from '@/lib/erp/pricing';

const emptyRule = (pricelistId) => ({ pricelistId, appliesTo: 'ALL', productId: null, product: null, categoryId: '', minQty: 0, computeType: 'DISCOUNT', fixedPrice: '', discountPct: '', markupPct: '', validFrom: '', validTo: '' });

export default function PricelistsPage() {
  const { notify } = useAlertToast();
  const [lists, setLists] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listForm, setListForm] = useState(null);
  const [ruleForm, setRuleForm] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [newCustomer, setNewCustomer] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await getPricelists();
    if (res.success) {
      setLists(res.data);
      setSelectedId(current => current ?? res.data[0]?.id ?? null);
    } else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    load();
    Promise.all([getProducts(), getCategories()]).then(([p, c]) => {
      if (p.success) setProducts(p.data);
      if (Array.isArray(c)) setCategories(c);
    });
  }, [load]);

  useEffect(() => {
    if (!selectedId) return;
    getPricelistCustomers(selectedId).then(res => res.success && setCustomers(res.data));
  }, [selectedId]);

  const selected = lists.find(list => list.id === selectedId);

  const submitList = async () => {
    setSaving(true);
    const res = await savePricelist({ id: listForm.id, name: listForm.name, description: listForm.description || undefined, isDefault: listForm.isDefault, active: listForm.active });
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setListForm(null);
    setSelectedId(res.data.id);
    load();
  };

  const submitRule = async () => {
    setSaving(true);
    const res = await savePricelistItem({
      id: ruleForm.id, pricelistId: ruleForm.pricelistId, appliesTo: ruleForm.appliesTo,
      productId: ruleForm.product?.id ?? null, categoryId: ruleForm.categoryId ? Number(ruleForm.categoryId) : null,
      minQty: Number(ruleForm.minQty) || 0, computeType: ruleForm.computeType,
      fixedPrice: ruleForm.fixedPrice === '' ? null : Math.round(Number(ruleForm.fixedPrice)),
      discountPct: ruleForm.discountPct === '' ? null : Number(ruleForm.discountPct),
      markupPct: ruleForm.markupPct === '' ? null : Number(ruleForm.markupPct),
      validFrom: ruleForm.validFrom || null, validTo: ruleForm.validTo || null,
    });
    setSaving(false);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setRuleForm(null);
    load();
  };

  const removeRule = async (id) => {
    const res = await deletePricelistItem(id);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    load();
  };

  const assign = async (contactId, pricelistId) => {
    const res = await assignContactPricelist(contactId, pricelistId);
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setNewCustomer(null);
    const refreshed = await getPricelistCustomers(selectedId);
    if (refreshed.success) setCustomers(refreshed.data);
    load();
  };

  const examplePrice = (rule) => {
    const product = rule.product || products.find(item => rule.appliesTo === 'CATEGORY' ? item.categoryId === rule.categoryId : true);
    if (!product) return '—';
    return `${product.name.slice(0, 22)}: ${formatINR(product.price)} → ${formatINR(rulePrice(rule, product))}`;
  };

  if (loading) return <Loading />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pricelists"
        subtitle="Price levels per customer type — retail, contractor, builder, dealer — with quantity breaks and validity dates"
        breadcrumbs={[{ label: 'Sales' }, { label: 'Pricelists' }]}
        actions={<Button variant="primary" icon={Plus} onClick={() => setListForm({ name: '', description: '', isDefault: lists.length === 0, active: true })}>New pricelist</Button>}
      />

      {lists.length === 0 ? (
        <Card><EmptyState icon={Tags} title="No pricelists yet" text="Create price levels like “Contractor −8%” or “Builder project rates”, then assign customers. Sales orders pick prices from the customer's list." action={<Button variant="primary" icon={Plus} onClick={() => setListForm({ name: '', description: '', isDefault: true, active: true })}>New pricelist</Button>} /></Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4 items-start">
          <Card padded={false}>
            <ul className="divide-y divide-border/60">
              {lists.map(list => (
                <li key={list.id}>
                  <button type="button" onClick={() => setSelectedId(list.id)} className={`w-full text-left px-4 py-3 hover:bg-surface-hover ${selectedId === list.id ? 'bg-accent/10' : ''}`}>
                    <div className="flex items-center gap-2"><span className="text-sm font-medium text-foreground">{list.name}</span>{list.isDefault && <Star className="w-3.5 h-3.5 text-accent" />}{!list.active && <Badge>Archived</Badge>}</div>
                    <p className="text-[11px] text-muted">{list.items.length} rules · {list._count.contacts} customers</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {selected && (
            <div className="space-y-4 min-w-0">
              <Card title={<span className="flex items-center gap-2">{selected.name}{selected.isDefault && <Badge tone="accent">Default</Badge>}</span>}
                actions={<div className="flex gap-2"><Button size="sm" icon={Pencil} onClick={() => setListForm({ id: selected.id, name: selected.name, description: selected.description || '', isDefault: selected.isDefault, active: selected.active })}>Edit</Button><Button size="sm" variant="primary" icon={Plus} onClick={() => setRuleForm(emptyRule(selected.id))}>Add rule</Button></div>}>
                {selected.description && <p className="text-sm text-muted mb-3">{selected.description}</p>}
                {selected.items.length === 0 ? <p className="text-sm text-muted">No rules: everything sells at list price. Add a rule for all products, a category, or one product.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm whitespace-nowrap">
                      <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Applies to', 'Min qty', 'Price rule', 'Valid', 'Example', ''].map(h => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                      <tbody>
                        {selected.items.map(rule => (
                          <tr key={rule.id} className="border-b border-border/50">
                            <td className="px-3 py-2 text-foreground">{rule.appliesTo === 'PRODUCT' ? rule.product?.name : rule.appliesTo === 'CATEGORY' ? `Category · ${rule.category?.name}` : 'All products'}</td>
                            <td className="px-3 py-2 text-muted">{rule.minQty > 0 ? `≥ ${rule.minQty}` : '—'}</td>
                            <td className="px-3 py-2"><Badge tone={rule.computeType === 'FIXED' ? 'blue' : rule.computeType === 'MARKUP' ? 'purple' : 'green'}>{describeRule(rule)}</Badge></td>
                            <td className="px-3 py-2 text-muted">{rule.validFrom || rule.validTo ? `${formatDate(rule.validFrom)} – ${formatDate(rule.validTo)}` : 'Always'}</td>
                            <td className="px-3 py-2 text-muted">{examplePrice(rule)}</td>
                            <td className="px-3 py-2 text-right">
                              <button type="button" onClick={() => setRuleForm({ ...rule, product: rule.product, categoryId: rule.categoryId ? String(rule.categoryId) : '', fixedPrice: rule.fixedPrice ?? '', discountPct: rule.discountPct ?? '', markupPct: rule.markupPct ?? '', validFrom: rule.validFrom ? rule.validFrom.slice?.(0, 10) || new Date(rule.validFrom).toISOString().slice(0, 10) : '', validTo: rule.validTo ? new Date(rule.validTo).toISOString().slice(0, 10) : '' })} className="p-1.5 text-muted hover:text-foreground"><Pencil className="w-4 h-4" /></button>
                              <button type="button" onClick={() => removeRule(rule.id)} className="p-1.5 text-muted hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-[11px] text-muted mt-3">The most specific matching rule wins: product, then category, then all products; among those, the highest minimum quantity reached.</p>
              </Card>

              <Card title={`Customers on ${selected.name}`} actions={<Badge>{customers.length}</Badge>}>
                <div className="flex gap-2 mb-3 items-start">
                  <div className="flex-1"><CustomerPicker value={newCustomer} onChange={setNewCustomer} /></div>
                  <Button icon={UserPlus} disabled={!newCustomer?.id} onClick={() => assign(newCustomer.id, selected.id)}>Assign</Button>
                </div>
                {customers.length === 0 ? <p className="text-xs text-muted">No customers assigned yet. Assigned customers get these prices automatically on new sales orders.</p> : (
                  <div className="flex flex-wrap gap-2">
                    {customers.map(contact => (
                      <span key={contact.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-foreground">
                        {contact.name} <span className="text-muted">{contact.phone}</span>
                        <button type="button" onClick={() => assign(contact.id, null)} className="text-muted hover:text-red-500" title="Remove"><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      )}

      <Modal isOpen={!!listForm} onClose={() => setListForm(null)} title={listForm?.id ? 'Edit pricelist' : 'New pricelist'}
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setListForm(null)}>Discard</Button><Button variant="primary" loading={saving} onClick={submitList}>Save</Button></div>}>
        {listForm && (
          <div className="space-y-3">
            <Field label="Name"><input value={listForm.name} onChange={e => setListForm({ ...listForm, name: e.target.value })} placeholder="e.g. Contractor" className={inputClass} /></Field>
            <Field label="Description"><input value={listForm.description} onChange={e => setListForm({ ...listForm, description: e.target.value })} placeholder="Who gets these prices" className={inputClass} /></Field>
            <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={listForm.isDefault} onChange={e => setListForm({ ...listForm, isDefault: e.target.checked })} /> Default for customers without a pricelist</label>
            <label className="flex items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={listForm.active} onChange={e => setListForm({ ...listForm, active: e.target.checked })} /> Active</label>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!ruleForm} onClose={() => setRuleForm(null)} title={ruleForm?.id ? 'Edit rule' : 'Add price rule'}
        footer={<div className="flex justify-end gap-2 w-full"><Button variant="ghost" onClick={() => setRuleForm(null)}>Discard</Button><Button variant="primary" loading={saving} onClick={submitRule}>Save rule</Button></div>}>
        {ruleForm && (
          <div className="space-y-3">
            <Field label="Applies to">
              <select value={ruleForm.appliesTo} onChange={e => setRuleForm({ ...ruleForm, appliesTo: e.target.value })} className={inputClass}>
                <option value="ALL">All products</option><option value="CATEGORY">A category</option><option value="PRODUCT">One product</option>
              </select>
            </Field>
            {ruleForm.appliesTo === 'CATEGORY' && (
              <Field label="Category">
                <select value={ruleForm.categoryId} onChange={e => setRuleForm({ ...ruleForm, categoryId: e.target.value })} className={inputClass}>
                  <option value="">Choose…</option>
                  {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </Field>
            )}
            {ruleForm.appliesTo === 'PRODUCT' && (
              <Field label="Product">{ruleForm.product ? <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"><span>{ruleForm.product.name} · list {formatINR(ruleForm.product.price)}</span><button type="button" className="text-xs text-accent" onClick={() => setRuleForm({ ...ruleForm, product: null })}>Change</button></div> : <ProductPicker excludeSlab={false} products={products} onPick={product => setRuleForm({ ...ruleForm, product })} placeholder="Search product" />}</Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Price rule">
                <select value={ruleForm.computeType} onChange={e => setRuleForm({ ...ruleForm, computeType: e.target.value })} className={inputClass}>
                  <option value="DISCOUNT">% off list price</option><option value="FIXED">Fixed price</option><option value="MARKUP">Cost + markup %</option>
                </select>
              </Field>
              {ruleForm.computeType === 'DISCOUNT' && <Field label="Discount %"><input type="number" value={ruleForm.discountPct} onChange={e => setRuleForm({ ...ruleForm, discountPct: e.target.value })} className={inputClass} /></Field>}
              {ruleForm.computeType === 'FIXED' && <Field label="Price (₹)"><input type="number" min="0" value={ruleForm.fixedPrice} onChange={e => setRuleForm({ ...ruleForm, fixedPrice: e.target.value })} className={inputClass} /></Field>}
              {ruleForm.computeType === 'MARKUP' && <Field label="Markup % on cost"><input type="number" value={ruleForm.markupPct} onChange={e => setRuleForm({ ...ruleForm, markupPct: e.target.value })} className={inputClass} /></Field>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Min quantity"><input type="number" min="0" value={ruleForm.minQty} onChange={e => setRuleForm({ ...ruleForm, minQty: e.target.value })} className={inputClass} /></Field>
              <Field label="Valid from"><input type="date" value={ruleForm.validFrom} onChange={e => setRuleForm({ ...ruleForm, validFrom: e.target.value })} className={inputClass} /></Field>
              <Field label="Valid to"><input type="date" value={ruleForm.validTo} onChange={e => setRuleForm({ ...ruleForm, validTo: e.target.value })} className={inputClass} /></Field>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
