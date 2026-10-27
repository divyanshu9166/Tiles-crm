/* eslint-disable @next/next/no-img-element */
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, Search, Calendar, Trash2, Download, Filter, MoreHorizontal,
  IndianRupee, TrendingUp, TrendingDown, Wallet, PieChart, BarChart3,
  Receipt, CreditCard, Banknote, ChevronDown, ChevronRight, CheckCircle2,
  XCircle, Clock, AlertTriangle, RefreshCw, Settings2, Edit3,
  X, Eye, Paperclip, Landmark, User, FileText, ShoppingCart, RotateCcw,
  AlertCircle, CheckCheck, Zap
} from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import {
  getDailyPayments,
  createDailyPayment,
  deleteDailyPayment,
  getDailyCashRegister,
  updateOpeningCash,
  reversePayment,
  markChequeBounced,
  reconcilePayments,
  getReconciliationSummary
} from '@/app/actions/payments';
import { istDate, istMonthStart } from '@/lib/local-date';

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'];
const PAYMENT_STATUSES = ['Pending', 'Reconciled', 'Reversed', 'Bounced'];
const PAYMENT_ICONS = { Cash: Banknote, UPI: Wallet, Card: CreditCard, 'Bank Transfer': Landmark, Cheque: FileText };

const formatCurrency = (n) => `₹${(n || 0).toLocaleString('en-IN')}`;

const today = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const todayDateOnly = () => istDate();
const startOfMonth = () => istMonthStart();

