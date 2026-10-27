'use client'

import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import {
  BarChart3, TrendingUp, TrendingDown, Plus, RefreshCw,
  FileText, BookOpen, AlertCircle, ChevronDown, ChevronUp,
  Printer, Download, CheckCircle, XCircle, Users, ShoppingCart
} from 'lucide-react'
import {
  seedChartOfAccounts, getAccounts, createAccount,
  getProfitAndLoss, getBalanceSheet, getCashFlow,
  getExecutiveSummary,
  getTrialBalance, getReceivablesAging, getPayablesAging,
  getJournalEntries, createManualJournal, voidJournalEntry,
} from '@/app/actions/financials'
import Modal from '@/components/Modal'

const fmt = (v) => `₹${Math.abs(v || 0).toLocaleString('en-IN')}`
const fmtSigned = (v) => {
  const n = v || 0
  return n < 0 ? `-₹${Math.abs(n).toLocaleString('en-IN')}` : `₹${n.toLocaleString('en-IN')}`
}
const fmtPct = (v) => `${(v || 0).toFixed(1)}%`
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN') : '—'

const TYPE_COLORS = {
  ASSET: 'bg-blue-500/10 text-blue-400',
  LIABILITY: 'bg-red-500/10 text-red-400',
  INCOME: 'bg-emerald-500/10 text-emerald-400',
  EXPENSE: 'bg-amber-500/10 text-amber-400',
  EQUITY: 'bg-purple-500/10 text-purple-400',
}

const AGING_COLORS = {
  current: 'text-emerald-400',
  days30: 'text-yellow-400',
  days60: 'text-amber-400',
  days90: 'text-orange-400',
  over90: 'text-red-400',
}

