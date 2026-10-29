'use client'

import { useState, useEffect } from 'react'
import {
  FileSpreadsheet, Plus, RefreshCw, CheckCircle, Download,
  AlertCircle, Truck, X, Hash, ChevronDown, ChevronUp, FileText,
  ArrowUpRight, ArrowDownLeft, Shield
} from 'lucide-react'
import {
  getHsnCodes, createHsnCode, deleteHsnCode,
  generateGSTR1, generateGSTR2, generateGSTR3B, generateGSTR9,
  getGSTReturns, markReturnFiled,
  getEWayBills, createEWayBill, cancelEWayBill,
} from '@/app/actions/gst'
import Modal from '@/components/Modal'
import { getActiveVertical } from '@/lib/brand'
import { confirmDialog } from '@/components/AlertToastProvider';

const IS_TGM = getActiveVertical() === 'tiles'

const fmt = (n) => `₹${(n || 0).toLocaleString('en-IN')}`
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '—'

const statusColors = {
  DRAFT: 'bg-amber-500/10 text-amber-400',
  FILED: 'bg-emerald-500/10 text-emerald-400',
  GENERATED: 'bg-blue-500/10 text-blue-400',
  CANCELLED: 'bg-red-500/10 text-red-400',
  EXPIRED: 'bg-gray-500/10 text-gray-400',
}

