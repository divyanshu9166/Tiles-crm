'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Search, Plus, Warehouse, Building2, ArrowRightLeft, Package,
  MapPin, Phone, Mail, CheckCircle, Trash2, Edit2, Star, 
  FileText, ArrowDown, ArrowUp, RefreshCw, BarChart3
} from 'lucide-react'
import {
  getBranches, createBranch, updateBranch, deleteBranch,
  getGodowns, createGodown, updateGodown, deleteGodown, setDefaultGodown,
  getGodownStock, getTransfers, createTransfer, completeTransfer,
  getGodownStockSummary, getStockLedger, migrateExistingStockToGodowns, cancelTransfer
} from '@/app/actions/godowns'
import { getProducts } from '@/app/actions/products'
import Modal from '@/components/Modal'
import { useAlertToast } from '@/components/AlertToastProvider'
import { confirmDialog } from '@/components/AlertToastProvider';

export default function GodownsPage() {
  const { notify } = useAlertToast()
  const [tab, setTab] = useState('branches')
  const [loading, setLoading] = useState(true)
  const [branches, setBranches] = useState([])
  const [godowns, setGodowns] = useState([])
  const [stocks, setStocks] = useState([])
  const [transfers, setTransfers] = useState([])
  const [products, setProducts] = useState([])
  const [godownSummary, setGodownSummary] = useState([])
  const [ledgerEntries, setLedgerEntries] = useState([])
  const [search, setSearch] = useState('')
  const [selectedGodown, setSelectedGodown] = useState('')
  const [migrating, setMigrating] = useState(false)

  const [showBranchModal, setShowBranchModal] = useState(false)
  const [showGodownModal, setShowGodownModal] = useState(false)
  const [showTransferModal, setShowTransferModal] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [branchForm, setBranchForm] = useState({ name: '', address: '', phone: '', email: '', managerName: '', isHeadOffice: false })
  const [godownForm, setGodownForm] = useState({ name: '', address: '', branchId: '', type: 'Warehouse', capacity: '', isDefault: false })
  const [transferForm, setTransferForm] = useState({ fromGodownId: '', toGodownId: '', notes: '', requestedBy: '', items: [{ productId: '', name: '', sku: '', quantity: 1 }] })

  const loadData = () => {
    setLoading(true)
    Promise.all([getBranches(), getGodowns(), getGodownStock(), getTransfers(), getProducts(), getGodownStockSummary()])
      .then(([brRes, gdRes, stRes, trRes, prRes, smRes]) => {
        if (brRes.success) setBranches(brRes.data)
        if (gdRes.success) setGodowns(gdRes.data)
        if (stRes.success) setStocks(stRes.data)
        if (trRes.success) setTransfers(trRes.data)
        if (prRes.success) setProducts(prRes.data)
        if (smRes.success) setGodownSummary(smRes.data)
        setLoading(false)
      })
  }

  useEffect(() => {
    // Initial warehouse bootstrap fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData()
  }, [])

  useEffect(() => {
    if (tab === 'ledger' && ledgerEntries.length === 0) {
      getStockLedger({ limit: 200 }).then(res => { if (res.success) setLedgerEntries(res.data) })
    }
  }, [tab, ledgerEntries.length])

  const filteredStocks = useMemo(() => stocks.filter(s =>
    (!selectedGodown || s.godownId === Number(selectedGodown)) &&
    (s.product?.name?.toLowerCase().includes(search.toLowerCase()) || s.product?.sku?.toLowerCase().includes(search.toLowerCase()))
  ), [stocks, search, selectedGodown])

  const handleCreateBranch = async () => {
    setSubmitting(true)
    const res = await createBranch(branchForm)
    if (res.success) {
      setShowBranchModal(false)
      setBranchForm({ name: '', address: '', phone: '', email: '', managerName: '', isHeadOffice: false })
      loadData()
    } else notify(res.error, { variant: 'danger' })
    setSubmitting(false)
  }

  const handleCreateGodown = async () => {
    setSubmitting(true)
    const data = {
      ...godownForm,
      branchId: godownForm.branchId ? Number(godownForm.branchId) : undefined,
      capacity: godownForm.capacity ? Number(godownForm.capacity) : undefined,
    }
    const res = await createGodown(data)
    if (res.success) {
      setShowGodownModal(false)
      setGodownForm({ name: '', address: '', branchId: '', type: 'Warehouse', capacity: '', isDefault: false })
      loadData()
    } else notify(res.error, { variant: 'danger' })
    setSubmitting(false)
  }

  const handleCreateTransfer = async () => {
    setSubmitting(true)
    const items = transferForm.items.filter(i => i.productId).map(i => {
      const prod = products.find(p => p.id === Number(i.productId))
      return { productId: Number(i.productId), name: prod?.name || '', sku: prod?.sku || '', quantity: Number(i.quantity) }
    })
    const res = await createTransfer({
      fromGodownId: Number(transferForm.fromGodownId),
      toGodownId: Number(transferForm.toGodownId),
      notes: transferForm.notes, requestedBy: transferForm.requestedBy, items
    })
    if (res.success) {
      setShowTransferModal(false)
      setTransferForm({ fromGodownId: '', toGodownId: '', notes: '', requestedBy: '', items: [{ productId: '', name: '', sku: '', quantity: 1 }] })
      loadData()
    } else notify(res.error, { variant: 'danger' })
    setSubmitting(false)
  }

  const handleCompleteTransfer = async (id) => {
    if (!await confirmDialog('Complete this transfer? Stock moves from the source godown to the destination now.')) return
    const res = await completeTransfer(id)
    if (res.success) loadData()
    else notify(res.error, { variant: 'danger' })
  }

  const handleCancelTransfer = async (id) => {
    const res = await cancelTransfer(id)
    if (res.success) { notify('Transfer cancelled', { variant: 'success' }); loadData() }
    else notify(res.error, { variant: 'danger' })
  }

  const handleMigrate = async () => {
    if (!await confirmDialog('This will allocate all existing product stock to the default godown. Continue?')) return
    setMigrating(true)
    const res = await migrateExistingStockToGodowns()
    if (res.success) {
      notify(`Sync complete: ${res.migrated} products placed in "${res.defaultGodownName}".`, { variant: 'success' })
      loadData()
    } else notify(res.error, { variant: 'danger' })
    setMigrating(false)
  }

  const tabs = [
    { id: 'branches', label: 'Branches', icon: Building2 },
    { id: 'godowns', label: 'Godowns', icon: Warehouse },
    { id: 'stock', label: 'Stock View', icon: Package },
    { id: 'transfers', label: 'Transfers', icon: ArrowRightLeft },
    { id: 'ledger', label: 'Stock Ledger', icon: FileText },
  ]

  const INP = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50'
  const SEL = INP

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>

  const totalStockItems = godownSummary.reduce((s, g) => s + (g.totalItems || 0), 0)
  const totalStockValue = godownSummary.reduce((s, g) => s + (g.totalValue || 0), 0)

  return (
    <div className="space-y-5 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Multi-Branch & Godown</h1>
          <p className="text-muted text-sm mt-1">{branches.length} branches · {godowns.length} godowns · ₹{(totalStockValue / 100000).toFixed(1)}L inventory value</p>
        </div>
        <div className="flex w-full sm:w-auto gap-2 flex-wrap">
          {tab === 'branches' && <button onClick={() => setShowBranchModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2"><Plus className="w-4 h-4" /> Add Branch</button>}
          {tab === 'godowns' && <button onClick={() => setShowGodownModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2"><Plus className="w-4 h-4" /> Add Godown</button>}
          {tab === 'transfers' && <button onClick={() => setShowTransferModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2"><Plus className="w-4 h-4" /> New Transfer</button>}
          <button onClick={handleMigrate} disabled={migrating} className="px-3 py-2 border border-border rounded-lg text-sm text-muted hover:text-foreground hover:bg-surface-hover flex items-center gap-1.5 disabled:opacity-50" title="Sync existing product stock to default godown">
            <RefreshCw className={`w-3.5 h-3.5 ${migrating ? 'animate-spin' : ''}`} /> Sync Stock
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Branches', value: branches.length, icon: Building2, color: 'text-blue-400' },
          { label: 'Godowns', value: godowns.length, icon: Warehouse, color: 'text-emerald-400' },
          { label: 'Stock Items', value: totalStockItems, icon: Package, color: 'text-amber-400' },
          { label: 'Inventory Value', value: `₹${(totalStockValue / 100000).toFixed(1)}L`, icon: BarChart3, color: 'text-purple-400' },
          { label: 'Pending Transfers', value: transfers.filter(t => t.status === 'Pending').length, icon: ArrowRightLeft, color: 'text-orange-400' },
        ].map((s, i) => (
          <div key={i} className="glass-card p-3 sm:p-4">
            <div className="flex items-center gap-3">
              <s.icon className={`w-5 h-5 ${s.color} flex-shrink-0`} />
              <div className="min-w-0">
                <p className="text-[10px] sm:text-xs text-muted">{s.label}</p>
                <p className="text-base sm:text-lg font-semibold text-foreground truncate">{s.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 overflow-x-auto hide-scrollbar">
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch('') }}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-md text-xs sm:text-sm font-medium transition-all flex-shrink-0 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* ═══════ BRANCHES ═══════ */}
      {tab === 'branches' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {branches.map(b => (
            <div key={b.id} className={`glass-card p-5 ${b.isHeadOffice ? 'border-l-4 border-l-accent' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-foreground flex items-center gap-2">
                    {b.name} {b.isHeadOffice && <span className="text-[10px] bg-accent/20 text-accent px-2 py-0.5 rounded-full">HQ</span>}
                  </h3>
                  {b.managerName && <p className="text-xs text-muted mt-0.5">Manager: {b.managerName}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted bg-surface-hover px-2 py-1 rounded-full">{b._count?.godowns || 0} godowns</span>
                  <button onClick={async () => { if (await confirmDialog('Delete this branch?')) { const r = await deleteBranch(b.id); if (r.success) loadData(); else notify(r.error, { variant: 'danger' }) }}}
                    className="p-1 text-red-400/50 hover:text-red-400 rounded"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <div className="space-y-1.5 text-sm text-muted">
                {b.address && <p className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 flex-shrink-0" /> {b.address}</p>}
                {b.phone && <p className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> {b.phone}</p>}
                {b.email && <p className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> {b.email}</p>}
              </div>
              {b.godowns?.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-[10px] text-muted uppercase mb-1.5">Godowns</p>
                  <div className="flex flex-wrap gap-1.5">
                    {b.godowns.map(g => (
                      <span key={g.id} className={`text-[10px] px-2 py-0.5 rounded-full ${g.isDefault ? 'bg-accent/20 text-accent font-semibold' : 'bg-surface-hover text-muted'}`}>
                        {g.isDefault && '⭐ '}{g.name} · {g.type}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {branches.length === 0 && <div className="col-span-full text-center py-12 text-muted">No branches yet. Add your first branch.</div>}
        </div>
      )}

      {/* ═══════ GODOWNS ═══════ */}
      {tab === 'godowns' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {godownSummary.map(g => {
            const typeColors = { Warehouse: 'bg-blue-500/10 text-blue-400', Showroom: 'bg-purple-500/10 text-purple-400', Factory: 'bg-orange-500/10 text-orange-400' }
            return (
              <div key={g.id} className={`glass-card p-5 ${g.isDefault ? 'ring-2 ring-accent/30' : ''}`}>
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-foreground">{g.name}</h3>
                    {g.isDefault && <span className="text-[9px] bg-accent/20 text-accent px-2 py-0.5 rounded-full font-semibold">⭐ DEFAULT</span>}
                    <span className={`text-[9px] px-2 py-0.5 rounded-full font-medium ${typeColors[g.type] || typeColors.Warehouse}`}>{g.type}</span>
                  </div>
                  <div className="flex gap-0.5">
                    {!g.isDefault && (
                      <button onClick={async () => { const r = await setDefaultGodown(g.id); if (r.success) loadData() }}
                        className="p-1.5 text-muted hover:text-accent rounded" title="Set as default">
                        <Star className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={async () => { if (await confirmDialog('Delete this godown?')) { const r = await deleteGodown(g.id); if (r.success) loadData(); else notify(r.error, { variant: 'danger' }) }}}
                      className="p-1.5 text-red-400/50 hover:text-red-400 rounded"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
                <p className="text-xs text-muted mb-3">Branch: {g.branch?.name || 'Unassigned'}</p>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="bg-surface rounded-lg p-2 text-center">
                    <p className="text-sm font-bold text-foreground">{g.totalItems}</p>
                    <p className="text-[9px] text-muted">Items</p>
                  </div>
                  <div className="bg-surface rounded-lg p-2 text-center">
                    <p className="text-sm font-bold text-foreground">₹{(g.totalValue / 1000).toFixed(0)}k</p>
                    <p className="text-[9px] text-muted">Value</p>
                  </div>
                  <div className="bg-surface rounded-lg p-2 text-center">
                    <p className="text-sm font-bold text-foreground">{g._count?.stocks || 0}</p>
                    <p className="text-[9px] text-muted">Products</p>
                  </div>
                </div>

                {/* Capacity bar */}
                {g.capacity && (
                  <div>
                    <div className="flex justify-between text-[10px] text-muted mb-1">
                      <span>Capacity</span>
                      <span>{g.utilization}% ({g.totalItems}/{g.capacity})</span>
                    </div>
                    <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${g.utilization >= 90 ? 'bg-red-500' : g.utilization >= 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(100, g.utilization)}%` }} />
                    </div>
                  </div>
                )}

                {g.address && <p className="text-[10px] text-muted flex items-center gap-1 mt-2"><MapPin className="w-3 h-3" /> {g.address}</p>}
              </div>
            )
          })}
          {godownSummary.length === 0 && <div className="col-span-full text-center py-12 text-muted">No godowns yet. Add your first godown.</div>}
        </div>
      )}

      {/* ═══════ STOCK VIEW ═══════ */}
      {tab === 'stock' && (
        <div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
            <select value={selectedGodown} onChange={e => setSelectedGodown(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
              <option value="">All Godowns</option>
              {godowns.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border">
                  {['Product', 'SKU', 'Category', 'Godown', 'Type', 'Quantity', 'Value'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
                </tr></thead>
                <tbody>
                  {filteredStocks.map(s => (
                    <tr key={s.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                      <td className="px-4 py-3 text-foreground font-medium">{s.product?.name}</td>
                      <td className="px-4 py-3 text-muted font-mono text-xs">{s.product?.sku}</td>
                      <td className="px-4 py-3 text-muted">{s.product?.category?.name || '—'}</td>
                      <td className="px-4 py-3 text-foreground">{s.godown?.name}</td>
                      <td className="px-4 py-3"><span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-hover text-muted">{s.godown?.type}</span></td>
                      <td className="px-4 py-3">
                        <span className={`font-medium ${s.quantity <= 0 ? 'text-red-400' : s.quantity < 5 ? 'text-amber-400' : 'text-emerald-400'}`}>{s.quantity}</span>
                      </td>
                      <td className="px-4 py-3 text-foreground">₹{((s.quantity || 0) * (s.product?.price || 0)).toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filteredStocks.length === 0 && <div className="text-center py-12 text-muted">No stock records found. Stock arrives through goods receipts; use &quot;Sync Stock&quot; once for products that had stock before godowns were set up, and Transfers to move stock between godowns.</div>}
          </div>
        </div>
      )}

      {/* ═══════ TRANSFERS ═══════ */}
      {tab === 'transfers' && (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {['Transfer #', 'From', 'To', 'Items', 'Date', 'Requested By', 'Status', 'Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
              </tr></thead>
              <tbody>
                {transfers.map(t => (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground font-mono text-xs">{t.displayId}</td>
                    <td className="px-4 py-3 text-foreground">{t.fromGodown?.name}</td>
                    <td className="px-4 py-3 text-foreground">{t.toGodown?.name}</td>
                    <td className="px-4 py-3 text-muted">
                      <div>{t.items?.length || 0} item{t.items?.length !== 1 ? 's' : ''}</div>
                      <div className="text-[10px] text-muted">{t.items?.reduce((s, i) => s + i.quantity, 0)} units</div>
                    </td>
                    <td className="px-4 py-3 text-muted">{new Date(t.date).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-3 text-muted">{t.requestedBy || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${t.status === 'Completed' ? 'bg-emerald-500/10 text-emerald-400' : t.status === 'Cancelled' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>{t.status}</span>
                    </td>
                    <td className="px-4 py-3">
                      {t.status === 'Pending' && (
                        <div className="flex gap-1.5">
                          <button onClick={() => handleCompleteTransfer(t.id)}
                            className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 border border-emerald-500/20 flex items-center gap-1">
                            <CheckCircle className="w-3.5 h-3.5" /> Complete
                          </button>
                          <button onClick={() => handleCancelTransfer(t.id)}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted hover:text-red-500 border border-border hover:border-red-500/30">
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {transfers.length === 0 && <div className="text-center py-12 text-muted">No transfers found</div>}
        </div>
      )}

      {/* ═══════ STOCK LEDGER ═══════ */}
      {tab === 'ledger' && (
        <div className="space-y-4">
          <p className="text-xs text-muted">Complete audit trail of all stock movements across godowns. Every add, transfer, sale, and adjustment is recorded.</p>
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border">
                  {['Date', 'Product', 'Godown', 'Type', 'Qty', 'Balance', 'Reference', 'Notes', 'By'].map(h => <th key={h} className="px-3 py-3 text-left text-xs font-medium text-muted uppercase whitespace-nowrap">{h}</th>)}
                </tr></thead>
                <tbody>
                  {ledgerEntries.map(e => {
                    const typeColors = {
                      'IN': 'bg-emerald-500/10 text-emerald-400',
                      'OUT': 'bg-red-500/10 text-red-400',
                      'TRANSFER_IN': 'bg-blue-500/10 text-blue-400',
                      'TRANSFER_OUT': 'bg-orange-500/10 text-orange-400',
                      'ADJUSTMENT': 'bg-amber-500/10 text-amber-400',
                      'PRODUCTION': 'bg-purple-500/10 text-purple-400',
                      'SALE': 'bg-red-500/10 text-red-400',
                      'RETURN': 'bg-cyan-500/10 text-cyan-400',
                    }
                    return (
                      <tr key={e.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                        <td className="px-3 py-2.5 text-muted text-xs whitespace-nowrap">{new Date(e.createdAt).toLocaleDateString('en-IN')} {new Date(e.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
                        <td className="px-3 py-2.5">
                          <p className="text-foreground font-medium text-xs">{e.product?.name}</p>
                          <p className="text-[10px] text-muted font-mono">{e.product?.sku}</p>
                        </td>
                        <td className="px-3 py-2.5 text-foreground text-xs">{e.godown?.name}</td>
                        <td className="px-3 py-2.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${typeColors[e.entryType] || 'bg-gray-500/10 text-gray-400'}`}>{e.entryType.replace('_', ' ')}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`font-semibold text-sm flex items-center gap-0.5 ${e.quantity > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {e.quantity > 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                            {Math.abs(e.quantity)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-foreground font-medium text-xs">{e.balanceAfter}</td>
                        <td className="px-3 py-2.5 text-muted text-[10px]">{e.referenceType || '—'}</td>
                        <td className="px-3 py-2.5 text-muted text-[10px] max-w-[200px] truncate">{e.notes || '—'}</td>
                        <td className="px-3 py-2.5 text-muted text-[10px]">{e.createdBy || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {ledgerEntries.length === 0 && <div className="text-center py-12 text-muted">No ledger entries yet. Stock movements will appear here.</div>}
          </div>
        </div>
      )}

      {/* ═══════ MODALS ═══════ */}

      {/* Create Branch Modal */}
      <Modal isOpen={showBranchModal} onClose={() => setShowBranchModal(false)} title="Add Branch">
        <div className="space-y-4">
          {[
            { key: 'name', label: 'Branch Name *', type: 'text' },
            { key: 'address', label: 'Address', type: 'text' },
            { key: 'phone', label: 'Phone', type: 'text' },
            { key: 'email', label: 'Email', type: 'email' },
            { key: 'managerName', label: 'Manager Name', type: 'text' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-sm text-muted mb-1 block">{f.label}</label>
              <input type={f.type} value={branchForm[f.key]} onChange={e => setBranchForm(p => ({ ...p, [f.key]: e.target.value }))} className={INP} />
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={branchForm.isHeadOffice} onChange={e => setBranchForm(p => ({ ...p, isHeadOffice: e.target.checked }))} className="rounded" />
            Head Office
          </label>
          <button onClick={handleCreateBranch} disabled={submitting || !branchForm.name} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Branch'}
          </button>
        </div>
      </Modal>

      {/* Create Godown Modal */}
      <Modal isOpen={showGodownModal} onClose={() => setShowGodownModal(false)} title="Add Godown">
        <div className="space-y-4">
          <div>
            <label className="text-sm text-muted mb-1 block">Godown Name *</label>
            <input value={godownForm.name} onChange={e => setGodownForm(p => ({ ...p, name: e.target.value }))} className={INP} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted mb-1 block">Type</label>
              <select value={godownForm.type} onChange={e => setGodownForm(p => ({ ...p, type: e.target.value }))} className={SEL}>
                <option value="Warehouse">Warehouse</option>
                <option value="Showroom">Showroom</option>
                <option value="Factory">Factory</option>
              </select>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Capacity (items)</label>
              <input type="number" min="0" value={godownForm.capacity} onChange={e => setGodownForm(p => ({ ...p, capacity: e.target.value }))} placeholder="Optional" className={INP} />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Branch</label>
            <select value={godownForm.branchId} onChange={e => setGodownForm(p => ({ ...p, branchId: e.target.value }))} className={SEL}>
              <option value="">Select Branch</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Address</label>
            <textarea value={godownForm.address} onChange={e => setGodownForm(p => ({ ...p, address: e.target.value }))} rows={2} className={INP} />
          </div>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={godownForm.isDefault} onChange={e => setGodownForm(p => ({ ...p, isDefault: e.target.checked }))} className="rounded" />
            Set as Default Godown (primary stock location)
          </label>
          <button onClick={handleCreateGodown} disabled={submitting || !godownForm.name} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Godown'}
          </button>
        </div>
      </Modal>

      {/* Create Transfer Modal */}
      <Modal isOpen={showTransferModal} onClose={() => setShowTransferModal(false)} title="New Inter-Godown Transfer" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted mb-1 block">From Godown *</label>
              <select value={transferForm.fromGodownId} onChange={e => setTransferForm(p => ({ ...p, fromGodownId: e.target.value }))} className={SEL}>
                <option value="">Select Source</option>
                {godowns.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">To Godown *</label>
              <select value={transferForm.toGodownId} onChange={e => setTransferForm(p => ({ ...p, toGodownId: e.target.value }))} className={SEL}>
                <option value="">Select Destination</option>
                {godowns.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Requested By</label>
            <input value={transferForm.requestedBy} onChange={e => setTransferForm(p => ({ ...p, requestedBy: e.target.value }))} className={INP} />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-muted">Items</label>
              <button onClick={() => setTransferForm(f => ({ ...f, items: [...f.items, { productId: '', name: '', sku: '', quantity: 1 }] }))} className="text-xs text-accent hover:underline">+ Add Item</button>
            </div>
            {transferForm.items.map((item, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 mb-2">
                <select value={item.productId} onChange={e => { const v = [...transferForm.items]; v[i].productId = e.target.value; setTransferForm(f => ({ ...f, items: v })) }} className="col-span-8 px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                  <option value="">Select Product</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                </select>
                <input type="number" min="1" value={item.quantity} onChange={e => { const v = [...transferForm.items]; v[i].quantity = e.target.value; setTransferForm(f => ({ ...f, items: v })) }} placeholder="Qty" className="col-span-3 px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                <button onClick={() => setTransferForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))} className="col-span-1 text-red-400 hover:text-red-300 text-lg">×</button>
              </div>
            ))}
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Notes</label>
            <textarea value={transferForm.notes} onChange={e => setTransferForm(p => ({ ...p, notes: e.target.value }))} rows={2} className={INP} />
          </div>
          <button onClick={handleCreateTransfer} disabled={submitting || !transferForm.fromGodownId || !transferForm.toGodownId || !transferForm.items.some(i => i.productId)} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Transfer'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
