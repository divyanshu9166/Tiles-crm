'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { getErpPolicies, updateErpPolicies } from '@/app/actions/erp-settings';
import { useAlertToast } from '@/components/AlertToastProvider';
import { Button, Field, inputClass } from '@/components/erp/kit';

// Company-wide ERP policies (Odoo: Inventory → Costing method, Purchase → Order approval).
export default function ErpPoliciesSettings() {
  const { notify } = useAlertToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getErpPolicies().then(res => {
      if (res.success) setForm({ costingMethod: res.data.costingMethod, poApprovalLimit: String(res.data.poApprovalLimit || '') });
      else notify(res.error, { variant: 'danger' });
    });
  }, [notify]);

  const save = async () => {
    setSaving(true);
    const res = await updateErpPolicies({ costingMethod: form.costingMethod, poApprovalLimit: Math.round(Number(form.poApprovalLimit) || 0) });
    setSaving(false);
    notify(res.success ? 'ERP policies saved' : res.error, { variant: res.success ? 'success' : 'danger' });
  };

  if (!form) return <div className="glass-card p-6 text-sm text-muted">Loading…</div>;

  return (
    <div className="glass-card p-4 sm:p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">ERP Policies</h2>
        <p className="text-sm text-muted">How stock is valued and when purchases need a second approval.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        <Field label="Costing method" hint={form.costingMethod === 'AVCO'
          ? 'Weighted average: each goods receipt blends the new purchase price with the value of stock on hand. Margins and stock value stay smooth.'
          : 'Last purchase price: product cost is replaced by the latest receipt price.'}>
          <select value={form.costingMethod} onChange={e => setForm({ ...form, costingMethod: e.target.value })} className={inputClass}>
            <option value="AVCO">Average cost (AVCO) — recommended</option>
            <option value="LAST">Last purchase price</option>
          </select>
        </Field>
        <Field label="PO approval limit (₹)" hint="Managers can approve purchase orders up to this total; above it an administrator must approve. Leave empty or 0 to switch off.">
          <input type="number" min="0" value={form.poApprovalLimit} onChange={e => setForm({ ...form, poApprovalLimit: e.target.value })} placeholder="e.g. 200000" className={inputClass} />
        </Field>
      </div>
      <Button variant="primary" icon={Save} loading={saving} onClick={save}>Save policies</Button>
    </div>
  );
}