export default function FinancialsPage() {
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState([])
  const [journals, setJournals] = useState([])
  const printRef = useRef(null)

  // Date state
  const now = new Date()
  const fyStart = now.getMonth() >= 3
    ? `${now.getFullYear()}-04-01`
    : `${now.getFullYear() - 1}-04-01`
  const today = now.toISOString().split('T')[0]
  const [fromDate, setFromDate] = useState(fyStart)
  const [toDate, setToDate] = useState(today)
  const [asOfDate, setAsOfDate] = useState(today)
  const [compareEnabled, setCompareEnabled] = useState(false)
  const prevFyStart = now.getMonth() >= 3
    ? `${now.getFullYear() - 1}-04-01`
    : `${now.getFullYear() - 2}-04-01`
  const prevFyEnd = now.getMonth() >= 3
    ? `${now.getFullYear()}-03-31`
    : `${now.getFullYear() - 1}-03-31`
  const [compareFrom, setCompareFrom] = useState(prevFyStart)
  const [compareTo, setCompareTo] = useState(prevFyEnd)

  // Report data
  const [pnlData, setPnlData] = useState(null)
  const [bsData, setBsData] = useState(null)
  const [cfData, setCfData] = useState(null)
  const [execData, setExecData] = useState(null)
  const [tbData, setTbData] = useState(null)
  const [recAging, setRecAging] = useState(null)
  const [payAging, setPayAging] = useState(null)
  // Per-section loading states (prevents race conditions when overview loads multiple at once)
  const [pnlLoading, setPnlLoading] = useState(false)
  const [bsLoading, setBsLoading] = useState(false)
  const [cfLoading, setCfLoading] = useState(false)
  const [tbLoading, setTbLoading] = useState(false)
  const [agingLoading, setAgingLoading] = useState(false)
  const [execLoading, setExecLoading] = useState(false)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const reportLoading = pnlLoading || bsLoading || cfLoading || tbLoading || agingLoading || execLoading

  // Journal state
  const [showJournalModal, setShowJournalModal] = useState(false)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [expandedJournal, setExpandedJournal] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [jrnFilter, setJrnFilter] = useState({ from: fyStart, to: today })
  const [journalForm, setJournalForm] = useState({
    date: today, narration: '',
    lines: [
      { accountId: '', debit: 0, credit: 0, description: '' },
      { accountId: '', debit: 0, credit: 0, description: '' },
    ],
  })
  const [accountForm, setAccountForm] = useState({ code: '', name: '', groupId: '', openingBalance: 0 })

  // Aging sub-tab state (must be at top level — Rules of Hooks)
  const [agingTab, setAgingTab] = useState('receivables')
  const [expandedBucket, setExpandedBucket] = useState(null)

  const allAccounts = accounts.flatMap(g =>
    g.accounts?.map(a => ({ ...a, groupName: g.name, groupType: g.type })) || []
  )

  const jrnDebitTotal = journalForm.lines.reduce((s, l) => s + Number(l.debit || 0), 0)
  const jrnCreditTotal = journalForm.lines.reduce((s, l) => s + Number(l.credit || 0), 0)
  const jrnBalanced = Math.abs(jrnDebitTotal - jrnCreditTotal) <= 1

  const loadBase = useCallback((from, to) => {
    setLoading(true)
    Promise.all([getAccounts(), getJournalEntries(from, to)]).then(([accRes, jrnRes]) => {
      if (accRes.success) setAccounts(accRes.data)
      if (jrnRes.success) setJournals(jrnRes.data)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void seedChartOfAccounts().then(() => loadBase(fyStart, today))
    }, 0)
    return () => clearTimeout(timer)
  }, [loadBase, fyStart, today])

  // ── Report fetchers ────────────────────────────────

  const fetchPnL = useCallback(async (silent = false) => {
    setPnlLoading(true)
    const res = await getProfitAndLoss(fromDate, toDate, compareEnabled ? compareFrom : undefined, compareEnabled ? compareTo : undefined)
    if (res.success) setPnlData(res.data)
    else if (!silent) alert(res.error)
    setPnlLoading(false)
  }, [fromDate, toDate, compareEnabled, compareFrom, compareTo])

  const fetchBS = useCallback(async (silent = false) => {
    setBsLoading(true)
    const res = await getBalanceSheet(asOfDate)
    if (res.success) setBsData(res.data)
    else if (!silent) alert(res.error)
    setBsLoading(false)
  }, [asOfDate])

  const fetchCF = useCallback(async (silent = false) => {
    setCfLoading(true)
    const res = await getCashFlow(fromDate, toDate)
    if (res.success) setCfData(res.data)
    else if (!silent) alert(res.error)
    setCfLoading(false)
  }, [fromDate, toDate])

  const fetchExecutive = useCallback(async (silent = false) => {
    setExecLoading(true)
    const res = await getExecutiveSummary(fromDate, toDate)
    if (res.success) setExecData(res.data)
    else if (!silent) alert(res.error)
    setExecLoading(false)
  }, [fromDate, toDate])

  const fetchTB = useCallback(async (silent = false) => {
    setTbLoading(true)
    const res = await getTrialBalance(asOfDate)
    if (res.success) setTbData(res.data)
    else if (!silent) alert(res.error)
    setTbLoading(false)
  }, [asOfDate])

  const fetchAging = useCallback(async (silent = false) => {
    setAgingLoading(true)
    const [recRes, payRes] = await Promise.all([getReceivablesAging(), getPayablesAging()])
    if (recRes.success) setRecAging(recRes.data)
    else if (!silent) alert(recRes.error)
    if (payRes.success) setPayAging(payRes.data)
    setAgingLoading(false)
  }, [])

  const fetchJournals = useCallback(async () => {
    const res = await getJournalEntries(jrnFilter.from, jrnFilter.to)
    if (res.success) setJournals(res.data)
  }, [jrnFilter.from, jrnFilter.to])

  // Auto-load when switching tabs
  useEffect(() => {
    const timer = setTimeout(() => {
      // Overview: auto-load P&L and Balance Sheet for the summary cards
      if (tab === 'overview') {
        if (!pnlData) void fetchPnL(true)
        if (!bsData) void fetchBS(true)
        if (!recAging) void fetchAging(true)
      }
      if (tab === 'aging' && !recAging) void fetchAging(true)
      if (tab === 'trialbalance' && !tbData) void fetchTB(true)
      if (tab === 'executive' && !execData) void fetchExecutive(true)
      if (tab === 'pnl' && !pnlData) void fetchPnL(true)
      if (tab === 'bs' && !bsData) void fetchBS(true)
      if (tab === 'cf' && !cfData) void fetchCF(true)
    }, 0)

    return () => clearTimeout(timer)
  }, [tab, recAging, tbData, execData, pnlData, bsData, cfData, fetchAging, fetchTB, fetchExecutive, fetchPnL, fetchBS, fetchCF])

  // ── Journal actions ────────────────────────────────

  const handleCreateJournal = async () => {
    setSubmitting(true)
    const lines = journalForm.lines
      .filter(l => l.accountId)
      .map(l => ({ accountId: Number(l.accountId), debit: Number(l.debit), credit: Number(l.credit), description: l.description }))
    const res = await createManualJournal({ date: journalForm.date, narration: journalForm.narration, lines })
    if (res.success) {
      setShowJournalModal(false)
      setJournalForm({ date: today, narration: '', lines: [{ accountId: '', debit: 0, credit: 0, description: '' }, { accountId: '', debit: 0, credit: 0, description: '' }] })
      fetchJournals()
    } else alert(res.error)
    setSubmitting(false)
  }

  const handleVoidJournal = async (id) => {
    if (!confirm('Void this journal entry? This cannot be undone.')) return
    const res = await voidJournalEntry(id)
    if (res.success) fetchJournals()
    else alert(res.error)
  }

  const handleCreateAccount = async () => {
    setSubmitting(true)
    const res = await createAccount({ ...accountForm, groupId: Number(accountForm.groupId), openingBalance: Number(accountForm.openingBalance || 0) })
    if (res.success) {
      setShowAccountModal(false)
      setAccountForm({ code: '', name: '', groupId: '', openingBalance: 0 })
      loadBase(jrnFilter.from, jrnFilter.to)
    } else alert(res.error)
    setSubmitting(false)
  }

  const handlePrint = () => {
    if (!printRef.current) return
    const w = window.open('', '_blank', 'width=900,height=700')
    w.document.write(`<html><head><title>Financial Report</title><style>
      body{font-family:Arial,sans-serif;font-size:12px;color:#111;padding:24px}
      h2,h3{margin:8px 0}table{width:100%;border-collapse:collapse;margin:8px 0}
      td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}
      th{font-weight:600;background:#f5f5f5}.right{text-align:right}
      .total{font-weight:700;border-top:2px solid #111}.green{color:#16a34a}.red{color:#dc2626}
    </style></head><body>${printRef.current.innerHTML}</body></html>`)
    w.document.close()
    w.print()
  }

  const tabs = [
    { id: 'overview', label: 'Overview', icon: BarChart3 },
    { id: 'executive', label: 'Executive Summary', icon: TrendingUp },
    { id: 'pnl', label: 'P&L', icon: TrendingUp },
    { id: 'bs', label: 'Balance Sheet', icon: FileText },
    { id: 'cf', label: 'Cash Flow', icon: RefreshCw },
    { id: 'trialbalance', label: 'Trial Balance', icon: BookOpen },
    { id: 'aging', label: 'Aging', icon: AlertCircle },
    { id: 'coa', label: 'Chart of Accounts', icon: BookOpen },
    { id: 'journals', label: 'Journal Entries', icon: FileText },
  ]

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>

  // ── OVERVIEW ──────────────────────────────────────
  const renderOverview = () => (
    <div className="space-y-6">
      {/* Header row with Refresh button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Key financial indicators for the current financial year</p>
        <button
          onClick={async () => {
            setOverviewLoading(true)
            await Promise.all([fetchPnL(true), fetchBS(true), fetchAging(true)])
            setOverviewLoading(false)
          }}
          disabled={overviewLoading}
          className="px-3 py-1.5 bg-surface border border-border text-xs text-muted rounded-lg hover:text-foreground hover:bg-surface-hover flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${overviewLoading ? 'animate-spin' : ''}`} /> Refresh Overview
        </button>
      </div>
      {(overviewLoading || pnlLoading || bsLoading || agingLoading) && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <div className="animate-spin rounded-full h-3 w-3 border-b border-accent" />
          Loading financial data...
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Accounts Receivable', value: bsData?.currentAssets?.accountsReceivable, color: 'text-amber-400', action: () => { setTab('aging') } },
          { label: 'Cash & Bank', value: bsData?.currentAssets?.cashAndBank, color: 'text-emerald-400', action: () => { setTab('bs'); fetchBS() } },
          { label: 'Inventory Value', value: bsData?.currentAssets?.inventory, color: 'text-blue-400', action: null },
          { label: 'Net GST Payable', value: bsData?.currentLiabilities?.netGSTPayable, color: 'text-red-400', action: null },
        ].map((k, i) => (
          <div key={i} onClick={k.action || undefined} className={`glass-card p-4 ${k.action ? 'cursor-pointer hover:bg-surface-hover' : ''}`}>
            <p className="text-xs text-muted mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{k.value !== undefined ? fmt(k.value) : '—'}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: 'Gross Profit Margin', value: pnlData?.current?.grossMarginPct, suffix: '%', color: 'text-blue-400' },
          { label: 'Net Profit Margin', value: pnlData?.current?.netMarginPct, suffix: '%', color: 'text-emerald-400' },
          { label: 'Net Profit', value: pnlData?.current?.netProfit, suffix: '', color: pnlData?.current?.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400', isCurrency: true },
        ].map((k, i) => (
          <div key={i} className="glass-card p-4">
            <p className="text-xs text-muted mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>
              {k.value !== undefined ? (k.isCurrency ? fmtSigned(k.value) : `${k.value.toFixed(1)}%`) : '—'}
            </p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass-card p-4">
          <p className="text-xs text-muted mb-1">Receivables 90+ Risk</p>
          <p className={`text-xl font-bold ${(recAging?.risk?.over90SharePct || 0) > 25 ? 'text-red-400' : 'text-amber-400'}`}>
            {recAging?.risk ? fmtPct(recAging.risk.over90SharePct) : '—'}
          </p>
          <p className="text-xs text-muted mt-1">Share of receivables older than 90 days</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted mb-1">Payables 90+ Risk</p>
          <p className={`text-xl font-bold ${(payAging?.risk?.over90SharePct || 0) > 25 ? 'text-red-400' : 'text-amber-400'}`}>
            {payAging?.risk ? fmtPct(payAging.risk.over90SharePct) : '—'}
          </p>
          <p className="text-xs text-muted mt-1">Share of payables older than 90 days</p>
        </div>
        <div className="glass-card p-4">
          <p className="text-xs text-muted mb-1">Cashflow Data Confidence</p>
          <p className={`text-xl font-bold ${(cfData?.quality?.purchasePayments?.fallbackAmount || 0) > 0 ? 'text-yellow-400' : 'text-emerald-400'}`}>
            {cfData ? ((cfData.quality?.purchasePayments?.paymentRows || 0) > 0 ? 'High' : 'Low') : '—'}
          </p>
          <p className="text-xs text-muted mt-1">Supplier payments captured as event rows</p>
        </div>
      </div>
      <div className="glass-card p-4 space-y-2">
        <p className="text-sm font-medium text-foreground mb-3">Quick Actions</p>
        <div className="flex gap-3 flex-wrap">
          {[
            { label: 'Generate P&L', action: () => { setTab('pnl'); setTimeout(fetchPnL, 100) } },
            { label: 'Balance Sheet', action: () => { setTab('bs'); setTimeout(fetchBS, 100) } },
            { label: 'Trial Balance', action: () => { setTab('trialbalance'); setTimeout(fetchTB, 100) } },
            { label: 'Receivables Aging', action: () => { setTab('aging'); setTimeout(fetchAging, 100) } },
          ].map(a => (
            <button key={a.label} onClick={a.action} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-accent hover:text-white hover:border-accent transition-all">
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  // ── P&L ───────────────────────────────────────────
  const renderPnL = () => {
    const cur = pnlData?.current
    const cmp = pnlData?.compare

    const PnLRow = ({ label, cur: c, cmp: m, bold, indent, positive }) => (
      <div className={`flex justify-between items-center py-1.5 text-sm ${bold ? 'font-semibold border-t border-border mt-1 pt-2' : ''}`}>
        <span className={`${indent ? 'pl-4 text-muted' : 'text-foreground'}`}>{label}</span>
        <div className="flex items-center gap-8">
          {cmp && m !== undefined && <span className="text-muted text-right w-28">{fmtSigned(m)}</span>}
          <span className={`text-right w-32 ${bold ? (c >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-foreground'}`}>
            {fmtSigned(c)}
          </span>
          {cmp && c !== undefined && m !== undefined && (
            <span className={`text-xs w-16 text-right ${c > m ? 'text-emerald-400' : c < m ? 'text-red-400' : 'text-muted'}`}>
              {m !== 0 ? `${((c - m) / Math.abs(m) * 100).toFixed(1)}%` : '—'}
            </span>
          )}
        </div>
      </div>
    )

    return (
      <div className="space-y-4">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="text-xs text-muted mb-1 block">From</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">To</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
            <input type="checkbox" checked={compareEnabled} onChange={e => setCompareEnabled(e.target.checked)} />
            Compare period
          </label>
          {compareEnabled && (
            <>
              <div>
                <label className="text-xs text-muted mb-1 block">Compare From</label>
                <input type="date" value={compareFrom} onChange={e => setCompareFrom(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Compare To</label>
                <input type="date" value={compareTo} onChange={e => setCompareTo(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
              </div>
            </>
          )}
          <button onClick={fetchPnL} disabled={pnlLoading} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
            {pnlLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />} Generate
          </button>
          {cur && <button onClick={handlePrint} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-surface-hover flex items-center gap-2"><Printer className="w-4 h-4" /> Print</button>}
        </div>

        {cur && (
          <div ref={printRef} className="glass-card p-6 space-y-5">
            <div className="text-center border-b border-border pb-4">
              <h3 className="text-lg font-bold text-foreground">Profit & Loss Statement</h3>
              <p className="text-sm text-muted">{cur.period?.from} to {cur.period?.to}</p>
              {cmp && <p className="text-xs text-muted mt-1">Comparison: {cmp.period?.from} to {cmp.period?.to}</p>}
            </div>

            {/* Header row for comparison */}
            {cmp && (
              <div className="flex justify-end gap-8 text-xs font-semibold text-muted border-b border-border pb-2">
                <span className="w-28 text-right">Previous Period</span>
                <span className="w-32 text-right">Current Period</span>
                <span className="w-16 text-right">Change</span>
              </div>
            )}

            {/* Revenue */}
            <div>
              <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-2">Revenue</h4>
              <PnLRow label="Gross Sales (incl. GST)" cur={cur.revenue?.grossSales} cmp={cmp?.revenue?.grossSales} indent />
              <PnLRow label="Less: Sales GST" cur={-(cur.revenue?.salesGST || 0)} cmp={cmp ? -(cmp.revenue?.salesGST || 0) : undefined} indent />
              <PnLRow label="Less: Returns / Credit Notes" cur={-(cur.revenue?.returns || 0)} cmp={cmp ? -(cmp.revenue?.returns || 0) : undefined} indent />
              <PnLRow label="Net Revenue (Ex-GST)" cur={cur.revenue?.netRevenue} cmp={cmp?.revenue?.netRevenue} bold />
            </div>

            {/* COGS */}
            <div>
              <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-2">Cost of Goods Sold</h4>
              <PnLRow label="COGS (cost price of items sold)" cur={cur.cogs?.total} cmp={cmp?.cogs?.total} indent />
              <PnLRow label={`Gross Profit (${fmtPct(cur.grossMarginPct)} margin)`} cur={cur.grossProfit} cmp={cmp?.grossProfit} bold />
            </div>

            {/* Operating Expenses */}
            <div>
              <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-2">Operating Expenses</h4>
              <PnLRow label="Gross Salary (employee cost)" cur={cur.operatingExpenses?.salary} cmp={cmp?.operatingExpenses?.salary} indent />
              <PnLRow label="Employer PF / ESI / Bonus" cur={cur.operatingExpenses?.employerPFESI} cmp={cmp?.operatingExpenses?.employerPFESI} indent />
              {(cur.operatingExpenses?.expenseLines || []).map(line => (
                <PnLRow key={line.category} label={line.category} cur={line.amount} cmp={cmp?.operatingExpenses?.expenseLines?.find(other => other.category === line.category)?.amount} indent />
              ))}
              <PnLRow label="Total Operating Expenses" cur={cur.operatingExpenses?.total} cmp={cmp?.operatingExpenses?.total} bold />
            </div>

            {/* Summary */}
            <div className="bg-surface-hover rounded-lg p-4 space-y-2">
              <PnLRow label={`Operating Profit (${fmtPct(cur.opMarginPct)} margin)`} cur={cur.operatingProfit} cmp={cmp?.operatingProfit} bold />
              <div className="flex justify-between items-center pt-2 border-t-2 border-border">
                <span className="text-lg font-bold text-foreground">Net Profit / (Loss)</span>
                <div className="flex items-center gap-2">
                  {cur.netProfit >= 0 ? <TrendingUp className="w-5 h-5 text-emerald-400" /> : <TrendingDown className="w-5 h-5 text-red-400" />}
                  <span className={`text-2xl font-bold ${cur.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(cur.netProfit)}</span>
                </div>
              </div>
              <p className="text-xs text-muted">Net Margin: {fmtPct(cur.netMarginPct)} · Invoices: {cur.invoiceCount} · Returns: {cur.returnCount}</p>
            </div>

            {/* Purchase reference */}
            <div className="text-xs text-muted border-t border-border pt-3">
              <span className="font-medium text-foreground">For Reference — </span>
              Purchases received in period (ex-GST): {fmt(cur.purchases?.total)} | GST on purchases: {fmt(cur.purchases?.gst)}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── BALANCE SHEET ─────────────────────────────────
  const renderBS = () => (
    <div className="space-y-4">
      <div className="flex items-end gap-4 flex-wrap">
        <div>
          <label className="text-xs text-muted mb-1 block">As of Date</label>
          <input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <button onClick={fetchBS} disabled={bsLoading} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
          {bsLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />} Generate
        </button>
        {bsData && <button onClick={handlePrint} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-surface-hover flex items-center gap-2"><Printer className="w-4 h-4" /> Print</button>}
      </div>
      {bsData && (
        <div ref={printRef} className="glass-card p-6">
          <div className="text-center border-b border-border pb-4 mb-5">
            <h3 className="text-lg font-bold text-foreground">Balance Sheet</h3>
            <p className="text-sm text-muted">As of {bsData.asOfDate}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Assets */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-3">Assets</h4>
              <p className="text-xs font-semibold text-foreground mb-1">Current Assets</p>
              {[
                { label: 'Cash & Bank', val: bsData.currentAssets?.cashAndBank },
                { label: 'Accounts Receivable', val: bsData.currentAssets?.accountsReceivable },
                { label: 'Closing Stock / Inventory', val: bsData.currentAssets?.inventory },
                { label: 'GST Input Credit (ITC)', val: bsData.currentAssets?.itcReceivable },
                { label: 'Staff Loans Outstanding', val: bsData.currentAssets?.staffLoans },
              ].map(r => (
                <div key={r.label} className="flex justify-between text-sm">
                  <span className="text-muted pl-3">{r.label}</span>
                  <span className="text-foreground">{fmt(r.val)}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-bold border-t border-border pt-2 mt-1">
                <span className="text-foreground">Total Assets</span>
                <span className="text-accent text-base">{fmt(bsData.totalAssets)}</span>
              </div>
            </div>

            {/* Liabilities + Equity */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-3">Liabilities & Equity</h4>
              <p className="text-xs font-semibold text-foreground mb-1">Current Liabilities</p>
              {[
                { label: 'Accounts Payable (Suppliers)', val: bsData.currentLiabilities?.accountsPayable },
                { label: `GST Payable (Output: ${fmt(bsData.currentLiabilities?.gstOutput)} − ITC: ${fmt(bsData.currentLiabilities?.gstInput)})`, val: bsData.currentLiabilities?.netGSTPayable },
                { label: 'Salary Payable (approved, unpaid)', val: bsData.currentLiabilities?.salaryPayable },
              ].map(r => (
                <div key={r.label} className="flex justify-between text-sm">
                  <span className="text-muted pl-3 max-w-[220px]">{r.label}</span>
                  <span className="text-foreground">{fmt(r.val)}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-semibold border-t border-border pt-2 mt-1">
                <span className="text-foreground">Total Liabilities</span>
                <span className="text-red-400">{fmt(bsData.currentLiabilities?.total)}</span>
              </div>

              <p className="text-xs font-semibold text-foreground mt-4 mb-1">Equity</p>
              <div className="flex justify-between text-sm font-bold">
                <span className="text-foreground">Net Equity (Assets − Liabilities)</span>
                <span className="text-emerald-400">{fmtSigned(bsData.equity?.derived)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold border-t border-border pt-2 mt-1">
                <span className="text-foreground">Total Liabilities + Equity</span>
                <span className="text-accent text-base">{fmt(bsData.totalAssets)}</span>
              </div>
              <p className="text-xs text-muted mt-2">{bsData.equity?.note}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  // ── CASH FLOW ─────────────────────────────────────
  const renderCF = () => (
    <div className="space-y-4">
      <div className="flex items-end gap-4 flex-wrap">
        <div>
          <label className="text-xs text-muted mb-1 block">From</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <div>
          <label className="text-xs text-muted mb-1 block">To</label>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <button onClick={fetchCF} disabled={cfLoading} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
          {cfLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />} Generate
        </button>
        {cfData && <button onClick={handlePrint} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-surface-hover flex items-center gap-2"><Printer className="w-4 h-4" /> Print</button>}
      </div>
      {cfData && (
        <div ref={printRef} className="glass-card p-6 space-y-5">
          <div className="text-center border-b border-border pb-4">
            <h3 className="text-lg font-bold text-foreground">Cash Flow Statement</h3>
            <p className="text-sm text-muted">{cfData.period?.from} to {cfData.period?.to}</p>
          </div>

          {/* Operating */}
          <div>
            <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-3">A. Operating Activities</h4>
            <div className="space-y-1.5">
              {[
                { label: 'Collections from Customers', val: cfData.operating?.inflow?.salesCollections, positive: true },
                { label: 'Staff Loan Repayments Received', val: cfData.operating?.inflow?.loanRepayments, positive: true },
                { label: 'Payments to Suppliers', val: -cfData.operating?.outflow?.purchases, positive: false },
                { label: 'Salary Payments', val: -cfData.operating?.outflow?.salaries, positive: false },
                { label: 'Credit Note Refunds', val: -cfData.operating?.outflow?.creditRefunds, positive: false },
              ].map(r => (
                <div key={r.label} className="flex justify-between text-sm">
                  <span className="text-muted pl-3">{r.label}</span>
                  <span className={r.val >= 0 ? 'text-emerald-400' : 'text-red-400'}>{r.val >= 0 ? '+' : ''}{fmtSigned(r.val)}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm font-bold border-t border-border pt-2">
                <span className="text-foreground">Net Operating Cash Flow</span>
                <span className={cfData.operating?.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtSigned(cfData.operating?.net)}</span>
              </div>
            </div>
          </div>

          {/* Investing & Financing */}
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'B. Investing Activities', val: cfData.investing?.net, note: cfData.investing?.note },
              { label: 'C. Financing Activities', val: cfData.financing?.net, note: cfData.financing?.note },
            ].map(s => (
              <div key={s.label} className="bg-surface-hover p-4 rounded-lg">
                <p className="text-xs font-bold text-muted uppercase mb-2">{s.label}</p>
                <p className="text-lg font-bold text-foreground">{fmtSigned(s.val)}</p>
                {s.note && <p className="text-xs text-muted mt-1">{s.note}</p>}
              </div>
            ))}
          </div>

          <div className="bg-surface-hover p-4 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-lg font-bold text-foreground">Net Cash Flow (A+B+C)</span>
              <span className={`text-2xl font-bold ${cfData.netCashFlow >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(cfData.netCashFlow)}</span>
            </div>
          </div>

          {cfData.quality?.purchasePayments && (
            <div className="text-xs text-muted border-t border-border pt-3 space-y-1">
              <p>
                Supplier payout events: {fmt(cfData.quality.purchasePayments.eventBasedAmount)} across
                {` `}{cfData.quality.purchasePayments.paymentRows} payment rows.
              </p>
              <p>{cfData.quality.purchasePayments.note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )

  const renderExecutive = () => (
    <div className="space-y-4">
      <div className="flex items-end gap-4 flex-wrap">
        <div>
          <label className="text-xs text-muted mb-1 block">From</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <div>
          <label className="text-xs text-muted mb-1 block">To</label>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <button onClick={fetchExecutive} disabled={execLoading} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
          {execLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />} Generate
        </button>
      </div>

      {execData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="glass-card p-4"><p className="text-xs text-muted">Current Ratio</p><p className="text-xl font-bold text-blue-400">{execData.liquidity.currentRatio !== null ? execData.liquidity.currentRatio.toFixed(2) : '—'}</p></div>
            <div className="glass-card p-4"><p className="text-xs text-muted">DSO</p><p className="text-xl font-bold text-amber-400">{execData.cycle.dso !== null ? `${execData.cycle.dso.toFixed(1)}d` : '—'}</p></div>
            <div className="glass-card p-4"><p className="text-xs text-muted">DPO</p><p className="text-xl font-bold text-purple-400">{execData.cycle.dpo !== null ? `${execData.cycle.dpo.toFixed(1)}d` : '—'}</p></div>
            <div className="glass-card p-4"><p className="text-xs text-muted">Cash Runway</p><p className="text-xl font-bold text-emerald-400">{execData.liquidity.cashRunwayDays !== null ? `${execData.liquidity.cashRunwayDays.toFixed(1)}d` : '—'}</p></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="glass-card p-4"><p className="text-xs text-muted">Net Profit</p><p className={`text-xl font-bold ${(execData.performance.netProfit || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSigned(execData.performance.netProfit)}</p></div>
            <div className="glass-card p-4"><p className="text-xs text-muted">Net Margin Change</p><p className={`text-xl font-bold ${(execData.performance.netMarginDeltaPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(execData.performance.netMarginDeltaPct || 0).toFixed(1)}pp</p></div>
            <div className="glass-card p-4"><p className="text-xs text-muted">Gross Margin Change</p><p className={`text-xl font-bold ${(execData.performance.grossMarginDeltaPct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(execData.performance.grossMarginDeltaPct || 0).toFixed(1)}pp</p></div>
          </div>

          <div className="glass-card p-4">
            <p className="text-sm font-medium text-foreground mb-2">Period Alerts</p>
            {execData.alerts?.length ? (
              <ul className="space-y-1 text-sm text-amber-300">
                {execData.alerts.map((a, idx) => <li key={idx}>• {a}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-emerald-400">No major anomalies detected in this period.</p>
            )}
            <p className="text-xs text-muted mt-2">{execData.benchmarkNote}</p>
          </div>
        </div>
      )}
    </div>
  )

  // ── TRIAL BALANCE ─────────────────────────────────
  const renderTrialBalance = () => (
    <div className="space-y-4">
      <div className="flex items-end gap-4 flex-wrap">
        <div>
          <label className="text-xs text-muted mb-1 block">As of Date</label>
          <input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <button onClick={fetchTB} disabled={tbLoading} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2">
          {tbLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />} Generate
        </button>
        {tbData && <button onClick={handlePrint} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-surface-hover flex items-center gap-2"><Printer className="w-4 h-4" /> Print</button>}
      </div>
      {tbData && (
        <div ref={printRef} className="glass-card overflow-hidden">
          <div className="px-5 py-4 border-b border-border text-center">
            <h3 className="text-lg font-bold text-foreground">Trial Balance</h3>
            <p className="text-sm text-muted">As of {tbData.asOfDate}</p>
          </div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-surface">
              {['Code', 'Account Name', 'Type', 'Debit', 'Credit'].map(h =>
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {tbData.lines?.map((l, i) => (
                <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                  <td className="px-4 py-3 font-mono text-muted">{l.code}</td>
                  <td className="px-4 py-3 text-foreground">{l.name}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs ${TYPE_COLORS[l.type] || ''}`}>{l.type}</span></td>
                  <td className="px-4 py-3 text-emerald-400">{l.debit > 0 ? fmt(l.debit) : '—'}</td>
                  <td className="px-4 py-3 text-red-400">{l.credit > 0 ? fmt(l.credit) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-hover font-bold">
                <td colSpan={3} className="px-4 py-3 text-foreground">TOTAL</td>
                <td className="px-4 py-3 text-emerald-400">{fmt(tbData.totalDebit)}</td>
                <td className="px-4 py-3 text-red-400">{fmt(tbData.totalCredit)}</td>
              </tr>
              <tr className="bg-surface">
                <td colSpan={5} className="px-4 py-2">
                  <span className={`flex items-center gap-2 text-sm ${Math.abs(tbData.totalDebit - tbData.totalCredit) <= 1 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {Math.abs(tbData.totalDebit - tbData.totalCredit) <= 1
                      ? <><CheckCircle className="w-4 h-4" /> Trial Balance is balanced</>
                      : <><XCircle className="w-4 h-4" /> Difference: {fmt(Math.abs(tbData.totalDebit - tbData.totalCredit))}</>
                    }
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )

  // ── AGING ─────────────────────────────────────────
  const renderAging = () => {
    const data = agingTab === 'receivables' ? recAging : payAging

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex gap-2">
            {[
              { id: 'receivables', label: 'Receivables', icon: Users },
              { id: 'payables', label: 'Payables', icon: ShoppingCart },
            ].map(t => (
              <button key={t.id} onClick={() => setAgingTab(t.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all ${agingTab === t.id ? 'bg-accent text-white' : 'bg-surface border border-border text-muted hover:text-foreground'}`}>
                <t.icon className="w-4 h-4" /> {t.label}
              </button>
            ))}
          </div>
          <button onClick={fetchAging} disabled={agingLoading} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-surface-hover flex items-center gap-2">
            {agingLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh
          </button>
        </div>

        {data && (
          <>
            {data.risk && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="glass-card p-3">
                  <p className="text-xs text-muted">90+ Days Amount</p>
                  <p className="text-lg font-bold text-red-400">{fmt(data.risk.over90Amount)}</p>
                </div>
                <div className="glass-card p-3">
                  <p className="text-xs text-muted">90+ Days Share</p>
                  <p className="text-lg font-bold text-amber-400">{fmtPct(data.risk.over90SharePct)}</p>
                </div>
                <div className="glass-card p-3">
                  <p className="text-xs text-muted">Top 5 Concentration</p>
                  <p className="text-lg font-bold text-yellow-400">{fmtPct(data.risk.top5SharePct)}</p>
                </div>
                <div className="glass-card p-3">
                  <p className="text-xs text-muted">Avg Days Past Due</p>
                  <p className="text-lg font-bold text-blue-400">{data.risk.averageDaysPastDue.toFixed(1)}d</p>
                </div>
              </div>
            )}

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {data.summary?.map(b => (
                <div key={b.bucket} onClick={() => setExpandedBucket(expandedBucket === b.bucket ? null : b.bucket)}
                  className="glass-card p-3 cursor-pointer hover:bg-surface-hover transition-colors">
                  <p className="text-xs text-muted">{b.label}</p>
                  <p className={`text-lg font-bold ${AGING_COLORS[b.bucket]}`}>{fmt(b.amount)}</p>
                  <p className="text-xs text-muted">{b.count} {agingTab === 'receivables' ? 'invoices' : 'POs'}</p>
                </div>
              ))}
            </div>

            <div className="glass-card p-3 flex justify-between text-sm">
              <span className="text-muted">Total Outstanding</span>
              <span className="font-bold text-amber-400">{fmt(data.totalOutstanding)} ({data.totalCount} records)</span>
            </div>

            {/* Expanded bucket detail */}
            {expandedBucket && (
              <div className="glass-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <span className="font-medium text-foreground">{data.summary?.find(b => b.bucket === expandedBucket)?.label} — Detail</span>
                  <button onClick={() => setExpandedBucket(null)} className="text-muted hover:text-foreground"><XCircle className="w-4 h-4" /></button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-border bg-surface">
                      {agingTab === 'receivables'
                        ? ['Invoice', 'Date', 'Due Date', 'Customer', 'Phone', 'Total', 'Balance Due', 'Days Past Due'].map(h => <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)
                        : ['PO #', 'Date', 'Expected/Due', 'Supplier', 'Total', 'Balance Due', 'Days Past Due', 'Terms'].map(h => <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)
                      }
                    </tr></thead>
                    <tbody>
                      {agingTab === 'receivables'
                        ? data.summary?.find(b => b.bucket === expandedBucket)?.invoices?.map((inv, i) => (
                          <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                            <td className="px-3 py-2 font-medium text-foreground">{inv.displayId}</td>
                            <td className="px-3 py-2 text-muted">{fmtDate(inv.date)}</td>
                            <td className="px-3 py-2 text-muted">{fmtDate(inv.dueDate || inv.date)}</td>
                            <td className="px-3 py-2 text-foreground">{inv.customer}</td>
                            <td className="px-3 py-2 text-muted">{inv.phone}</td>
                            <td className="px-3 py-2 text-foreground">{fmt(inv.total)}</td>
                            <td className="px-3 py-2 font-semibold text-amber-400">{fmt(inv.balanceDue)}</td>
                            <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${AGING_COLORS[expandedBucket]}`}>{inv.ageDays}d</span></td>
                          </tr>
                        ))
                        : data.summary?.find(b => b.bucket === expandedBucket)?.pos?.map((po, i) => (
                          <tr key={i} className="border-b border-border/50 hover:bg-surface-hover">
                            <td className="px-3 py-2 font-medium text-foreground">{po.displayId}</td>
                            <td className="px-3 py-2 text-muted">{fmtDate(po.date)}</td>
                            <td className="px-3 py-2 text-muted">{fmtDate(po.expectedDate || po.date)}</td>
                            <td className="px-3 py-2 text-foreground">{po.supplier}</td>
                            <td className="px-3 py-2 text-foreground">{fmt(po.total)}</td>
                            <td className="px-3 py-2 font-semibold text-amber-400">{fmt(po.balanceDue)}</td>
                            <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-xs ${AGING_COLORS[expandedBucket]}`}>{po.ageDays}d</span></td>
                            <td className="px-3 py-2 text-muted">{po.paymentTerms ? `Net ${po.paymentTerms}` : '—'}</td>
                          </tr>
                        ))
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
        {!data && !reportLoading && <div className="text-center py-12 text-muted">Click Refresh to load aging data</div>}
        {reportLoading && <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent" /></div>}
      </div>
    )
  }

  // ── CHART OF ACCOUNTS ─────────────────────────────
  const renderCoA = () => (
    <div className="space-y-4">
      {accounts.map(group => (
        <div key={group.id} className="glass-card p-5">
          <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
            {group.name}
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${TYPE_COLORS[group.type] || ''}`}>{group.type}</span>
          </h3>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border">
              {['Code', 'Account Name', 'Opening Balance', 'Type'].map(h =>
                <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
            </tr></thead>
            <tbody>
              {group.accounts?.map(acc => (
                <tr key={acc.id} className="border-b border-border/50 hover:bg-surface-hover">
                  <td className="px-3 py-2 font-mono text-muted">{acc.code}</td>
                  <td className="px-3 py-2 text-foreground">{acc.name}</td>
                  <td className="px-3 py-2 text-foreground">{fmt(acc.openingBalance)}</td>
                  <td className="px-3 py-2">{acc.isSystemAccount
                    ? <span className="text-xs text-muted">System</span>
                    : <span className="px-2 py-0.5 bg-accent/10 text-accent rounded text-xs">Custom</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {accounts.length === 0 && <div className="text-center py-12 text-muted">Chart of accounts will be auto-created.</div>}
    </div>
  )

  // ── JOURNALS ──────────────────────────────────────
  const renderJournals = () => (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-xs text-muted mb-1 block">From</label>
          <input type="date" value={jrnFilter.from} onChange={e => setJrnFilter(p => ({ ...p, from: e.target.value }))} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <div>
          <label className="text-xs text-muted mb-1 block">To</label>
          <input type="date" value={jrnFilter.to} onChange={e => setJrnFilter(p => ({ ...p, to: e.target.value }))} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
        </div>
        <button onClick={fetchJournals} className="px-4 py-2 bg-surface border border-border text-sm text-foreground rounded-lg hover:bg-surface-hover flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> Filter
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-surface">
            {['JV #', 'Date', 'Narration', 'Type', 'Debit', 'Credit', 'Status', ''].map(h =>
              <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
          </tr></thead>
          <tbody>
            {journals.map(j => (
              <Fragment key={j.id}>
                <tr key={j.id}
                  className={`border-b border-border/50 hover:bg-surface-hover transition-colors cursor-pointer ${j.status === 'VOIDED' ? 'opacity-50' : ''}`}
                  onClick={() => setExpandedJournal(expandedJournal === j.id ? null : j.id)}>
                  <td className="px-4 py-3 font-medium text-foreground">{j.displayId}</td>
                  <td className="px-4 py-3 text-muted">{fmtDate(j.date)}</td>
                  <td className="px-4 py-3 text-foreground max-w-[200px] truncate">{j.narration}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs ${j.referenceType === 'MANUAL' ? 'bg-blue-500/10 text-blue-400' : 'bg-gray-500/10 text-gray-400'}`}>{j.referenceType}</span></td>
                  <td className="px-4 py-3 text-emerald-400">{fmt(j.totalDebit)}</td>
                  <td className="px-4 py-3 text-red-400">{fmt(j.totalCredit)}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs ${j.status === 'VOIDED' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{j.status}</span></td>
                  <td className="px-4 py-3 flex items-center gap-1">
                    {expandedJournal === j.id ? <ChevronUp className="w-4 h-4 text-muted" /> : <ChevronDown className="w-4 h-4 text-muted" />}
                    {j.status !== 'VOIDED' && (
                      <button onClick={e => { e.stopPropagation(); handleVoidJournal(j.id) }}
                        className="ml-1 px-2 py-1 bg-red-500/10 text-red-400 rounded text-xs hover:bg-red-500/20">Void</button>
                    )}
                  </td>
                </tr>
                {expandedJournal === j.id && (
                  <tr key={`${j.id}-detail`} className="bg-surface-hover">
                    <td colSpan={8} className="px-6 py-3">
                      <table className="w-full text-xs">
                        <thead><tr className="text-muted">
                          <th className="text-left py-1 pr-4">Account</th>
                          <th className="text-right py-1 pr-4">Debit</th>
                          <th className="text-right py-1 pr-4">Credit</th>
                          <th className="text-left py-1">Description</th>
                        </tr></thead>
                        <tbody>
                          {j.lines?.map((line, li) => (
                            <tr key={li} className="border-t border-border/30">
                              <td className="py-1 pr-4 font-medium text-foreground">{line.account?.code} — {line.account?.name}</td>
                              <td className="text-right py-1 pr-4 text-emerald-400">{line.debit > 0 ? fmt(line.debit) : '—'}</td>
                              <td className="text-right py-1 pr-4 text-red-400">{line.credit > 0 ? fmt(line.credit) : '—'}</td>
                              <td className="py-1 text-muted">{line.description || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {journals.length === 0 && <div className="text-center py-12 text-muted">No journal entries in this period</div>}
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Financial Statements</h1>
          <p className="text-muted text-sm mt-1">P&L · Balance Sheet · Cash Flow · Trial Balance · Aging · Journals</p>
        </div>
        <div className="flex gap-2">
          {tab === 'journals' && (
            <button onClick={() => setShowJournalModal(true)} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Journal
            </button>
          )}
          {tab === 'coa' && (
            <button onClick={() => setShowAccountModal(true)} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add Account
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-1.5 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && renderOverview()}
      {tab === 'executive' && renderExecutive()}
      {tab === 'pnl' && renderPnL()}
      {tab === 'bs' && renderBS()}
      {tab === 'cf' && renderCF()}
      {tab === 'trialbalance' && renderTrialBalance()}
      {tab === 'aging' && renderAging()}
      {tab === 'coa' && renderCoA()}
      {tab === 'journals' && renderJournals()}

      {/* Create Journal Modal */}
      <Modal isOpen={showJournalModal} onClose={() => setShowJournalModal(false)} title="Create Manual Journal Entry" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">Date *</label>
              <input type="date" value={journalForm.date}
                onChange={e => setJournalForm(p => ({ ...p, date: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Narration *</label>
              <input value={journalForm.narration}
                onChange={e => setJournalForm(p => ({ ...p, narration: e.target.value }))}
                placeholder="e.g. Rent paid for April"
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted">Journal Lines (Debit = Credit)</label>
              <button onClick={() => setJournalForm(f => ({ ...f, lines: [...f.lines, { accountId: '', debit: 0, credit: 0, description: '' }] }))}
                className="text-xs text-accent hover:underline">+ Add Line</button>
            </div>
            {journalForm.lines.map((line, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 mb-2 items-center">
                <select value={line.accountId}
                  onChange={e => { const v = [...journalForm.lines]; v[i] = { ...v[i], accountId: e.target.value }; setJournalForm(f => ({ ...f, lines: v })) }}
                  className="col-span-5 px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground">
                  <option value="">Select Account</option>
                  {allAccounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </select>
                <input type="number" min="0" value={line.debit || ''}
                  onChange={e => { const v = [...journalForm.lines]; v[i] = { ...v[i], debit: e.target.value }; setJournalForm(f => ({ ...f, lines: v })) }}
                  placeholder="Debit" className="col-span-2 px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground text-right" />
                <input type="number" min="0" value={line.credit || ''}
                  onChange={e => { const v = [...journalForm.lines]; v[i] = { ...v[i], credit: e.target.value }; setJournalForm(f => ({ ...f, lines: v })) }}
                  placeholder="Credit" className="col-span-2 px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground text-right" />
                <input value={line.description}
                  onChange={e => { const v = [...journalForm.lines]; v[i] = { ...v[i], description: e.target.value }; setJournalForm(f => ({ ...f, lines: v })) }}
                  placeholder="Desc" className="col-span-2 px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground" />
                <button onClick={() => setJournalForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}
                  className="col-span-1 text-red-400 hover:text-red-300 text-lg leading-none">×</button>
              </div>
            ))}
            <div className={`flex justify-between text-sm mt-3 p-2 rounded-lg ${jrnBalanced ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
              <span className={jrnBalanced ? 'text-emerald-400 flex items-center gap-1' : 'text-red-400 flex items-center gap-1'}>
                {jrnBalanced ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                {jrnBalanced ? 'Balanced' : `Difference: ${fmt(Math.abs(jrnDebitTotal - jrnCreditTotal))}`}
              </span>
              <span className="text-muted text-xs">
                Dr: <span className="text-emerald-400 font-medium">{fmt(jrnDebitTotal)}</span>
                &nbsp;|&nbsp;
                Cr: <span className="text-red-400 font-medium">{fmt(jrnCreditTotal)}</span>
              </span>
            </div>
          </div>

          <button onClick={handleCreateJournal}
            disabled={submitting || !journalForm.narration || !jrnBalanced || !journalForm.lines.some(l => l.accountId)}
            className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Post Journal Entry'}
          </button>
        </div>
      </Modal>

      {/* Add Account Modal */}
      <Modal isOpen={showAccountModal} onClose={() => setShowAccountModal(false)} title="Add Custom Account">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">Account Code *</label>
              <input value={accountForm.code} onChange={e => setAccountForm(p => ({ ...p, code: e.target.value }))}
                placeholder="e.g. 5950" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Account Name *</label>
              <input value={accountForm.name} onChange={e => setAccountForm(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Commission Expense" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Account Group *</label>
            <select value={accountForm.groupId} onChange={e => setAccountForm(p => ({ ...p, groupId: e.target.value }))}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
              <option value="">Select Group</option>
              {accounts.map(g => <option key={g.id} value={g.id}>{g.name} ({g.type})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Opening Balance (₹)</label>
            <input type="number" value={accountForm.openingBalance}
              onChange={e => setAccountForm(p => ({ ...p, openingBalance: e.target.value }))}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
          </div>
          <button onClick={handleCreateAccount}
            disabled={submitting || !accountForm.code || !accountForm.name || !accountForm.groupId}
            className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Account'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