export default function GSTPage() {
  const [tab, setTab] = useState('gstr1')
  const [loading, setLoading] = useState(true)
  const [hsnCodes, setHsnCodes] = useState([])
  const [returns, setReturns] = useState([])
  const [eWayBills, setEWayBills] = useState([])
  const [period, setPeriod] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [fyYear, setFyYear] = useState(new Date().getFullYear())
  const [generating, setGenerating] = useState(false)
  const [generatedData, setGeneratedData] = useState(null)

  // HSN modal
  const [showHsnModal, setShowHsnModal] = useState(false)
  const [hsnForm, setHsnForm] = useState({ code: '', description: '', gstRate: 18, cessRate: 0, type: 'GOODS' })
  const [submitting, setSubmitting] = useState(false)

  // e-Way Bill modal
  const [showEwbModal, setShowEwbModal] = useState(false)
  const [ewbForm, setEwbForm] = useState({
    ewbNumber: '', vehicleNo: '', transporterGSTIN: '', transporterName: '',
    fromAddress: '', toAddress: '', distance: '', goodsDesc: '', hsnCode: '',
    quantity: '', value: '', validFrom: '', validUntil: '', notes: '',
  })

  // Expand sections in GSTR-1
  const [expandedSections, setExpandedSections] = useState({ b2b: true, b2cl: false, b2cs: false, cdnr: false, exports: false, nil: false, hsn: true, docs: true })
  const toggleSection = (key) => setExpandedSections(p => ({ ...p, [key]: !p[key] }))

  const loadData = () => {
    setLoading(true)
    Promise.all([getHsnCodes(), getGSTReturns(), getEWayBills()]).then(([hsnRes, retRes, ewbRes]) => {
      if (hsnRes.success) setHsnCodes(hsnRes.data)
      if (retRes.success) setReturns(retRes.data)
      if (ewbRes.success) setEWayBills(ewbRes.data)
      setLoading(false)
    })
  }

  useEffect(() => { loadData() }, [])

  const handleGenerate = async (type) => {
    setGenerating(true)
    setGeneratedData(null)
    let res
    if (type === 'GSTR9') res = await generateGSTR9(fyYear)
    else if (type === 'GSTR1') res = await generateGSTR1(period)
    else if (type === 'GSTR2') res = await generateGSTR2(period)
    else res = await generateGSTR3B(period)
    if (res.success) { setGeneratedData(res.data); loadData() }
    else alert(res.error)
    setGenerating(false)
  }

  const handleMarkFiled = async (id) => {
    if (!await confirmDialog('Mark this return as FILED? This action confirms portal submission.')) return
    const res = await markReturnFiled(id)
    if (res.success) loadData()
    else alert(res.error)
  }

  const handleDeleteHsn = async (id) => {
    if (!await confirmDialog('Delete this HSN code?')) return
    const res = await deleteHsnCode(id)
    if (res.success) loadData()
    else alert(res.error)
  }

  const handleCreateHsn = async () => {
    setSubmitting(true)
    const res = await createHsnCode({ ...hsnForm, gstRate: Number(hsnForm.gstRate), cessRate: Number(hsnForm.cessRate) })
    if (res.success) { setShowHsnModal(false); setHsnForm({ code: '', description: '', gstRate: 18, cessRate: 0, type: 'GOODS' }); loadData() }
    else alert(res.error)
    setSubmitting(false)
  }

  const handleCreateEwb = async () => {
    setSubmitting(true)
    const res = await createEWayBill({
      ...ewbForm,
      distance: ewbForm.distance ? Number(ewbForm.distance) : undefined,
      quantity: ewbForm.quantity ? Number(ewbForm.quantity) : undefined,
      value: Number(ewbForm.value) || 0,
    })
    if (res.success) { setShowEwbModal(false); setEwbForm({ ewbNumber: '', vehicleNo: '', transporterGSTIN: '', transporterName: '', fromAddress: '', toAddress: '', distance: '', goodsDesc: '', hsnCode: '', quantity: '', value: '', validFrom: '', validUntil: '', notes: '' }); loadData() }
    else alert(res.error)
    setSubmitting(false)
  }

  const handleCancelEwb = async (id) => {
    if (!await confirmDialog('Cancel this e-Way Bill?')) return
    const res = await cancelEWayBill(id)
    if (res.success) loadData()
    else alert(res.error)
  }

  const handleExportJSON = (ret) => {
    const d = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${ret.returnType}_${ret.period}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const sanitizeSheetName = (name) => {
    const cleaned = String(name || 'Sheet1').replace(/[\\/*?:\[\]]/g, '_')
    return cleaned.slice(0, 31) || 'Sheet1'
  }

  const flattenRow = (value, prefix = '') => {
    if (value === null || value === undefined) return { [prefix || 'value']: '' }
    if (Array.isArray(value)) return { [prefix || 'value']: JSON.stringify(value) }
    if (typeof value !== 'object') return { [prefix || 'value']: value }

    const out = {}
    Object.entries(value).forEach(([key, nested]) => {
      const path = prefix ? `${prefix}.${key}` : key
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        Object.assign(out, flattenRow(nested, path))
      } else if (Array.isArray(nested)) {
        out[path] = JSON.stringify(nested)
      } else {
        out[path] = nested
      }
    })
    return out
  }

  const buildExcelSheets = (payload) => {
    const sheets = [{ name: 'SUMMARY', rows: [flattenRow(payload)] }]

    Object.entries(payload || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        if (value.length === 0) return
        const rows = value.map(item => (
          item && typeof item === 'object' ? flattenRow(item) : { value: item }
        ))
        sheets.push({ name: key.toUpperCase(), rows })
        return
      }

      if (value && typeof value === 'object') {
        const hasNestedArrays = Object.values(value).some(v => Array.isArray(v))
        if (!hasNestedArrays) {
          sheets.push({ name: key.toUpperCase(), rows: [flattenRow(value)] })
        }
      }
    })

    return sheets
  }

  const handleExportExcel = async (ret) => {
    try {
      const payload = typeof ret.data === 'string' ? JSON.parse(ret.data) : ret.data
      const XLSX = await import('xlsx')
      const workbook = XLSX.utils.book_new()

      const sheets = buildExcelSheets(payload)
      sheets.forEach(sheet => {
        const rows = sheet.rows.length > 0 ? sheet.rows : [{}]
        const worksheet = XLSX.utils.json_to_sheet(rows)
        XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(sheet.name))
      })

      XLSX.writeFile(workbook, `${ret.returnType}_${ret.period}.xlsx`)
    } catch (error) {
      console.error(error)
      alert('Failed to export Excel file')
    }
  }

  const tabs = [
    { id: 'gstr1', label: 'GSTR-1', icon: ArrowUpRight },
    { id: 'gstr2', label: 'GSTR-2', icon: ArrowDownLeft },
    { id: 'gstr3b', label: 'GSTR-3B', icon: FileSpreadsheet },
    { id: 'gstr9', label: 'GSTR-9 Annual', icon: FileText },
    { id: 'hsn', label: 'HSN Master', icon: Hash },
    { id: 'ewaybill', label: 'e-Way Bills', icon: Truck },
    { id: 'history', label: 'Filing History', icon: CheckCircle },
  ]

  const SectionHeader = ({ title, count, sectionKey, badge }) => (
    <button onClick={() => toggleSection(sectionKey)}
      className="w-full flex items-center justify-between px-4 py-3 bg-surface-hover hover:bg-surface-hover/80 rounded-lg transition-colors">
      <span className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {count !== undefined && <span className="px-2 py-0.5 bg-accent/10 text-accent rounded-full text-xs">{count} records</span>}
        {badge && <span className="px-2 py-0.5 bg-purple-500/10 text-purple-400 rounded-full text-xs">{badge}</span>}
      </span>
      {expandedSections[sectionKey] ? <ChevronUp className="w-4 h-4 text-muted" /> : <ChevronDown className="w-4 h-4 text-muted" />}
    </button>
  )

  const renderGSTR1 = () => {
    if (!generatedData?.data) return null
    const d = typeof generatedData.data === 'string' ? JSON.parse(generatedData.data) : generatedData.data

    return (
      <div className="space-y-4">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Total Invoices', value: d.totals?.totalInvoices || 0 },
            { label: 'Taxable Value', value: fmt(d.totals?.taxableValue) },
            { label: 'CGST', value: fmt(d.totals?.cgst) },
            { label: 'SGST', value: fmt(d.totals?.sgst) },
            { label: 'IGST', value: fmt(d.totals?.igst) },
          ].map((s, i) => (
            <div key={i} className="bg-surface-hover p-3 rounded-lg">
              <p className="text-xs text-muted">{s.label}</p>
              <p className="text-base font-semibold text-foreground">{s.value}</p>
            </div>
          ))}
        </div>

        {/* B2B — Registered Buyers */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 4A — B2B (Registered Buyers)" count={d.b2b?.length} sectionKey="b2b" badge="GSTIN Buyers" />
          {expandedSections.b2b && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-surface">
                  {['Invoice', 'Date', 'Customer', 'GSTIN', 'Place of Supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'].map(h =>
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.b2b?.map((inv, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{inv.displayId}</td>
                      <td className="px-3 py-2 text-muted">{fmtDate(inv.date)}</td>
                      <td className="px-3 py-2 text-foreground">{inv.customer}</td>
                      <td className="px-3 py-2 text-accent font-mono text-xs">{inv.gstin}</td>
                      <td className="px-3 py-2 text-muted">{inv.placeOfSupply}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.taxableValue)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.cgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.sgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.igst)}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{fmt(inv.total)}</td>
                    </tr>
                  ))}
                  {(!d.b2b?.length) && <tr><td colSpan={10} className="px-3 py-4 text-center text-muted">No B2B invoices</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* B2CL — Large B2C (Interstate > 2.5L) */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 5 — B2CL (Interstate > ₹2.5L, Unregistered)" count={d.b2cl?.length} sectionKey="b2cl" />
          {expandedSections.b2cl && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-surface">
                  {['Invoice', 'Date', 'Customer', 'Place of Supply', 'Taxable', 'IGST', 'Total'].map(h =>
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.b2cl?.map((inv, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{inv.displayId}</td>
                      <td className="px-3 py-2 text-muted">{fmtDate(inv.date)}</td>
                      <td className="px-3 py-2 text-foreground">{inv.customer}</td>
                      <td className="px-3 py-2 text-muted">{inv.placeOfSupply}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.taxableValue)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.igst)}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{fmt(inv.total)}</td>
                    </tr>
                  ))}
                  {(!d.b2cl?.length) && <tr><td colSpan={7} className="px-3 py-4 text-center text-muted">No B2CL invoices</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* B2CS — Small B2C */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 7 — B2CS (Small B2C / Intrastate)" count={d.b2cs?.length} sectionKey="b2cs" />
          {expandedSections.b2cs && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-surface">
                  {['Invoice', 'Date', 'Customer', 'Supply Type', 'Taxable', 'CGST', 'SGST', 'Total'].map(h =>
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.b2cs?.map((inv, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{inv.displayId}</td>
                      <td className="px-3 py-2 text-muted">{fmtDate(inv.date)}</td>
                      <td className="px-3 py-2 text-foreground">{inv.customer}</td>
                      <td className="px-3 py-2"><span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs">{inv.supplyType}</span></td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.taxableValue)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.cgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.sgst)}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{fmt(inv.total)}</td>
                    </tr>
                  ))}
                  {(!d.b2cs?.length) && <tr><td colSpan={8} className="px-3 py-4 text-center text-muted">No B2CS invoices</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Credit Notes */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 9B — CDNR (Credit Notes to Registered)" count={d.cdnr?.length} sectionKey="cdnr" />
          {expandedSections.cdnr && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-surface">
                  {['Credit Note', 'Date', 'Customer', 'GSTIN', 'Amount', 'Reason'].map(h =>
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.cdnr?.map((c, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{c.displayId}</td>
                      <td className="px-3 py-2 text-muted">{fmtDate(c.date)}</td>
                      <td className="px-3 py-2 text-foreground">{c.customer}</td>
                      <td className="px-3 py-2 text-accent font-mono text-xs">{c.gstin}</td>
                      <td className="px-3 py-2 text-red-400">{fmt(c.amount)}</td>
                      <td className="px-3 py-2 text-muted">{c.reason}</td>
                    </tr>
                  ))}
                  {d.cdns?.length > 0 && d.cdns.map((c, i) => (
                    <tr key={`cdns-${i}`} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{c.displayId}</td>
                      <td className="px-3 py-2 text-muted">{fmtDate(c.date)}</td>
                      <td className="px-3 py-2 text-foreground">{c.customer} <span className="text-xs text-muted">(B2C)</span></td>
                      <td className="px-3 py-2 text-muted">—</td>
                      <td className="px-3 py-2 text-red-400">{fmt(c.amount)}</td>
                      <td className="px-3 py-2 text-muted">{c.reason}</td>
                    </tr>
                  ))}
                  {(!d.cdnr?.length && !d.cdns?.length) && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted">No credit notes</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Exports */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 6A — Exports" count={d.exports?.length} sectionKey="exports" />
          {expandedSections.exports && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-surface">
                  {['Invoice', 'Date', 'Customer', 'Taxable', 'IGST', 'Total'].map(h =>
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.exports?.map((inv, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{inv.displayId}</td>
                      <td className="px-3 py-2 text-muted">{fmtDate(inv.date)}</td>
                      <td className="px-3 py-2 text-foreground">{inv.customer}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.taxableValue)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(inv.igst)}</td>
                      <td className="px-3 py-2 font-medium text-foreground">{fmt(inv.total)}</td>
                    </tr>
                  ))}
                  {(!d.exports?.length) && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted">No export invoices</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Nil / Exempt */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 8 — Nil/Exempt Supplies" count={d.nilExempt?.count} sectionKey="nil" />
          {expandedSections.nil && (
            <div className="grid grid-cols-3 gap-4 p-4">
              <div className="bg-surface-hover p-3 rounded-lg">
                <p className="text-xs text-muted">Nil-Rated</p>
                <p className="font-semibold text-foreground">{fmt(d.nilExempt?.nilRated)}</p>
              </div>
              <div className="bg-surface-hover p-3 rounded-lg">
                <p className="text-xs text-muted">Exempt</p>
                <p className="font-semibold text-foreground">{fmt(d.nilExempt?.exempt)}</p>
              </div>
              <div className="bg-surface-hover p-3 rounded-lg">
                <p className="text-xs text-muted">Total Count</p>
                <p className="font-semibold text-foreground">{d.nilExempt?.count || 0} invoices</p>
              </div>
            </div>
          )}
        </div>

        {/* HSN Summary */}
        <div className="glass-card overflow-hidden">
          <SectionHeader title="Table 12 — HSN-wise Summary" count={d.hsnSummary?.length} sectionKey="hsn" />
          {expandedSections.hsn && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-surface">
                  {['HSN', 'Description', 'UQC', 'Qty', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Cess'].map(h =>
                    <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
                </tr></thead>
                <tbody>
                  {d.hsnSummary?.map((h, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-3 py-2 font-medium text-foreground">{h.hsn}</td>
                      <td className="px-3 py-2 text-foreground">{h.description}</td>
                      <td className="px-3 py-2 text-muted">{h.uqc}</td>
                      <td className="px-3 py-2 text-foreground">{h.qty}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(h.taxableValue)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(h.cgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(h.sgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(h.igst)}</td>
                      <td className="px-3 py-2 text-muted">{fmt(h.cess)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Document Summary */}
        {d.docSummary && (
          <div className="glass-card overflow-hidden">
            <SectionHeader title="Table 13 — Document Serial Summary" sectionKey="docs" />
            {expandedSections.docs && (
              <div className="grid grid-cols-4 gap-4 p-4">
                <div className="bg-surface-hover p-3 rounded-lg">
                  <p className="text-xs text-muted">From Invoice</p>
                  <p className="font-semibold text-foreground">{d.docSummary.from}</p>
                </div>
                <div className="bg-surface-hover p-3 rounded-lg">
                  <p className="text-xs text-muted">To Invoice</p>
                  <p className="font-semibold text-foreground">{d.docSummary.to}</p>
                </div>
                <div className="bg-surface-hover p-3 rounded-lg">
                  <p className="text-xs text-muted">Total Issued</p>
                  <p className="font-semibold text-foreground">{d.docSummary.count}</p>
                </div>
                <div className="bg-surface-hover p-3 rounded-lg">
                  <p className="text-xs text-muted">Cancelled</p>
                  <p className="font-semibold text-foreground">{d.docSummary.cancelled}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderGSTR2 = () => {
    if (!generatedData?.data) return null
    const d = typeof generatedData.data === 'string' ? JSON.parse(generatedData.data) : generatedData.data

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label: 'Posted vendor bills', value: d.summary?.totalPOs || 0 },
            { label: 'Total Taxable Value', value: fmt(d.summary?.totalTaxableValue) },
            { label: 'Total ITC Available', value: fmt(d.summary?.totalITC) },
            { label: 'CGST', value: fmt(d.summary?.cgst) },
            { label: 'SGST', value: fmt(d.summary?.sgst) },
            { label: 'IGST', value: fmt(d.summary?.igst) },
          ].map((s, i) => (
            <div key={i} className="bg-surface-hover p-3 rounded-lg">
              <p className="text-xs text-muted">{s.label}</p>
              <p className="text-base font-semibold text-foreground">{s.value}</p>
            </div>
          ))}
        </div>

        {/* ITC Classification — Table 4 */}
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">Table 4 — ITC Classification</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {['Category', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total ITC'].map(h =>
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
              </tr></thead>
              <tbody>
                {[
                  { label: 'Inputs (Raw Material / Goods)', key: 'inputs', color: 'emerald' },
                  { label: 'Input Services', key: 'services', color: 'blue' },
                  { label: 'Capital Goods', key: 'capitalGoods', color: 'purple' },
                  { label: 'Ineligible ITC', key: 'ineligible', color: 'red' },
                ].map(({ label, key, color }) => {
                  const c = d.itcClassification?.[key] || {}
                  return (
                    <tr key={key} className="border-b border-border/50">
                      <td className="px-3 py-2 font-medium text-foreground">{label}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(c.taxable)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(c.cgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(c.sgst)}</td>
                      <td className="px-3 py-2 text-foreground">{fmt(c.igst)}</td>
                      <td className={`px-3 py-2 font-semibold text-${color}-400`}>{fmt(c.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* RCM Supplies */}
        {d.rcmSupplies?.length > 0 && (
          <div className="glass-card p-4">
            <h4 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4 text-amber-400" /> Reverse Charge Mechanism (RCM) Supplies
            </h4>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {['PO #', 'Supplier', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST'].map(h =>
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
              </tr></thead>
              <tbody>
                {d.rcmSupplies.map((r, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-3 py-2 font-medium text-foreground">{r.displayId}</td>
                    <td className="px-3 py-2 text-foreground">{r.supplier}</td>
                    <td className="px-3 py-2 text-muted font-mono text-xs">{r.gstin || '—'}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(r.taxableValue)}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(r.cgst)}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(r.sgst)}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(r.igst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Supplier-wise detail */}
        <div className="glass-card overflow-hidden">
          <h4 className="text-sm font-medium text-foreground px-4 py-3 border-b border-border">Supplier-wise Inward Supplies</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-surface">
                {['PO #', 'Date', 'Supplier', 'GSTIN', 'Category', 'Taxable', 'CGST', 'SGST', 'IGST', 'ITC', 'RCM'].map(h =>
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
              </tr></thead>
              <tbody>
                {d.supplierWise?.map((s, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                    <td className="px-3 py-2 font-medium text-foreground">{s.displayId}</td>
                    <td className="px-3 py-2 text-muted">{fmtDate(s.date)}</td>
                    <td className="px-3 py-2 text-foreground">{s.supplier}</td>
                    <td className="px-3 py-2 text-muted font-mono text-xs">{s.gstin || '—'}</td>
                    <td className="px-3 py-2"><span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs">{s.itcCategory}</span></td>
                    <td className="px-3 py-2 text-foreground">{fmt(s.taxableValue)}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(s.cgst)}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(s.sgst)}</td>
                    <td className="px-3 py-2 text-foreground">{fmt(s.igst)}</td>
                    <td className="px-3 py-2 text-emerald-400">{fmt(s.itcEligible)}</td>
                    <td className="px-3 py-2">{s.isRCM && <span className="px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded text-xs">RCM</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  const renderGSTR3B = () => {
    if (!generatedData?.data) return null
    const d = typeof generatedData.data === 'string' ? JSON.parse(generatedData.data) : generatedData.data

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 text-sm mb-2">
          {[
            { label: 'GSTR-1', filed: d.gstr1Generated },
            { label: 'GSTR-2', filed: d.gstr2Generated },
          ].map(({ label, filed }) => (
            <span key={label} className={`flex items-center gap-1 ${filed ? 'text-emerald-400' : 'text-red-400'}`}>
              {filed ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {label} {filed ? 'generated' : 'not generated — generate first for accurate 3B'}
            </span>
          ))}
        </div>

        {/* Table 3.1 */}
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">3.1 — Outward Supplies and Tax Payable</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {['', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Cess'].map(h =>
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
              </tr></thead>
              <tbody>
                {[
                  { label: '(a) Outward taxable supplies (other than zero-rated/nil/exempt)', keys: ['a_taxable', 'a_cgst', 'a_sgst', 'a_igst', 'a_cess'] },
                  { label: '(b) Outward taxable zero-rated', keys: ['b_zeroRated', 0, 0, 0, 0] },
                  { label: '(c) Nil rated / Exempt', keys: ['c_nil', 0, 0, 0, 0] },
                  { label: '(d) Inward supplies liable to RCM', keys: ['d_rcm', 0, 0, 0, 0] },
                ].map(({ label, keys }) => (
                  <tr key={label} className="border-b border-border/50">
                    <td className="px-3 py-2 text-muted text-xs">{label}</td>
                    {keys.map((k, ki) => (
                      <td key={ki} className="px-3 py-2 font-medium text-foreground">
                        {typeof k === 'string' ? fmt(d.table3_1?.[k]) : fmt(k)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Table 3.2 */}
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">3.2 — Interstate Supplies (to Unregistered)</h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><p className="text-xs text-muted">Taxable Value</p><p className="font-semibold text-foreground">{fmt(d.table3_2?.unregistered)}</p></div>
            <div><p className="text-xs text-muted">IGST</p><p className="font-semibold text-foreground">{fmt(d.table3_2?.igst)}</p></div>
          </div>
        </div>

        {/* Table 4 ITC */}
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">4 — Eligible ITC</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {['', 'CGST', 'SGST', 'IGST', 'Total'].map(h =>
                  <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
              </tr></thead>
              <tbody>
                {[
                  { label: '4(A)(5) All other ITC — Inputs', val: d.table4?.a5_inputs },
                  { label: '4(A)(5) All other ITC — Input Services', val: d.table4?.a5_services },
                  { label: '4(A)(5) All other ITC — Capital Goods', val: d.table4?.a5_capitalGoods },
                  { label: '4(B) ITC Reversed', val: d.table4?.b_reversed },
                  { label: '4(D) Ineligible ITC', val: d.table4?.d_ineligible },
                ].map(({ label, val }) => (
                  <tr key={label} className="border-b border-border/50">
                    <td className="px-3 py-2 text-muted text-xs">{label}</td>
                    <td className="px-3 py-2 text-emerald-400">{fmt((d.table4?.cgst || 0) * ((val || 0) / (d.table4?.total || 1)))}</td>
                    <td className="px-3 py-2 text-emerald-400">{fmt((d.table4?.sgst || 0) * ((val || 0) / (d.table4?.total || 1)))}</td>
                    <td className="px-3 py-2 text-emerald-400">{fmt((d.table4?.igst || 0) * ((val || 0) / (d.table4?.total || 1)))}</td>
                    <td className="px-3 py-2 font-semibold text-emerald-400">{fmt(val)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-border bg-surface-hover">
                  <td className="px-3 py-2 font-medium text-foreground">Net ITC Available</td>
                  <td className="px-3 py-2 font-bold text-emerald-400">{fmt(d.table4?.cgst)}</td>
                  <td className="px-3 py-2 font-bold text-emerald-400">{fmt(d.table4?.sgst)}</td>
                  <td className="px-3 py-2 font-bold text-emerald-400">{fmt(d.table4?.igst)}</td>
                  <td className="px-3 py-2 font-bold text-emerald-400">{fmt(d.table4?.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Table 5 */}
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">5 — Values of Exempt, Nil-rated, Non-GST Inward Supplies</h4>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><p className="text-xs text-muted">Inter-State</p><p className="font-semibold text-foreground">{fmt(d.table5?.interState)}</p></div>
            <div><p className="text-xs text-muted">Intra-State</p><p className="font-semibold text-foreground">{fmt(d.table5?.intraState)}</p></div>
          </div>
        </div>

        {/* Table 6.1 Net Tax Payable */}
        <div className="glass-card p-4 border-2 border-accent/30">
          <h4 className="text-sm font-medium text-foreground mb-3">6.1 — Net Tax Payable</h4>
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div><p className="text-xs text-muted">CGST</p><p className="text-xl font-bold text-amber-400">{fmt(d.table6_1?.cgst)}</p></div>
            <div><p className="text-xs text-muted">SGST</p><p className="text-xl font-bold text-amber-400">{fmt(d.table6_1?.sgst)}</p></div>
            <div><p className="text-xs text-muted">IGST</p><p className="text-xl font-bold text-amber-400">{fmt(d.table6_1?.igst)}</p></div>
            <div><p className="text-xs text-muted">Total Payable</p><p className="text-2xl font-bold text-amber-400">{fmt(d.table6_1?.total)}</p></div>
          </div>
        </div>
      </div>
    )
  }

  const renderGSTR9 = () => {
    if (!generatedData?.data) return null
    const d = typeof generatedData.data === 'string' ? JSON.parse(generatedData.data) : generatedData.data

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label: 'Financial Year', value: d.financialYear },
            { label: 'Months Covered', value: `${d.monthsCovered} months` },
            { label: 'GSTR-1 Filed', value: `${d.gstr1Filed} / ${d.monthsCovered}` },
          ].map((s, i) => (
            <div key={i} className="bg-surface-hover p-3 rounded-lg">
              <p className="text-xs text-muted">{s.label}</p>
              <p className="text-base font-semibold text-foreground">{s.value}</p>
            </div>
          ))}
        </div>
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">Part II — Table 4: Outward Supplies</h4>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div><p className="text-xs text-muted">Taxable (B2B)</p><p className="font-semibold text-foreground">{fmt(d.table4?.a_taxableB2B)}</p></div>
            <div><p className="text-xs text-muted">CGST</p><p className="font-semibold text-foreground">{fmt(d.table4?.cgst)}</p></div>
            <div><p className="text-xs text-muted">SGST</p><p className="font-semibold text-foreground">{fmt(d.table4?.sgst)}</p></div>
            <div><p className="text-xs text-muted">IGST</p><p className="font-semibold text-foreground">{fmt(d.table4?.igst)}</p></div>
          </div>
        </div>
        <div className="glass-card p-4">
          <h4 className="text-sm font-medium text-foreground mb-3">Part II — Table 6: ITC Availed</h4>
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div><p className="text-xs text-muted">Total ITC</p><p className="font-semibold text-emerald-400">{fmt(d.table6?.a_itcAsPerGSTR2)}</p></div>
            <div><p className="text-xs text-muted">CGST</p><p className="font-semibold text-emerald-400">{fmt(d.table6?.cgst)}</p></div>
            <div><p className="text-xs text-muted">SGST</p><p className="font-semibold text-emerald-400">{fmt(d.table6?.sgst)}</p></div>
            <div><p className="text-xs text-muted">IGST</p><p className="font-semibold text-emerald-400">{fmt(d.table6?.igst)}</p></div>
          </div>
        </div>
        <div className="glass-card p-4 border-2 border-accent/30">
          <h4 className="text-sm font-medium text-foreground mb-3">Table 9 — Tax Payable for Full Year</h4>
          <div className="grid grid-cols-4 gap-4 text-sm">
            <div><p className="text-xs text-muted">CGST</p><p className="text-xl font-bold text-amber-400">{fmt(d.table9?.cgst)}</p></div>
            <div><p className="text-xs text-muted">SGST</p><p className="text-xl font-bold text-amber-400">{fmt(d.table9?.sgst)}</p></div>
            <div><p className="text-xs text-muted">IGST</p><p className="text-xl font-bold text-amber-400">{fmt(d.table9?.igst)}</p></div>
            <div><p className="text-xs text-muted">Total</p><p className="text-2xl font-bold text-amber-400">{fmt(d.table9?.total)}</p></div>
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">GST Compliance</h1>
          <p className="text-muted text-sm mt-1">GSTR-1, GSTR-2, GSTR-3B, GSTR-9 · HSN Master · e-Way Bills</p>
        </div>
        <div className="flex gap-2">
          {tab === 'hsn' && (
            <button onClick={() => setShowHsnModal(true)} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add HSN Code
            </button>
          )}
          {tab === 'ewaybill' && (
            <button onClick={() => setShowEwbModal(true)} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
              <Plus className="w-4 h-4" /> New e-Way Bill
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setGeneratedData(null) }}
            className={`px-3 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* GSTR-1 / GSTR-2 / GSTR-3B */}
      {['gstr1', 'gstr2', 'gstr3b'].includes(tab) && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <label className="text-sm text-muted mb-1 block">Period</label>
              <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
                className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
            <div className="pt-5">
              <button onClick={() => handleGenerate(tab === 'gstr1' ? 'GSTR1' : tab === 'gstr2' ? 'GSTR2' : 'GSTR3B')} disabled={generating}
                className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
                {generating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                {generating ? 'Generating...' : `Generate ${tab.toUpperCase()}`}
              </button>
            </div>
            {generatedData && (
              <div className="pt-5">
                <div className="flex items-center gap-2">
                  <button onClick={() => handleExportJSON(generatedData)}
                    className="px-4 py-2 bg-surface border border-border text-foreground rounded-lg text-sm font-medium hover:bg-surface-hover flex items-center gap-2">
                    <Download className="w-4 h-4" /> Export JSON
                  </button>
                  <button onClick={() => handleExportExcel(generatedData)}
                    className="px-4 py-2 bg-surface border border-border text-foreground rounded-lg text-sm font-medium hover:bg-surface-hover flex items-center gap-2">
                    <Download className="w-4 h-4" /> Export Excel
                  </button>
                </div>
              </div>
            )}
          </div>

          {generatedData && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-foreground">{tab.toUpperCase()} — {period}</h3>
                <span className="px-2 py-1 bg-amber-500/10 text-amber-400 rounded text-xs">DRAFT — not yet filed</span>
              </div>
              {tab === 'gstr1' && renderGSTR1()}
              {tab === 'gstr2' && renderGSTR2()}
              {tab === 'gstr3b' && renderGSTR3B()}
            </div>
          )}
        </div>
      )}

      {/* GSTR-9 Annual */}
      {tab === 'gstr9' && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <label className="text-sm text-muted mb-1 block">Financial Year Start</label>
              <input type="number" value={fyYear} onChange={e => setFyYear(Number(e.target.value))}
                min={2020} max={2030} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 w-28" />
              <p className="text-xs text-muted mt-1">FY {fyYear}-{String(fyYear + 1).slice(-2)} (Apr–Mar)</p>
            </div>
            <div className="pt-5">
              <button onClick={() => handleGenerate('GSTR9')} disabled={generating}
                className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
                {generating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                {generating ? 'Generating...' : 'Generate GSTR-9'}
              </button>
            </div>
            {generatedData && (
              <div className="pt-5">
                <div className="flex items-center gap-2">
                  <button onClick={() => handleExportJSON(generatedData)}
                    className="px-4 py-2 bg-surface border border-border text-foreground rounded-lg text-sm font-medium hover:bg-surface-hover flex items-center gap-2">
                    <Download className="w-4 h-4" /> Export JSON
                  </button>
                  <button onClick={() => handleExportExcel(generatedData)}
                    className="px-4 py-2 bg-surface border border-border text-foreground rounded-lg text-sm font-medium hover:bg-surface-hover flex items-center gap-2">
                    <Download className="w-4 h-4" /> Export Excel
                  </button>
                </div>
              </div>
            )}
          </div>
          {generatedData && renderGSTR9()}
        </div>
      )}

      {/* HSN Master */}
      {tab === 'hsn' && (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-surface">
              {['HSN Code', 'Description', 'GST Rate', 'Cess Rate', 'Type', ''].map(h =>
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {hsnCodes.map(h => (
                <tr key={h.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3 font-mono font-medium text-foreground">{h.code}</td>
                  <td className="px-4 py-3 text-foreground">{h.description}</td>
                  <td className="px-4 py-3 text-foreground">{h.gstRate}%</td>
                  <td className="px-4 py-3 text-muted">{h.cessRate}%</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs ${h.type === 'GOODS' ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400'}`}>{h.type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleDeleteHsn(h.id)} className="p-1.5 hover:bg-red-500/10 text-red-400 rounded-lg transition-colors">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hsnCodes.length === 0 && <div className="text-center py-12 text-muted">{IS_TGM ? 'No HSN codes added yet. Add TGM codes such as 2515/2516 for rough stone, 6802 for finished stone, 6907/6908 for tiles, and 3214 for adhesive/grout.' : 'No HSN codes added yet. Add common furniture HSN codes like 9401 (seating), 9403 (other furniture).'}</div>}
        </div>
      )}

      {/* e-Way Bills */}
      {tab === 'ewaybill' && (
        <div className="space-y-4">
          <div className="glass-card p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-sm text-amber-400 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>e-Way Bills are mandatory for goods movement above ₹50,000. Generate the actual e-Way Bill number from the GST portal (ewaybillgst.gov.in) and record it here for tracking.</span>
          </div>
          <div className="glass-card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-surface">
                {['EWB No.', 'Invoice', 'Customer', 'Vehicle', 'Transporter', 'Value', 'Valid Until', 'Status', ''].map(h =>
                  <th key={h} className="px-3 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
              </tr></thead>
              <tbody>
                {eWayBills.map(e => (
                  <tr key={e.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                    <td className="px-3 py-3 font-mono text-accent">{e.ewbNumber || '—'}</td>
                    <td className="px-3 py-3 text-foreground">{e.invoice?.displayId || '—'}</td>
                    <td className="px-3 py-3 text-foreground">{e.invoice?.contact?.name || '—'}</td>
                    <td className="px-3 py-3 text-foreground">{e.vehicleNo || '—'}</td>
                    <td className="px-3 py-3 text-foreground">{e.transporterName || '—'}</td>
                    <td className="px-3 py-3 text-foreground">{fmt(e.value)}</td>
                    <td className="px-3 py-3 text-muted">{fmtDate(e.validUntil)}</td>
                    <td className="px-3 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[e.status] || ''}`}>{e.status}</span></td>
                    <td className="px-3 py-3">
                      {e.status === 'GENERATED' && (
                        <button onClick={() => handleCancelEwb(e.id)} className="px-2 py-1 bg-red-500/10 text-red-400 rounded text-xs hover:bg-red-500/20">Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {eWayBills.length === 0 && <div className="text-center py-12 text-muted">No e-Way Bills recorded yet</div>}
          </div>
        </div>
      )}

      {/* Filing History */}
      {tab === 'history' && (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-surface">
              {['Return Type', 'Period', 'Status', 'Filed At', 'Actions'].map(h =>
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {returns.map(r => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">{r.returnType}</td>
                  <td className="px-4 py-3 text-foreground">{r.period}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[r.status] || ''}`}>{r.status}</span></td>
                  <td className="px-4 py-3 text-muted">{r.filedAt ? fmtDate(r.filedAt) : '—'}</td>
                  <td className="px-4 py-3 flex items-center gap-2">
                    {r.status === 'DRAFT' && (
                      <button onClick={() => handleMarkFiled(r.id)}
                        className="px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-lg text-xs hover:bg-emerald-500/20 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Mark Filed
                      </button>
                    )}
                    <button onClick={() => handleExportJSON(r)}
                      className="px-3 py-1 bg-surface border border-border text-muted rounded-lg text-xs hover:bg-surface-hover flex items-center gap-1">
                      <Download className="w-3 h-3" /> JSON
                    </button>
                    <button onClick={() => handleExportExcel(r)}
                      className="px-3 py-1 bg-surface border border-border text-muted rounded-lg text-xs hover:bg-surface-hover flex items-center gap-1">
                      <Download className="w-3 h-3" /> Excel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {returns.length === 0 && <div className="text-center py-12 text-muted">No GST returns generated yet</div>}
        </div>
      )}

      {/* HSN Modal */}
      <Modal isOpen={showHsnModal} onClose={() => setShowHsnModal(false)} title="Add HSN Code">
        <div className="space-y-4">
          {[
            { key: 'code', label: 'HSN/SAC Code *', placeholder: 'e.g. 9403' },
            { key: 'description', label: 'Description *', placeholder: IS_TGM ? 'e.g. Granite, worked and polished, cut-to-size' : 'e.g. Other furniture and parts thereof' },
            { key: 'gstRate', label: 'GST Rate (%)', placeholder: '18', type: 'number' },
            { key: 'cessRate', label: 'Cess Rate (%)', placeholder: '0', type: 'number' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-sm text-muted mb-1 block">{f.label}</label>
              <input type={f.type || 'text'} placeholder={f.placeholder} value={hsnForm[f.key]}
                onChange={e => setHsnForm(p => ({ ...p, [f.key]: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
          ))}
          <div>
            <label className="text-sm text-muted mb-1 block">Type</label>
            <select value={hsnForm.type} onChange={e => setHsnForm(p => ({ ...p, type: e.target.value }))}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
              <option value="GOODS">Goods</option>
              <option value="SERVICES">Services</option>
            </select>
          </div>
          <button onClick={handleCreateHsn} disabled={submitting || !hsnForm.code || !hsnForm.description}
            className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create HSN Code'}
          </button>
        </div>
      </Modal>

      {/* e-Way Bill Modal */}
      <Modal isOpen={showEwbModal} onClose={() => setShowEwbModal(false)} title="Record e-Way Bill">
        <div className="space-y-3">
          <p className="text-xs text-muted bg-surface-hover p-2 rounded">Generate the actual EWB on the GST portal first, then record the details here for tracking.</p>
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: 'ewbNumber', label: 'EWB Number', placeholder: 'From GST portal' },
              { key: 'vehicleNo', label: 'Vehicle No.', placeholder: 'MH12AB1234' },
              { key: 'transporterName', label: 'Transporter Name', placeholder: '' },
              { key: 'transporterGSTIN', label: 'Transporter GSTIN', placeholder: '' },
              { key: 'fromAddress', label: 'From Address', placeholder: 'Dispatch from' },
              { key: 'toAddress', label: 'To Address', placeholder: 'Deliver to' },
              { key: 'distance', label: 'Distance (km)', placeholder: '100', type: 'number' },
              { key: 'value', label: 'Invoice Value (₹)', placeholder: '50000', type: 'number' },
              { key: 'goodsDesc', label: 'Goods Description', placeholder: 'Wooden sofa set' },
              { key: 'hsnCode', label: 'HSN Code', placeholder: '9403' },
              { key: 'quantity', label: 'Quantity', placeholder: '1', type: 'number' },
              { key: 'validFrom', label: 'Valid From', type: 'datetime-local' },
              { key: 'validUntil', label: 'Valid Until', type: 'datetime-local' },
            ].map(f => (
              <div key={f.key} className={f.key === 'fromAddress' || f.key === 'toAddress' || f.key === 'goodsDesc' ? 'col-span-2' : ''}>
                <label className="text-xs text-muted mb-1 block">{f.label}</label>
                <input type={f.type || 'text'} placeholder={f.placeholder || ''} value={ewbForm[f.key]}
                  onChange={e => setEwbForm(p => ({ ...p, [f.key]: e.target.value }))}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
            ))}
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Notes</label>
            <textarea value={ewbForm.notes} onChange={e => setEwbForm(p => ({ ...p, notes: e.target.value }))} rows={2}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none" />
          </div>
          <button onClick={handleCreateEwb} disabled={submitting}
            className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Saving...' : 'Record e-Way Bill'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