export default function PaymentsPage() {
  const alertToast = useAlertToast?.() || { notify: (m) => alert(m) };

  // Tab State
  const [tab, setTab] = useState('today');
  const [loading, setLoading] = useState(true);

  // Data
  const [payments, setPayments] = useState([]);
  const [cashReg, setCashReg] = useState(null);
  const [reconciliationData, setReconciliationData] = useState(null);

  // Filters
  const [searchQ, setSearchQ] = useState('');
  const [filterMode, setFilterMode] = useState('All');
  const [filterType, setFilterType] = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');
  const [dateRange, setDateRange] = useState({ from: startOfMonth(), to: todayDateOnly() });

  // UI State
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receiptUploading, setReceiptUploading] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [selectedPayments, setSelectedPayments] = useState(new Set());
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [showBounceModal, setShowBounceModal] = useState(false);
  const [selectedPaymentForAction, setSelectedPaymentForAction] = useState(null);

  // Cash Register Edit
  const [editingCash, setEditingCash] = useState(false);
  const [openingCashInput, setOpeningCashInput] = useState('');

  // Form State
  const [form, setForm] = useState({
    date: today(),
    amount: '',
    gstAmount: '',
    type: 'IN',
    method: 'UPI',
    reference: '',
    chequeNumber: '',
    chequeDate: '',
    customerName: '',
    notes: '',
    attachment: ''
  });

  const loadData = useCallback(async (from = dateRange.from, to = dateRange.to) => {
    setLoading(true);
    try {
      const [payRes, cashRes, reconRes] = await Promise.all([
        getDailyPayments({ startDate: from, endDate: to, status: filterStatus }),
        getDailyCashRegister(todayDateOnly()),
        getReconciliationSummary({ startDate: from, endDate: to })
      ]);
      if (payRes.success) setPayments(payRes.data);
      if (cashRes.success) setCashReg(cashRes.data);
      if (reconRes.success) setReconciliationData(reconRes.data);
    } finally {
      setLoading(false);
    }
  }, [dateRange.from, dateRange.to, filterStatus]);

  useEffect(() => { loadData(); }, [loadData]);

  // Derived State
  // Derived State
  const filtered = useMemo(() => payments.filter(p => {
    if (filterMode !== 'All' && p.method !== filterMode) return false;
    if (filterType !== 'All' && p.type !== filterType) return false;
    if (filterStatus !== 'All' && p.status !== filterStatus) return false;
    if (searchQ) {
      const q = searchQ.toLowerCase();
      return (
        p.displayId?.toLowerCase().includes(q) ||
        p.reference?.toLowerCase().includes(q) ||
        p.chequeNumber?.toLowerCase().includes(q) ||
        p.notes?.toLowerCase().includes(q) ||
        p.customerName?.toLowerCase().includes(q) ||
        p.contact?.name?.toLowerCase().includes(q)
      );
    }
    return true;
  }), [payments, filterMode, filterType, filterStatus, searchQ]);

  const todayStr = todayDateOnly();
  const todayPayments = useMemo(() => payments.filter(p => p.date && istDate(p.date) === todayStr), [payments, todayStr]);
  const todayIn = todayPayments.filter(p => p.type === 'IN').reduce((s, p) => s + p.amount, 0);
  const todayOut = todayPayments.filter(p => p.type === 'OUT').reduce((s, p) => s + p.amount, 0);

  const totalIn = filtered.filter(p => p.type === 'IN').reduce((s, p) => s + p.amount, 0);
  const totalOut = filtered.filter(p => p.type === 'OUT').reduce((s, p) => s + p.amount, 0);

  // Handlers
  const handleReceiptUpload = async (file) => {
    if (!file) return;
    setReceiptError('');
    setReceiptUploading(true);
    const formData = new FormData();
    formData.set('folder', 'receipts');
    formData.append('file', file);
    try {
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (uploadRes.ok && uploadData?.success && uploadData.urls?.length > 0) {
        setForm(f => ({ ...f, attachment: uploadData.urls[0] }));
      } else {
        setReceiptError(uploadData?.error || 'Receipt upload failed.');
      }
    } catch (err) {
      setReceiptError('Receipt upload failed. Please try again.');
    } finally {
      setReceiptUploading(false);
    }
  };

  const handleAddPayment = async () => {
    if (!form.amount || !form.method || receiptUploading) return;
    setSubmitting(true);
    const res = await createDailyPayment(form);
    if (res.success) {
      setShowAddPayment(false);
      setForm({ date: today(), amount: '', gstAmount: '', type: 'IN', method: 'UPI', reference: '', chequeNumber: '', chequeDate: '', customerName: '', notes: '', attachment: '' });
      await loadData();
      alertToast.notify?.('Payment recorded successfully', 'success');
    } else {
      alertToast.notify?.(res.error || 'Failed to record payment', 'error');
    }
    setSubmitting(false);
  };

  const handleDelete = async (id) => {
    if (!confirm('Are you sure? This payment will be permanently deleted.')) return;
    setDeletingId(id);
    const res = await deleteDailyPayment(id);
    if (res.success) {
      await loadData();
      alertToast.notify?.('Payment deleted', 'success');
    } else {
      alertToast.notify?.(res.error || 'Failed to delete payment', 'error');
    }
    setDeletingId(null);
  };

  // NEW: Handle payment reversal
  const handleReversePayment = async (reason = '') => {
    if (!selectedPaymentForAction) return;
    setSubmitting(true);
    const res = await reversePayment(selectedPaymentForAction.id, reason);
    if (res.success) {
      setShowReverseModal(false);
      setSelectedPaymentForAction(null);
      await loadData();
      alertToast.notify?.('Payment reversed successfully', 'success');
    } else {
      alertToast.notify?.(res.error || 'Failed to reverse payment', 'error');
    }
    setSubmitting(false);
  };

  // NEW: Handle cheque bounce
  const handleMarkChequeBounced = async (reason = '') => {
    if (!selectedPaymentForAction) return;
    setSubmitting(true);
    const res = await markChequeBounced(selectedPaymentForAction.id, reason);
    if (res.success) {
      setShowBounceModal(false);
      setSelectedPaymentForAction(null);
      await loadData();
      alertToast.notify?.('Cheque marked as bounced', 'success');
    } else {
      alertToast.notify?.(res.error || 'Failed to update cheque status', 'error');
    }
    setSubmitting(false);
  };

  // NEW: Handle reconciliation
  const handleReconcile = async () => {
    if (selectedPayments.size === 0) {
      alertToast.notify?.('Please select payments to reconcile', 'error');
      return;
    }
    setSubmitting(true);
    const res = await reconcilePayments(Array.from(selectedPayments));
    if (res.success) {
      setSelectedPayments(new Set());
      setShowReconcileModal(false);
      await loadData();
      alertToast.notify?.(`${res.count} payment(s) reconciled successfully`, 'success');
    } else {
      alertToast.notify?.(res.error || 'Failed to reconcile payments', 'error');
    }
    setSubmitting(false);
  };

  const handleSaveOpeningCash = async () => {
    if (!openingCashInput) return;
    setSubmitting(true);
    const res = await updateOpeningCash(todayStr, openingCashInput);
    if (res.success) {
      setEditingCash(false);
      await loadData();
    }
    setSubmitting(false);
  };

  const handleExportCSV = () => {
    const header = 'Date,ID,Type,Status,Amount,GST,Total,Method,Reference,Customer,Notes\n';
    const rows = filtered.map(p =>
      [
        new Date(p.date).toISOString().split('T')[0],
        p.displayId,
        p.type,
        p.status,
        p.amount,
        p.gstAmount || 0,
        p.amount + (p.gstAmount || 0),
        p.method,
        `"${p.reference || ''}"`,
        `"${p.customerName || p.contact?.name || ''}"`,
        `"${p.notes || ''}"`
      ].join(',')
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments_${dateRange.from}_to_${dateRange.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Render
  if (loading) {
    return (
      <div className="space-y-6 animate-pulse p-4">
        <div className="h-8 w-64 bg-surface rounded-lg" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-surface rounded-2xl" />)}</div>
        <div className="h-96 bg-surface rounded-2xl" />
      </div>
    );
  }

  const tabs = [
    { key: 'today', label: "Today's Register", icon: Calendar },
    { key: 'all', label: 'All Payments', icon: Receipt },
    { key: 'reconcile', label: 'Reconciliation', icon: CheckCheck },
    { key: 'analytics', label: 'Analytics', icon: PieChart },
    { key: 'cash', label: 'Cash Register', icon: Banknote },
  ];

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Daily Payment Register</h1>
          <p className="text-xs md:text-sm text-muted mt-1">
            Track daily cash flow, UPI, cards and bank transfers
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportCSV}
            className="flex items-center gap-2 px-3 py-2 bg-surface border border-border hover:border-accent/30 text-foreground rounded-xl text-sm font-medium transition-all">
            <Download className="w-4 h-4" /> Export
          </button>
          <button onClick={() => setShowAddPayment(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
            <Plus className="w-4 h-4" /> Record Payment
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card p-4 flex flex-col gap-2 relative overflow-hidden">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-green-500/10 rounded-full blur-xl pointer-events-none" />
          <p className="text-xs text-muted flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-green-500" /> Total In</p>
          <p className="text-xl font-bold text-green-500">{formatCurrency(totalIn)}</p>
        </div>
        <div className="glass-card p-4 flex flex-col gap-2 relative overflow-hidden">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-red-500/10 rounded-full blur-xl pointer-events-none" />
          <p className="text-xs text-muted flex items-center gap-1.5"><TrendingDown className="w-3.5 h-3.5 text-red-500" /> Total Out</p>
          <p className="text-xl font-bold text-red-500">{formatCurrency(totalOut)}</p>
        </div>
        <div className="glass-card p-4 flex flex-col gap-2 relative overflow-hidden">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-blue-500/10 rounded-full blur-xl pointer-events-none" />
          <p className="text-xs text-muted flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5 text-blue-500" /> UPI Total</p>
          <p className="text-xl font-bold text-foreground">{formatCurrency(filtered.filter(p => p.method === 'UPI' && p.type === 'IN').reduce((s, p) => s + p.amount, 0))}</p>
        </div>
        <div className="glass-card p-4 flex flex-col gap-2 relative overflow-hidden">
          <div className="absolute -right-4 -top-4 w-16 h-16 bg-amber-500/10 rounded-full blur-xl pointer-events-none" />
          <p className="text-xs text-muted flex items-center gap-1.5"><Banknote className="w-3.5 h-3.5 text-amber-500" /> Cash in Hand (Today)</p>
          <p className="text-xl font-bold text-amber-500">{formatCurrency((cashReg?.openingCash || 0) + (cashReg?.cashIn || 0) - (cashReg?.cashOut || 0))}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 w-full">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all border ${tab === t.key ? 'bg-accent text-white border-accent shadow-sm' : 'bg-surface text-muted border-border hover:border-accent/30 hover:text-foreground'}`}>
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          );
        })}
      </div>

      {/* TAB: TODAY */}
      {tab === 'today' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            {/* Today's Payments List */}
            <div className="glass-card overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between bg-surface/50">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted" /> Today&apos;s Activity ({todayPayments.length})
                </h3>
              </div>
              <div className="divide-y divide-border">
                {todayPayments.length === 0 ? (
                  <div className="p-10 text-center text-muted">
                    <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p className="font-medium text-sm">No payments recorded today</p>
                  </div>
                ) : (
                  todayPayments.map(p => {
                    const PayIcon = PAYMENT_ICONS[p.method] || Receipt;
                    const isOut = p.type === 'OUT';
                    return (
                      <div key={p.id} className="flex items-center justify-between p-4 hover:bg-surface transition-colors">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isOut ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-500'}`}>
                            {isOut ? <TrendingDown className="w-5 h-5" /> : <TrendingUp className="w-5 h-5" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">{p.customerName || p.contact?.name || p.notes || 'Unknown'}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="flex items-center gap-1 text-[10px] text-muted bg-background px-1.5 py-0.5 rounded border border-border">
                                <PayIcon className="w-3 h-3" /> {p.method}
                              </span>
                              {p.reference && <span className="text-[10px] text-muted truncate max-w-[150px]">Ref: {p.reference}</span>}
                              {p.invoice && <span className="text-[10px] text-accent">Inv: {p.invoice.displayId}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className={`text-sm font-bold ${isOut ? 'text-red-500' : 'text-green-500'}`}>
                            {isOut ? '-' : '+'}{formatCurrency(p.amount)}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-muted">{new Date(p.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            {p.attachment && (
                              <a href={p.attachment} target="_blank" rel="noreferrer" className="text-muted hover:text-accent ml-1">
                                <Paperclip className="w-3 h-3" />
                              </a>
                            )}
                            <button onClick={() => handleDelete(p.id)} disabled={deletingId === p.id} className="ml-1 text-muted hover:text-red-500 disabled:opacity-50">
                              {deletingId === p.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB: ALL PAYMENTS */}
      {tab === 'all' && (
        <div className="space-y-4">
          <div className="glass-card p-4 space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">From</label>
                <input type="date" value={dateRange.from}
                  onChange={e => setDateRange(d => ({ ...d, from: e.target.value }))}
                  className="px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">To</label>
                <input type="date" value={dateRange.to}
                  onChange={e => setDateRange(d => ({ ...d, to: e.target.value }))}
                  className="px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
              <button onClick={() => loadData(dateRange.from, dateRange.to)} className="px-3 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-medium transition-all flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" /> Load
              </button>
              <div className="flex-1" />
              <div className="relative min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                <input type="search" placeholder="Search ref/name..." value={searchQ} onChange={e => setSearchQ(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={filterType} onChange={e => setFilterType(e.target.value)}
                className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs focus:outline-none focus:border-accent/50">
                <option value="All">All Types (In/Out)</option>
                <option value="IN">Money In</option>
                <option value="OUT">Money Out / Refund</option>
              </select>
              <select value={filterMode} onChange={e => setFilterMode(e.target.value)}
                className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs focus:outline-none focus:border-accent/50">
                <option value="All">All Methods</option>
                {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs focus:outline-none focus:border-accent/50">
                <option value="All">All Status</option>
                {PAYMENT_STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
              <span className="flex items-center text-xs text-muted ml-auto">
                {filtered.length} records found
              </span>
            </div>
          </div>

          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>ID</th>
                    <th>Status</th>
                    <th>Customer / Notes</th>
                    <th>Method</th>
                    <th>Ref / Link</th>
                    <th className="text-right">Amount + GST</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan="8" className="text-center py-8 text-muted text-sm">No payment records found</td></tr>
                  ) : (
                    filtered.map(p => {
                      const PayIcon = PAYMENT_ICONS[p.method] || Receipt;
                      const isOut = p.type === 'OUT';
                      const statusColors = {
                        'Pending': 'bg-yellow-500/10 text-yellow-700 border-yellow-500/20',
                        'Reconciled': 'bg-green-500/10 text-green-700 border-green-500/20',
                        'Reversed': 'bg-red-500/10 text-red-700 border-red-500/20',
                        'Bounced': 'bg-orange-500/10 text-orange-700 border-orange-500/20'
                      };
                      return (
                        <tr key={p.id}>
                          <td className="text-xs text-muted whitespace-nowrap">
                            {new Date(p.date).toLocaleDateString('en-GB')}
                            <div className="text-[10px] mt-0.5">{new Date(p.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                          </td>
                          <td><span className="text-[11px] font-mono bg-surface px-1.5 py-0.5 rounded text-muted">{p.displayId}</span></td>
                          <td>
                            <span className={`text-[10px] font-semibold px-2 py-1 rounded border w-max ${statusColors[p.status] || 'bg-surface'}`}>
                              {p.status}
                            </span>
                          </td>
                          <td>
                            <div className="text-sm font-medium text-foreground">{p.customerName || p.contact?.name || '—'}</div>
                            {p.notes && <div className="text-[11px] text-muted truncate max-w-[200px] mt-0.5">{p.notes}</div>}
                            {p.chequeNumber && <div className="text-[11px] text-blue-500 mt-0.5">Check: {p.chequeNumber}</div>}
                          </td>
                          <td>
                            <span className="flex items-center gap-1.5 text-xs text-foreground bg-background border border-border px-2 py-1 rounded-lg w-max">
                              <PayIcon className="w-3.5 h-3.5 text-muted" /> {p.method}
                            </span>
                          </td>
                          <td>
                            <div className="flex flex-col gap-0.5">
                              {p.reference ? <span className="text-xs text-foreground font-mono">{p.reference}</span> : <span className="text-xs text-muted">—</span>}
                              {p.invoice && <span className="text-[10px] text-accent">Inv: {p.invoice.displayId}</span>}
                              {p.order && <span className="text-[10px] text-blue-500">Ord: {p.order.displayId}</span>}
                              {p.bankRefNumber && <span className="text-[10px] text-green-600">Bank: {p.bankRefNumber}</span>}
                            </div>
                          </td>
                          <td className={`text-right font-bold text-sm ${isOut ? 'text-red-500' : 'text-green-500'}`}>
                            {isOut ? '-' : '+'}{formatCurrency(p.amount + (p.gstAmount || 0))}
                            {p.gstAmount > 0 && <div className="text-[10px] text-muted">+{formatCurrency(p.gstAmount)} GST</div>}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            <div className="relative group">
                              <button className="p-1.5 text-muted hover:text-accent bg-surface rounded-lg">
                                <MoreHorizontal className="w-3.5 h-3.5" />
                              </button>
                              <div className="absolute right-0 top-full mt-1 bg-background border border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all p-1 z-20">
                                {p.attachment && (
                                  <a href={p.attachment} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted hover:text-accent whitespace-nowrap">
                                    <Eye className="w-3.5 h-3.5" /> View
                                  </a>
                                )}
                                {!p.isReversal && p.status !== 'Bounced' && (
                                  <>
                                    {p.method === 'Cheque' && !p.chequeBounced && (
                                      <button onClick={() => {
                                        setSelectedPaymentForAction(p);
                                        setShowBounceModal(true);
                                      }} className="flex items-center gap-2 px-3 py-1.5 text-xs text-orange-600 hover:bg-orange-500/10 w-full text-left whitespace-nowrap">
                                        <AlertCircle className="w-3.5 h-3.5" /> Mark Bounced
                                      </button>
                                    )}
                                    <button onClick={() => {
                                      setSelectedPaymentForAction(p);
                                      setShowReverseModal(true);
                                    }} className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10 w-full text-left whitespace-nowrap">
                                      <RotateCcw className="w-3.5 h-3.5" /> Reverse
                                    </button>
                                  </>
                                )}
                                <button onClick={() => handleDelete(p.id)} className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10 w-full text-left whitespace-nowrap">
                                  <Trash2 className="w-3.5 h-3.5" /> Delete
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: RECONCILIATION */}
      {tab === 'reconcile' && reconciliationData && (
        <div className="space-y-4">
          {/* Reconciliation Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="glass-card p-5 border-l-4 border-yellow-500">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-yellow-600" /> Unreconciled
              </h4>
              <p className="text-2xl font-bold text-yellow-600 mb-1">{reconciliationData.unreconciledCount}</p>
              <p className="text-sm text-muted">Amount: {formatCurrency(reconciliationData.unreconciledAmount)}</p>
            </div>
            <div className="glass-card p-5 border-l-4 border-green-500">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
                <CheckCheck className="w-4 h-4 text-green-600" /> Reconciled
              </h4>
              <p className="text-2xl font-bold text-green-600 mb-1">{reconciliationData.reconciledCount}</p>
              <p className="text-sm text-muted">Amount: {formatCurrency(reconciliationData.reconciledAmount)}</p>
            </div>
            <div className="glass-card p-5 border-l-4 border-orange-500">
              <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
                <AlertCircle className="w-4 h-4 text-orange-600" /> Bounced Cheques
              </h4>
              <p className="text-2xl font-bold text-orange-600 mb-1">{reconciliationData.bouncedChequeCount}</p>
              <p className="text-sm text-muted">Amount: {formatCurrency(reconciliationData.bouncedChequeAmount)}</p>
            </div>
          </div>

          {/* Unreconciled Payments */}
          {reconciliationData.unreconciledList && reconciliationData.unreconciledList.length > 0 && (
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-600" /> Unreconciled Payments ({reconciliationData.unreconciledList.length})
              </h3>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {reconciliationData.unreconciledList.map(p => (
                  <div key={p.id} className="flex items-center justify-between p-3 bg-surface rounded-lg border border-border">
                    <div className="flex-1">
                      <p className="text-sm font-medium text-foreground">{p.displayId}</p>
                      <p className="text-xs text-muted">{p.customerName || p.contact?.name} • {new Date(p.date).toLocaleDateString()}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-foreground">{formatCurrency(p.amount)}</span>
                      <input type="checkbox" checked={selectedPayments.has(p.id)} onChange={e => {
                        const newSet = new Set(selectedPayments);
                        if (e.target.checked) newSet.add(p.id);
                        else newSet.delete(p.id);
                        setSelectedPayments(newSet);
                      }} className="cursor-pointer" />
                    </div>
                  </div>
                ))}
              </div>
              {selectedPayments.size > 0 && (
                <div className="mt-4 flex gap-2">
                  <button onClick={() => setShowReconcileModal(true)} className="flex-1 px-4 py-2 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors">
                    Reconcile Selected ({selectedPayments.size})
                  </button>
                  <button onClick={() => setSelectedPayments(new Set())} className="px-4 py-2 bg-surface border border-border text-foreground rounded-xl text-sm font-medium hover:bg-surface-hover">
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Bounced Cheques Alert */}
          {reconciliationData.bouncedCheques && reconciliationData.bouncedCheques.length > 0 && (
            <div className="glass-card p-5 border-l-4 border-orange-500 bg-orange-500/5">
              <h3 className="text-sm font-semibold text-orange-700 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Bounced Cheques Alert
              </h3>
              <div className="space-y-2">
                {reconciliationData.bouncedCheques.map(p => (
                  <div key={p.id} className="text-sm text-orange-700">
                    <strong>{p.chequeNumber}</strong> from {p.customerName || p.contact?.name} ({formatCurrency(p.amount)}) - {p.bounceReason}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB: ANALYTICS */}
      {tab === 'analytics' && (
        <div className="space-y-4">
          {/* Top-line KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Total In</p>
              <p className="text-xl font-bold text-green-600">{formatCurrency(totalIn)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Total Out</p>
              <p className="text-xl font-bold text-red-600">{formatCurrency(totalOut)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Net Flow</p>
              <p className="text-xl font-bold text-foreground">{formatCurrency(totalIn - totalOut)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">UPI Payments</p>
              <p className="text-xl font-bold text-accent">{formatCurrency(filtered.filter(p => p.method === 'UPI' && p.type === 'IN').reduce((s, p) => s + p.amount, 0))}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Payment Methods Chart (Horizontal Bars) */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Payment Methods (Received)</h3>
              <div className="space-y-3">
                {PAYMENT_MODES.map((m, idx) => {
                  const modeTotal = filtered.filter(p => p.method === m && p.type === 'IN').reduce((s, p) => s + p.amount, 0);
                  const perc = totalIn > 0 ? (modeTotal / totalIn) * 100 : 0;
                  if (modeTotal === 0) return null;
                  const color = ['#6366F1', '#10B981', '#F59E0B', '#3B82F6', '#8B5CF6', '#EC4899'][idx % 6];
                  const Icon = PAYMENT_ICONS[m] || Receipt;
                  return (
                    <div key={m}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
                            <Icon className="w-3 h-3" style={{ color }} />
                          </div>
                          <span className="text-xs font-medium text-foreground">{m}</span>
                          <span className="text-[10px] text-muted">({filtered.filter(p => p.method === m && p.type === 'IN').length} entries)</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-bold text-foreground">{formatCurrency(modeTotal)}</span>
                        </div>
                      </div>
                      <div className="w-full bg-border rounded-full h-2">
                        <div className="h-2 rounded-full transition-all" style={{
                          backgroundColor: color,
                          width: `${Math.min(100, perc)}%`,
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Daily trend (simple bar chart) */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Daily Income Trend</h3>
              <div className="flex items-end gap-1 h-40 overflow-x-auto pb-6 relative">
                {(() => {
                  const days = {};
                  filtered.filter(p => p.type === 'IN').forEach(p => {
                    if (!p.date) return;
                    try {
                      const d = istDate(p.date);
                      days[d] = (days[d] || 0) + p.amount;
                    } catch (e) { console.error('Date parsing error', e); }
                  });
                  const sortedDays = Object.keys(days).sort().slice(-14);
                  if (sortedDays.length === 0) return <div className="text-center w-full text-muted text-sm mt-10">No data</div>;

                  const maxDay = Math.max(...Object.values(days), 1);
                  return sortedDays.map(d => (
                    <div key={d} className="flex flex-col items-center min-w-[28px] flex-1 relative group">
                      <div className="absolute -top-6 bg-foreground text-background px-1.5 py-0.5 rounded text-[9px] font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                        {formatCurrency(days[d])}
                      </div>
                      <div className="w-full rounded-t-md bg-green-500/80 hover:bg-green-500 transition-all cursor-default"
                        style={{ height: `${Math.max(4, (days[d] / maxDay) * 140)}px` }} />
                      <span className="text-[8px] text-muted mt-1 absolute -bottom-5 whitespace-nowrap">{d.slice(5)}</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ CASH REGISTER TAB ═══════ */}
      {tab === 'cash' && !cashReg && (
        <div className="glass-card py-16 text-center text-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent mx-auto mb-3" />
          <p className="text-sm">Loading cash register...</p>
        </div>
      )}
      {tab === 'cash' && cashReg && (
        <div className="space-y-4">
          <div className="glass-card p-6">
            <h3 className="text-base font-semibold text-foreground mb-5 flex items-center gap-2">
              <Banknote className="w-5 h-5 text-accent" /> Daily Cash Register — {todayStr}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="bg-surface rounded-xl p-4 border border-border">
                <p className="text-xs text-muted mb-1">Opening Cash</p>
                {editingCash ? (
                  <div className="flex items-center gap-2 mt-2">
                    <input
                      type="number"
                      value={openingCashInput}
                      onChange={e => setOpeningCashInput(e.target.value)}
                      className="w-full px-2 py-1 text-sm bg-background border border-border rounded outline-none"
                      placeholder={cashReg?.openingCash || 0}
                    />
                    <button onClick={handleSaveOpeningCash} disabled={submitting} className="p-1.5 text-green-500 hover:bg-green-500/10 rounded border border-green-500/20">
                      <CheckCircle2 className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditingCash(false)} className="p-1.5 text-muted hover:bg-white/5 rounded border border-border">
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-lg font-bold text-foreground">{formatCurrency(cashReg?.openingCash || 0)}</span>
                    <button onClick={() => { setOpeningCashInput(cashReg?.openingCash || 0); setEditingCash(true); }} className="p-1.5 text-muted hover:text-accent rounded border border-border bg-background">
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <div className="bg-surface rounded-xl p-4 border border-border">
                <p className="text-xs text-muted mb-1">Cash In (Sales)</p>
                <div className="relative">
                  <p className="text-lg font-bold text-green-600 py-1">{formatCurrency(cashReg?.cashIn || 0)}</p>
                  <p className="text-[10px] text-muted">Auto-calculated from payments</p>
                </div>
              </div>
              <div className="bg-surface rounded-xl p-4 border border-border">
                <p className="text-xs text-muted mb-1">Cash Out (Expenses)</p>
                <p className="text-lg font-bold text-red-600 py-1">{formatCurrency(cashReg?.cashOut || 0)}</p>
                <p className="text-[10px] text-muted">Auto-calculated from cash expenses</p>
              </div>
              <div className="bg-surface rounded-xl p-4 border border-accent/30">
                <p className="text-xs text-muted mb-1">Expected Closing</p>
                <p className="text-lg font-bold text-accent py-1">
                  {formatCurrency((cashReg?.openingCash || 0) + (cashReg?.cashIn || 0) - (cashReg?.cashOut || 0))}
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-sm text-blue-600 flex items-start gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <p>
                The <strong>Cash Register</strong> automatically tracks your daily cash flow.
                <br />
                <span className="opacity-80">Cash In comes from Daily Payments marked as &quot;Cash&quot; (Money In). Cash Out comes from Cash Payments (Money Out) + Cash Expenses from the Daily Expense Calculator. Just set your Opening Cash!</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Reverse Payment Modal */}
      <Modal isOpen={showReverseModal} onClose={() => setShowReverseModal(false)} title="Reverse Payment">
        <div className="space-y-4">
          {selectedPaymentForAction && (
            <>
              <div className="bg-red-500/10 border border-red-500/20 p-3 rounded-lg">
                <p className="text-sm font-medium text-foreground mb-1">Payment to Reverse:</p>
                <p className="text-lg font-bold text-red-600">{selectedPaymentForAction.displayId} - {formatCurrency(selectedPaymentForAction.amount)}</p>
                <p className="text-xs text-muted mt-1">{selectedPaymentForAction.customerName || selectedPaymentForAction.contact?.name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-2">Reason for Reversal</label>
                <textarea rows={3} placeholder="e.g., Incorrect entry, duplicate payment, customer request..."
                  onChange={(e) => setSelectedPaymentForAction({ ...selectedPaymentForAction, reversalReason: e.target.value })}
                  className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none resize-none" />
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <button onClick={() => setShowReverseModal(false)} className="px-4 py-2 bg-surface text-foreground rounded-xl text-sm font-medium hover:bg-surface-hover">Cancel</button>
                <button onClick={() => handleReversePayment(selectedPaymentForAction.reversalReason)} disabled={submitting} className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 disabled:opacity-50">
                  {submitting ? <RefreshCw className="w-4 h-4 animate-spin inline mr-2" /> : null}
                  Confirm Reversal
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Cheque Bounce Modal */}
      <Modal isOpen={showBounceModal} onClose={() => setShowBounceModal(false)} title="Mark Cheque as Bounced">
        <div className="space-y-4">
          {selectedPaymentForAction && (
            <>
              <div className="bg-orange-500/10 border border-orange-500/20 p-3 rounded-lg">
                <p className="text-sm font-medium text-foreground mb-1">Cheque Details:</p>
                <p className="text-lg font-bold text-orange-600">{selectedPaymentForAction.chequeNumber}</p>
                <p className="text-sm text-muted mt-1">Amount: {formatCurrency(selectedPaymentForAction.amount)}</p>
                <p className="text-xs text-muted">{selectedPaymentForAction.customerName || selectedPaymentForAction.contact?.name}</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-2">Bounce Reason</label>
                <select onChange={(e) => setSelectedPaymentForAction({ ...selectedPaymentForAction, bounceReason: e.target.value })}
                  className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none">
                  <option value="">Select reason...</option>
                  <option value="Insufficient Funds">Insufficient Funds</option>
                  <option value="Account Closed">Account Closed</option>
                  <option value="Signature Mismatch">Signature Mismatch</option>
                  <option value="Stale Cheque">Stale Cheque</option>
                  <option value="Refer to Drawer">Refer to Drawer</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-2">Additional Notes</label>
                <input type="text" placeholder="Any other information..."
                  onChange={(e) => setSelectedPaymentForAction({ ...selectedPaymentForAction, bounceNotes: e.target.value })}
                  className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" />
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <button onClick={() => setShowBounceModal(false)} className="px-4 py-2 bg-surface text-foreground rounded-xl text-sm font-medium hover:bg-surface-hover">Cancel</button>
                <button onClick={() => handleMarkChequeBounced(selectedPaymentForAction.bounceReason)} disabled={submitting} className="px-6 py-2 bg-orange-600 text-white rounded-xl text-sm font-semibold hover:bg-orange-700 disabled:opacity-50">
                  {submitting ? <RefreshCw className="w-4 h-4 animate-spin inline mr-2" /> : null}
                  Mark Bounced
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Reconcile Payments Modal */}
      <Modal isOpen={showReconcileModal} onClose={() => setShowReconcileModal(false)} title="Reconcile Payments">
        <div className="space-y-4">
          <div className="bg-green-500/10 border border-green-500/20 p-3 rounded-lg">
            <p className="text-sm font-medium text-foreground">Selected: <span className="text-green-600 font-bold">{selectedPayments.size} payments</span></p>
            <p className="text-xs text-muted mt-1">Total Amount: {formatCurrency(Array.from(selectedPayments).reduce((sum, id) => {
              const p = payments.find(payment => payment.id === id);
              return sum + (p?.amount || 0);
            }, 0))}</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm text-muted">These payments will be marked as &quot;Reconciled&quot; in the system.</p>
            <p className="text-xs text-muted">Note: Ensure you've matched these payments with your bank statement before confirming.</p>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button onClick={() => setShowReconcileModal(false)} className="px-4 py-2 bg-surface text-foreground rounded-xl text-sm font-medium hover:bg-surface-hover">Cancel</button>
            <button onClick={handleReconcile} disabled={submitting} className="px-6 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
              {submitting ? <RefreshCw className="w-4 h-4 animate-spin inline mr-2" /> : null}
              Reconcile Now
            </button>
          </div>
        </div>
      </Modal>

      {/* Record Payment Modal */}
      <Modal isOpen={showAddPayment} onClose={() => setShowAddPayment(false)} title="Record Payment">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className={`cursor-pointer p-3 border rounded-xl text-center transition-all ${form.type === 'IN' ? 'border-green-500 bg-green-500/10 text-green-500' : 'border-border text-muted hover:border-border-hover'}`}>
              <input type="radio" className="hidden" checked={form.type === 'IN'} onChange={() => setForm(f => ({ ...f, type: 'IN' }))} />
              <div className="text-sm font-semibold">Money In</div>
              <div className="text-[10px]">Received payment</div>
            </label>
            <label className={`cursor-pointer p-3 border rounded-xl text-center transition-all ${form.type === 'OUT' ? 'border-red-500 bg-red-500/10 text-red-500' : 'border-border text-muted hover:border-border-hover'}`}>
              <input type="radio" className="hidden" checked={form.type === 'OUT'} onChange={() => setForm(f => ({ ...f, type: 'OUT' }))} />
              <div className="text-sm font-semibold">Money Out</div>
              <div className="text-[10px]">Refund / Change given</div>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Amount *</label>
              <div className="relative">
                <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input type="number" min="1" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" placeholder="0" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Payment Method *</label>
              <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none">
                {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">GST Amount (Optional)</label>
              <div className="relative">
                <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input type="number" min="0" value={form.gstAmount} onChange={e => setForm(f => ({ ...f, gstAmount: e.target.value }))}
                  className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" placeholder="0" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Reference / Txn ID</label>
              <input type="text" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" placeholder="e.g. UPI Ref, Bank Ref" />
            </div>
          </div>

          {/* Cheque-specific fields */}
          {form.method === 'Cheque' && (
            <div className="grid grid-cols-2 gap-4 p-3 bg-blue-500/10 rounded-xl border border-blue-500/20">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Cheque Number *</label>
                <input type="text" value={form.chequeNumber} onChange={e => setForm(f => ({ ...f, chequeNumber: e.target.value }))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" placeholder="e.g. 123456" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Cheque Date</label>
                <input type="date" value={form.chequeDate} onChange={e => setForm(f => ({ ...f, chequeDate: e.target.value }))}
                  className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Date</label>
              <input type="datetime-local" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Dealer / Customer Name</label>
            <input type="text" value={form.customerName} onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" placeholder="Enter name" />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Notes</label>
            <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:border-accent/50 outline-none" placeholder="Any remarks" />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Receipt Attachment</label>
            <div className="flex items-center gap-3">
              <label className={`flex-1 px-3 py-2 bg-background border border-dashed border-border rounded-xl text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors ${receiptUploading ? 'opacity-50' : 'hover:border-accent/50'}`}>
                {receiptUploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4 text-muted" />}
                <span className="text-muted">{form.attachment ? 'Replace File' : 'Upload File'}</span>
                <input type="file" className="hidden" accept="image/*,.pdf" onChange={e => handleReceiptUpload(e.target.files?.[0])} disabled={receiptUploading} />
              </label>
              {form.attachment && (
                <div className="flex gap-2">
                  <a href={form.attachment} target="_blank" rel="noreferrer" className="p-2 border border-border rounded-xl hover:bg-surface text-accent">
                    <Eye className="w-4 h-4" />
                  </a>
                  <button onClick={() => setForm(f => ({ ...f, attachment: '' }))} className="p-2 border border-border rounded-xl hover:bg-red-500/10 text-red-500">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
            {receiptError && <p className="text-[10px] text-red-500 mt-1">{receiptError}</p>}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <button onClick={() => setShowAddPayment(false)} className="px-4 py-2 bg-surface text-foreground rounded-xl text-sm font-medium hover:bg-surface-hover">Cancel</button>
            <button onClick={handleAddPayment} disabled={submitting || !form.amount || receiptUploading} className="px-6 py-2 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover disabled:opacity-50">
              Save Payment
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
