/* eslint-disable @next/next/no-img-element */
'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, Search, Calendar, Trash2, Download, Filter, MoreHorizontal,
  IndianRupee, TrendingUp, TrendingDown, Wallet, PieChart, BarChart3,
  Receipt, CreditCard, Banknote, ChevronDown, ChevronRight, CheckCircle2,
  XCircle, Clock, AlertTriangle, RefreshCw, Settings2, Repeat, Edit3,
  ArrowUpRight, ArrowDownRight, X, ChevronLeft, Check, Eye,
  TreePine, Truck, Package, Coffee, Fuel, Home, Zap, Wrench, Paperclip,
  FileText, Megaphone, Factory, Store, HardHat, Landmark, Layers, Warehouse,
} from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import {
  getExpenses, createExpense, updateExpense,
  getExpenseCategories, createExpenseCategory, updateCategoryBudget, deleteExpenseCategory,
  seedExpenseCategories,
  getRecurringExpenses, createRecurringExpense, toggleRecurringExpense, deleteRecurringExpense,
  getCashRegister, updateCashRegister,
  getExpenseSummary, getBudgetVsActual,
} from '@/app/actions/expenses';
import { moveExpenseToDraft } from '@/app/actions/drafts';
import { getActiveVertical } from '@/lib/brand';
import { confirmDialog } from '@/components/AlertToastProvider';

const IS_TGM = getActiveVertical() === 'tiles';

const ICON_MAP = {
  TreePine, Truck, Package, Coffee, Fuel, Home, Zap, Wrench,
  FileText, Megaphone, Factory, Store, HardHat, Landmark, Layers, Warehouse, MoreHorizontal,
};

const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque', 'Credit'];
const PAYMENT_ICONS = { Cash: Banknote, UPI: Wallet, Card: CreditCard, 'Bank Transfer': Landmark, Cheque: FileText, Credit: Receipt };
const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Yearly'];

const formatCurrency = (n) => `₹${(n || 0).toLocaleString('en-IN')}`;

const today = () => new Date().toISOString().split('T')[0];
const monthStr = () => new Date().toISOString().slice(0, 7); // YYYY-MM
const startOfMonth = () => monthStr() + '-01';

export default function ExpensesPage() {
  const { session } = useSession();
  const alertToast = useAlertToast?.() || { notify: (m) => alert(m) };
  // ─── TAB & CORE STATE ──────────────────────────
  const [tab, setTab] = useState('today');
  const [loading, setLoading] = useState(true);

  // Data
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [recurring, setRecurring] = useState([]);
  const [cashReg, setCashReg] = useState(null);
  const [summary, setSummary] = useState(null);
  const [budgetData, setBudgetData] = useState([]);

  // Filters
  const [searchQ, setSearchQ] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [filterPayment, setFilterPayment] = useState('All');
  const [dateRange, setDateRange] = useState({ from: startOfMonth(), to: today() });
  const [selectedMonth, setSelectedMonth] = useState(monthStr());

  // Per-tab loading states
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [cashSaving, setCashSaving] = useState(false);

  // Modals
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [showAddRecurring, setShowAddRecurring] = useState(false);
  const [showBudgetEdit, setShowBudgetEdit] = useState(null); // categoryId
  const [expenseToDraft, setExpenseToDraft] = useState(null);
  const [deletingExpense, setDeletingExpense] = useState(false);
  const [budgetVal, setBudgetVal] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [cashSaved, setCashSaved] = useState(false);
  const [receiptUploading, setReceiptUploading] = useState(false);
  const [receiptError, setReceiptError] = useState('');

  // New expense form
  const [expForm, setExpForm] = useState({
    date: today(), categoryId: '', amount: '', description: '',
    paymentMode: 'Cash', reference: '', vendor: '', notes: '', receipt: '',
  });

  // New category form
  const [catForm, setCatForm] = useState({ name: '', color: '#6366F1', budget: '' });

  // New recurring form
  const [recForm, setRecForm] = useState({
    categoryId: '', description: '', amount: '', paymentMode: 'Bank Transfer',
    vendor: '', frequency: 'Monthly', dayOfMonth: '1', notes: '',
  });

  // ─── DATA LOADING ──────────────────────────────

  const loadData = useCallback(async (from = dateRange.from, to = dateRange.to) => {
    setLoading(true);
    try {
      const [catRes, expRes, recRes, cashRes] = await Promise.all([
        getExpenseCategories(),
        getExpenses(from, to),
        getRecurringExpenses(),
        getCashRegister(today()),
      ]);
      if (catRes.success) {
        if (catRes.data.length === 0) {
          // Seed defaults on first load
          await seedExpenseCategories();
          const r = await getExpenseCategories();
          if (r.success) setCategories(r.data);
        } else {
          setCategories(catRes.data);
        }
      }
      if (expRes.success) setExpenses(expRes.data);
      if (recRes.success) setRecurring(recRes.data);
      if (cashRes.success) setCashReg(cashRes.data);
    } finally {
      setLoading(false);
    }
  }, [dateRange.from, dateRange.to]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);
  // Initial load on mount; re-runs when the date range changes.

  // Load summary when tab changes to analytics/budget, with loading states
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (tab === 'analytics') {
        setSummary(null); // clear stale data
        setAnalyticsLoading(true);
        getExpenseSummary(dateRange.from, dateRange.to)
          .then(r => { if (r.success) setSummary(r.data); })
          .finally(() => setAnalyticsLoading(false));
      }
      if (tab === 'budget') {
        setBudgetLoading(true);
        getBudgetVsActual(selectedMonth)
          .then(r => { if (r.success) setBudgetData(r.data); })
          .finally(() => setBudgetLoading(false));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tab, dateRange, selectedMonth]);

  // ─── FILTERED EXPENSES ─────────────────────────

  const filtered = useMemo(() => expenses.filter(e => {
    if (filterCategory !== 'All' && e.categoryName !== filterCategory) return false;
    if (filterPayment !== 'All' && e.paymentMode !== filterPayment) return false;
    if (searchQ && !e.description.toLowerCase().includes(searchQ.toLowerCase()) && !e.vendor?.toLowerCase().includes(searchQ.toLowerCase())) return false;
    return true;
  }), [expenses, filterCategory, filterPayment, searchQ]);

  // Today's expenses
  const todayStr = today();
  const todayExpenses = useMemo(() => expenses.filter(e => e.date === todayStr), [expenses, todayStr]);
  const todayTotal = todayExpenses.reduce((s, e) => s + e.amount, 0);
  const totalInRange = filtered.reduce((s, e) => s + e.amount, 0);

  // ─── HANDLERS ──────────────────────────────────

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
        setExpForm(f => ({ ...f, receipt: uploadData.urls[0] }));
      } else {
        setReceiptError(uploadData?.error || 'Receipt upload failed.');
      }
    } catch (err) {
      setReceiptError('Receipt upload failed. Please try again.');
    } finally {
      setReceiptUploading(false);
    }
  };

  const clearReceipt = () => {
    setExpForm(f => ({ ...f, receipt: '' }));
    setReceiptError('');
  };

  const handleSaveExpense = async () => {
    if (!expForm.categoryId || !expForm.amount || !expForm.description || receiptUploading) return;
    setSubmitting(true);
    const payload = {
      ...expForm,
      categoryId: parseInt(expForm.categoryId),
      amount: parseInt(expForm.amount),
    };
    
    let res;
    if (editingExpenseId) {
      res = await updateExpense(editingExpenseId, payload);
    } else {
      res = await createExpense(payload);
    }
    
    if (res.success) {
      setShowAddExpense(false);
      setEditingExpenseId(null);
      setExpForm({ date: today(), categoryId: '', amount: '', description: '', paymentMode: 'Cash', reference: '', vendor: '', notes: '', receipt: '' });
      setReceiptError('');
      await loadData(dateRange.from, dateRange.to);
      // Refresh analytics/budget if they were loaded
      if (summary) {
        setAnalyticsLoading(true);
        getExpenseSummary(dateRange.from, dateRange.to)
          .then(r => { if (r.success) setSummary(r.data); })
          .finally(() => setAnalyticsLoading(false));
      }
      if (budgetData.length > 0) {
        getBudgetVsActual(selectedMonth).then(r => { if (r.success) setBudgetData(r.data); });
      }
    } else {
      alert(res.error || 'Failed');
    }
    setSubmitting(false);
  };

  const handleDeleteExpense = (expense) => {
    if (!expense) return;
    setExpenseToDraft(expense);
  };

  const handleEditExpense = (expense) => {
    if (!expense) return;
    setEditingExpenseId(expense.id);
    setExpForm({
      date: expense.date,
      categoryId: String(expense.categoryId),
      amount: String(expense.amount),
      description: expense.description,
      paymentMode: expense.paymentMode,
      reference: expense.reference || '',
      vendor: expense.vendor || '',
      notes: expense.notes || '',
      receipt: expense.receipt || '',
    });
    setReceiptError('');
    setShowAddExpense(true);
  };

  const confirmMoveExpenseToDraft = async () => {
    if (!expenseToDraft) return;
    setDeletingExpense(true);
    try {
      const res = await moveExpenseToDraft(expenseToDraft.id);
      if (res?.success) {
        await loadData(dateRange.from, dateRange.to);
        // Refresh analytics/budget if they were loaded
        if (summary) {
          setAnalyticsLoading(true);
          getExpenseSummary(dateRange.from, dateRange.to)
            .then(r => { if (r.success) setSummary(r.data); })
            .finally(() => setAnalyticsLoading(false));
        }
        if (budgetData.length > 0) {
          getBudgetVsActual(selectedMonth).then(r => { if (r.success) setBudgetData(r.data); });
        }
        alertToast.notify?.('Expense moved to drafts', 'success');
      } else {
        alertToast.notify?.(res?.error || 'Failed to move expense to drafts', 'error');
      }
    } catch (err) {
      alertToast.notify?.(err?.message || 'Failed to move expense to drafts', 'error');
    } finally {
      setDeletingExpense(false);
      setExpenseToDraft(null);
    }
  };

  const cancelMoveExpenseToDraft = () => setExpenseToDraft(null);

  const handleAddCategory = async () => {
    if (!catForm.name) return;
    setSubmitting(true);
    const res = await createExpenseCategory({
      name: catForm.name,
      color: catForm.color,
      budget: parseInt(catForm.budget) || 0,
    });
    if (res.success) {
      setShowAddCategory(false);
      setCatForm({ name: '', color: '#6366F1', budget: '' });
      await loadData(dateRange.from, dateRange.to);
    } else {
      alert(res.error || 'Failed');
    }
    setSubmitting(false);
  };

  const handleSaveBudget = async () => {
    if (showBudgetEdit) {
      await updateCategoryBudget(showBudgetEdit, budgetVal);
      setShowBudgetEdit(null);
      await loadData(dateRange.from, dateRange.to);
      if (tab === 'budget') {
        const r = await getBudgetVsActual(selectedMonth);
        if (r.success) setBudgetData(r.data);
      }
    }
  };

  const handleAddRecurring = async () => {
    if (!recForm.categoryId || !recForm.amount || !recForm.description) return;
    setSubmitting(true);
    const res = await createRecurringExpense({
      ...recForm,
      categoryId: parseInt(recForm.categoryId),
      amount: parseInt(recForm.amount),
      dayOfMonth: parseInt(recForm.dayOfMonth) || 1,
    });
    if (res.success) {
      setShowAddRecurring(false);
      setRecForm({ categoryId: '', description: '', amount: '', paymentMode: 'Bank Transfer', vendor: '', frequency: 'Monthly', dayOfMonth: '1', notes: '' });
      await loadData(dateRange.from, dateRange.to);
    } else {
      alert(res.error || 'Failed');
    }
    setSubmitting(false);
  };

  const handleSaveCashRegister = async () => {
    if (!cashReg) return;
    setCashSaving(true);
    const res = await updateCashRegister({
      date: todayStr,
      openingCash: cashReg.openingCash,
      closingCash: cashReg.closingCash,
      cashIn: cashReg.cashIn,
      notes: cashReg.notes,
    });
    setCashSaving(false);
    if (res.success) {
      setCashSaved(true);
      setTimeout(() => setCashSaved(false), 3000);
    } else {
      alert(res.error || 'Failed to save cash register');
    }
  };

  const handleExportCSV = () => {
    const header = 'Date,Category,Description,Amount,Payment Mode,Vendor,Reference,Status\n';
    const rows = filtered.map(e =>
      [e.date, `"${e.categoryName}"`, `"${e.description}"`, e.amount, e.paymentMode, `"${e.vendor || ''}"`, `"${e.reference || ''}"`, e.status].join(',')
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `expenses_${dateRange.from}_to_${dateRange.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── RENDER ────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-64 bg-surface rounded-lg" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-24 bg-surface rounded-2xl" />)}</div>
        <div className="h-96 bg-surface rounded-2xl" />
      </div>
    );
  }

  const CatIcon = ({ name, className = 'w-4 h-4' }) => {
    const Icon = ICON_MAP[name] || MoreHorizontal;
    return <Icon className={className} />;
  };

  const tabs = [
    { key: 'today', label: "Today's Expenses", icon: Calendar },
    { key: 'all', label: 'All Expenses', icon: Receipt },
    { key: 'analytics', label: 'Analytics', icon: PieChart },
    { key: 'budget', label: 'Budget vs Actual', icon: BarChart3 },
    { key: 'recurring', label: 'Recurring', icon: Repeat },
    { key: 'categories', label: 'Categories', icon: Settings2 },
  ];

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Daily Expense Calculator</h1>
          <p className="text-xs md:text-sm text-muted mt-1">
            Today: {formatCurrency(todayTotal)} · This period: {formatCurrency(totalInRange)} · {filtered.length} entries
          </p>
        </div>
        <div className="flex w-full sm:w-auto items-center gap-2">
          <button onClick={handleExportCSV}
            className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 py-2 bg-surface border border-border hover:border-accent/30 text-foreground rounded-xl text-sm font-medium transition-all">
            <Download className="w-4 h-4" /> Export
          </button>
          <button onClick={() => setShowAddExpense(true)}
            className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
            <Plus className="w-4 h-4" /> Add Expense
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-red-500/10"><TrendingUp className="w-5 h-5 text-red-600" /></div>
          <div><p className="text-xs text-muted">Today</p><p className="text-lg font-bold text-red-600">{formatCurrency(todayTotal)}</p></div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-accent-light"><IndianRupee className="w-5 h-5 text-accent" /></div>
          <div><p className="text-xs text-muted">This Period</p><p className="text-lg font-bold text-foreground">{formatCurrency(totalInRange)}</p></div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/10"><Wallet className="w-5 h-5 text-amber-600" /></div>
          <div><p className="text-xs text-muted">Cash in Hand</p>
            <p className="text-lg font-bold text-amber-600">{formatCurrency(
              (cashReg?.openingCash || 0) + (cashReg?.cashIn || 0) - (cashReg?.cashOut || 0)
            )}</p></div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-purple-500/10"><Repeat className="w-5 h-5 text-purple-600" /></div>
          <div><p className="text-xs text-muted">Recurring/mo</p>
            <p className="text-lg font-bold text-purple-600">{formatCurrency(
              recurring.filter(r => r.isActive && r.frequency === 'Monthly').reduce((s, r) => s + r.amount, 0)
            )}</p></div>
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

      {/* ═══════ TODAY TAB ═══════ */}
      {tab === 'today' && (
        <div className="space-y-4">
          {/* Quick-add inline */}
          <div className="glass-card p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Plus className="w-4 h-4 text-accent" /> Quick Add Today&apos;s Expense
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <select value={expForm.categoryId} onChange={e => setExpForm(f => ({ ...f, categoryId: e.target.value }))}
                className="px-3 py-2 bg-surface border border-border rounded-xl text-sm w-full sm:col-span-3 focus:outline-none focus:border-accent/50">
                <option value="">Category</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="relative w-full sm:col-span-2">
                <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                <input type="number" placeholder="Amount" min="1" value={expForm.amount}
                  onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full pl-8 pr-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
              <input type="text" placeholder={IS_TGM ? 'Description (e.g. Black Galaxy slab loading)' : 'Description (e.g. Teak wood 50kg)'} value={expForm.description}
                onChange={e => setExpForm(f => ({ ...f, description: e.target.value }))}
                className="px-3 py-2 bg-surface border border-border rounded-xl text-sm w-full sm:col-span-4 focus:outline-none focus:border-accent/50" />
              <select value={expForm.paymentMode} onChange={e => setExpForm(f => ({ ...f, paymentMode: e.target.value }))}
                className="px-3 py-2 bg-surface border border-border rounded-xl text-sm w-full sm:col-span-2 focus:outline-none focus:border-accent/50">
                {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
              <input type="text" placeholder="Vendor (optional)" value={expForm.vendor}
                onChange={e => setExpForm(f => ({ ...f, vendor: e.target.value }))}
                className="px-3 py-2 bg-surface border border-border rounded-xl text-sm w-full sm:col-span-3 focus:outline-none focus:border-accent/50" />
              <div className="flex items-center gap-2 w-full sm:col-span-3">
                <label className={`px-3 py-2 bg-surface border border-dashed border-border rounded-xl text-xs font-medium text-muted flex items-center gap-2 cursor-pointer transition-colors ${receiptUploading ? 'opacity-60 cursor-not-allowed' : 'hover:border-accent/50 hover:text-foreground'}`}>
                  {receiptUploading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
                  <span>{expForm.receipt ? 'Receipt attached' : 'Attach receipt'}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    disabled={receiptUploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      handleReceiptUpload(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                {expForm.receipt && (
                  <div className="flex items-center gap-1.5">
                    <a href={expForm.receipt} target="_blank" rel="noreferrer"
                      className="px-2 py-1 rounded-lg text-[11px] font-medium text-accent hover:text-accent-hover border border-border hover:border-accent/40 flex items-center gap-1">
                      <Eye className="w-3 h-3" /> View
                    </a>
                    <button type="button" onClick={clearReceipt}
                      className="p-1.5 rounded-lg border border-border text-muted hover:text-red-600 hover:border-red-500/40 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
              <button onClick={handleSaveExpense} disabled={!expForm.categoryId || !expForm.amount || !expForm.description || submitting || receiptUploading}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-40 flex items-center justify-center gap-1.5 w-full sm:col-span-2 sm:w-auto">
                {editingExpenseId ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {editingExpenseId ? 'Save Changes' : 'Add'}
              </button>
            </div>
            {receiptError && (
              <p className="text-[11px] text-red-600 mt-2">{receiptError}</p>
            )}
          </div>

          {/* Today's list */}
          {todayExpenses.length === 0 ? (
            <div className="glass-card py-16 text-center text-muted">
              <Receipt className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No expenses recorded today</p>
              <p className="text-sm mt-1">Add your first expense above or click &quot;Add Expense&quot;</p>
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">{todayStr} — {todayExpenses.length} expenses</h3>
                <span className="text-sm font-bold text-red-600">{formatCurrency(todayTotal)}</span>
              </div>
              <div className="divide-y divide-border">
                {todayExpenses.map(exp => {
                  const PayIcon = PAYMENT_ICONS[exp.paymentMode] || Receipt;
                  return (
                    <div key={exp.id} className="flex flex-col gap-2 px-5 py-3 hover:bg-surface-hover transition-colors sm:flex-row sm:items-center">
                      <div className="flex items-start gap-3 min-w-0 sm:flex-1">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${exp.categoryColor}20` }}>
                          <CatIcon name={exp.categoryIcon} className="w-4 h-4" style={{ color: exp.categoryColor }} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{exp.description}</p>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                            <span className="truncate max-w-[160px] sm:max-w-[240px]">{exp.categoryName}</span>
                            {exp.vendor && (
                              <>
                                <span className="text-border">·</span>
                                <span className="truncate max-w-[160px] sm:max-w-[240px]">{exp.vendor}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:flex-nowrap">
                        <span className="px-2 py-0.5 rounded-lg text-[10px] font-medium bg-surface border border-border text-muted flex items-center gap-1">
                          <PayIcon className="w-3 h-3" /> {exp.paymentMode}
                        </span>
                        <span className="text-sm font-bold text-red-600 w-24 text-right">{formatCurrency(exp.amount)}</span>
                        {exp.receipt && (
                          <a href={exp.receipt} target="_blank" rel="noreferrer"
                            className="p-1 text-muted hover:text-accent transition-colors" title="View receipt">
                            <Eye className="w-3.5 h-3.5" />
                          </a>
                        )}
                        {session?.user?.role === 'ADMIN' && (
                          <button onClick={() => handleEditExpense(exp)} className="p-1 text-muted hover:text-accent transition-colors" title="Edit expense">
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => handleDeleteExpense(exp)} className="p-1 text-muted hover:text-red-600 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Category-wise breakdown for today */}
          {todayExpenses.length > 0 && (
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Today by Category</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {(() => {
                  const catTotals = {};
                  todayExpenses.forEach(e => {
                    catTotals[e.categoryName] = catTotals[e.categoryName] || { total: 0, color: e.categoryColor, icon: e.categoryIcon };
                    catTotals[e.categoryName].total += e.amount;
                  });
                  return Object.entries(catTotals).sort((a, b) => b[1].total - a[1].total).map(([name, { total, color, icon }]) => (
                    <div key={name} className="bg-surface rounded-xl p-3 border border-border">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${color}20` }}>
                          <CatIcon name={icon} className="w-3 h-3" />
                        </div>
                        <span className="text-[11px] text-muted truncate">{name}</span>
                      </div>
                      <p className="text-sm font-bold text-foreground">{formatCurrency(total)}</p>
                      <div className="w-full bg-border rounded-full h-1 mt-1.5">
                        <div className="h-1 rounded-full" style={{ backgroundColor: color, width: `${Math.min(100, (total / todayTotal) * 100)}%` }} />
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════ ALL EXPENSES TAB ═══════ */}
      {tab === 'all' && (
        <div className="space-y-4">
          {/* Date range + filters */}
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
                <input type="search" placeholder="Search expenses..." value={searchQ} onChange={e => setSearchQ(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
                className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs focus:outline-none focus:border-accent/50">
                <option value="All">All Categories</option>
                {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <select value={filterPayment} onChange={e => setFilterPayment(e.target.value)}
                className="px-3 py-1.5 bg-surface border border-border rounded-lg text-xs focus:outline-none focus:border-accent/50">
                <option value="All">All Payments</option>
                {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
              <span className="flex items-center text-xs text-muted ml-auto">
                {filtered.length} expenses · Total: <strong className="text-red-600 ml-1">{formatCurrency(totalInRange)}</strong>
              </span>
            </div>
          </div>

          {/* Expense table */}
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Category</th>
                    <th>Description</th>
                    <th>Vendor</th>
                    <th>Payment</th>
                    <th>Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 100).map(exp => {
                    const PayIcon = PAYMENT_ICONS[exp.paymentMode] || Receipt;
                    return (
                      <tr key={exp.id}>
                        <td className="text-muted text-xs">{exp.date}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${exp.categoryColor}20` }}>
                              <CatIcon name={exp.categoryIcon} className="w-3 h-3" />
                            </div>
                            <span className="text-xs font-medium">{exp.categoryName}</span>
                          </div>
                        </td>
                        <td className="text-sm text-foreground max-w-[200px] truncate">{exp.description}</td>
                        <td className="text-xs text-muted">{exp.vendor || '—'}</td>
                        <td>
                          <span className="flex items-center gap-1 text-[11px] text-muted">
                            <PayIcon className="w-3 h-3" /> {exp.paymentMode}
                          </span>
                        </td>
                        <td className="text-sm font-bold text-red-600">{formatCurrency(exp.amount)}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            {exp.receipt && (
                              <a href={exp.receipt} target="_blank" rel="noreferrer"
                                className="p-1 text-muted hover:text-accent transition-colors" title="View receipt">
                                <Eye className="w-3.5 h-3.5" />
                              </a>
                            )}
                            {session?.user?.role === 'ADMIN' && (
                              <button onClick={() => handleEditExpense(exp)} className="p-1 text-muted hover:text-accent transition-colors" title="Edit expense">
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => handleDeleteExpense(exp)} className="p-1 text-muted hover:text-red-600 transition-colors">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && <div className="text-center py-10 text-muted text-sm">No expenses found</div>}
              {filtered.length > 100 && <div className="text-center py-3 text-xs text-muted border-t border-border">Showing first 100 of {filtered.length} results</div>}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ ANALYTICS TAB ═══════ */}
      {tab === 'analytics' && analyticsLoading && (
        <div className="glass-card py-16 text-center text-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent mx-auto mb-3" />
          <p className="text-sm">Loading analytics...</p>
        </div>
      )}
      {tab === 'analytics' && !analyticsLoading && !summary && (
        <div className="glass-card py-16 text-center text-muted">
          <PieChart className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="font-medium">No expense data for this period</p>
          <p className="text-sm mt-1">Add some expenses first or adjust the date range in the All Expenses tab</p>
        </div>
      )}
      {tab === 'analytics' && !analyticsLoading && summary && (
        <div className="space-y-4">
          {/* Top-line KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Total Spent</p>
              <p className="text-xl font-bold text-red-600">{formatCurrency(summary.grandTotal)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Daily Average</p>
              <p className="text-xl font-bold text-foreground">{formatCurrency(summary.dailyAverage)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Budget Allocated</p>
              <p className="text-xl font-bold text-accent">{formatCurrency(summary.totalBudget)}</p>
            </div>
            <div className="glass-card p-4 text-center">
              <p className="text-xs text-muted mb-1">Top Category</p>
              <p className="text-sm font-bold text-foreground truncate">{summary.categoryBreakdown[0]?.categoryName || '—'}</p>
              <p className="text-[10px] text-muted mt-0.5">{formatCurrency(summary.categoryBreakdown[0]?.total || 0)} spent</p>
            </div>
          </div>

          {/* Category breakdown chart (horizontal bars) */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-semibold text-foreground mb-4">Expense by Category</h3>
            <div className="space-y-3">
              {summary.categoryBreakdown.map(cat => (
                <div key={cat.categoryId}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${cat.categoryColor}20` }}>
                        <CatIcon name={cat.categoryIcon} className="w-3 h-3" />
                      </div>
                      <span className="text-xs font-medium text-foreground">{cat.categoryName}</span>
                      <span className="text-[10px] text-muted">({cat.count} entries)</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {cat.budget > 0 && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${cat.total > cat.budget ? 'bg-red-500/10 text-red-600' : 'bg-green-500/10 text-green-600'}`}>
                          {cat.total > cat.budget ? 'Over' : 'Under'} budget
                        </span>
                      )}
                      <span className="text-sm font-bold text-foreground">{formatCurrency(cat.total)}</span>
                    </div>
                  </div>
                  <div className="w-full bg-border rounded-full h-2">
                    <div className="h-2 rounded-full transition-all" style={{
                      backgroundColor: cat.categoryColor,
                      width: `${Math.min(100, summary.grandTotal > 0 ? (cat.total / summary.grandTotal) * 100 : 0)}%`,
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Payment mode breakdown */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Payment Mode Split</h3>
              <div className="space-y-2">
                {summary.paymentModeBreakdown.sort((a, b) => b.total - a.total).map(pm => {
                  const PayIcon = PAYMENT_ICONS[pm.mode] || Receipt;
                  return (
                    <div key={pm.mode} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        <PayIcon className="w-4 h-4 text-muted" />
                        <span className="text-sm text-foreground">{pm.mode}</span>
                        <span className="text-[10px] text-muted">({pm.count})</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] text-muted">{summary.grandTotal > 0 ? Math.round((pm.total / summary.grandTotal) * 100) : 0}%</span>
                        <span className="text-sm font-bold text-foreground w-24 text-right">{formatCurrency(pm.total)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top vendors */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Top Vendors</h3>
              {summary.topVendors.length === 0 ? (
                <p className="text-sm text-muted text-center py-6">No vendor data</p>
              ) : (
                <div className="space-y-2">
                  {summary.topVendors.slice(0, 8).map((v, i) => (
                    <div key={v.vendor} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted w-5">{i + 1}.</span>
                        <span className="text-sm text-foreground">{v.vendor}</span>
                        <span className="text-[10px] text-muted">({v.count} bills)</span>
                      </div>
                      <span className="text-sm font-bold text-foreground">{formatCurrency(v.total)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Daily trend (simple bar chart) */}
          {summary.dailyTotals.length > 0 && (
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4">Daily Spend Trend</h3>
              <div className="flex items-end gap-1 h-40 overflow-x-auto pb-6 relative">
                {(() => {
                  const maxDay = Math.max(...summary.dailyTotals.map(d => d.total), 1);
                  return summary.dailyTotals.map(d => (
                    <div key={d.date} className="flex flex-col items-center min-w-[28px] flex-1 relative group">
                      <div className="absolute -top-6 bg-foreground text-background px-1.5 py-0.5 rounded text-[9px] font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                        {formatCurrency(d.total)}
                      </div>
                      <div className="w-full rounded-t-md bg-red-500/80 hover:bg-red-500 transition-all cursor-default"
                        style={{ height: `${Math.max(4, (d.total / maxDay) * 140)}px` }} />
                      <span className="text-[8px] text-muted mt-1 absolute -bottom-5 whitespace-nowrap">{d.date.slice(5)}</span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════ BUDGET VS ACTUAL TAB ═══════ */}
      {tab === 'budget' && budgetLoading && (
        <div className="glass-card py-16 text-center text-muted">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent mx-auto mb-3" />
          <p className="text-sm">Loading budget data...</p>
        </div>
      )}
      {tab === 'budget' && !budgetLoading && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
              className="px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            <span className="text-xs text-muted">
              Total Budget: <strong className="text-accent">{formatCurrency(budgetData.reduce((s, b) => s + b.budget, 0))}</strong> ·
              Actual: <strong className="text-red-600">{formatCurrency(budgetData.reduce((s, b) => s + b.actual, 0))}</strong>
            </span>
          </div>

          <div className="glass-card overflow-hidden">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Budget</th>
                  <th>Actual</th>
                  <th>Variance</th>
                  <th>Usage</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {budgetData.filter(b => b.budget > 0 || b.actual > 0).map(b => (
                  <tr key={b.categoryId}>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${b.categoryColor}20` }}>
                          <CatIcon name={b.categoryIcon} className="w-3 h-3" />
                        </div>
                        <span className="text-sm font-medium">{b.categoryName}</span>
                      </div>
                    </td>
                    <td className="text-sm text-foreground">{formatCurrency(b.budget)}</td>
                    <td className="text-sm font-bold text-red-600">{formatCurrency(b.actual)}</td>
                    <td className={`text-sm font-medium ${b.variance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {b.variance >= 0 ? '+' : ''}{formatCurrency(b.variance)}
                    </td>
                    <td>
                      {b.budget > 0 ? (
                        <div className="flex items-center gap-2">
                          <div className="w-20 bg-border rounded-full h-2">
                            <div className={`h-2 rounded-full ${b.percent > 100 ? 'bg-red-500' : b.percent > 80 ? 'bg-amber-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(100, b.percent)}%` }} />
                          </div>
                          <span className={`text-[11px] font-medium ${b.percent > 100 ? 'text-red-600' : b.percent > 80 ? 'text-amber-600' : 'text-green-600'}`}>{b.percent}%</span>
                        </div>
                      ) : <span className="text-xs text-muted">No budget</span>}
                    </td>
                    <td>
                      <button onClick={() => { setShowBudgetEdit(b.categoryId); setBudgetVal(b.budget); }}
                        className="text-xs text-accent hover:underline">Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {budgetData.filter(b => b.budget > 0 || b.actual > 0).length === 0 && (
              <div className="text-center py-10 text-muted text-sm">No budget data. Set budgets in the Categories tab.</div>
            )}
          </div>

          {/* Over-budget alerts */}
          {budgetData.filter(b => b.budget > 0 && b.actual > b.budget).length > 0 && (
            <div className="glass-card p-4 border-l-4 border-red-500">
              <h4 className="text-sm font-semibold text-red-600 flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4" /> Over Budget Alerts
              </h4>
              <div className="space-y-1">
                {budgetData.filter(b => b.budget > 0 && b.actual > b.budget).map(b => (
                  <p key={b.categoryId} className="text-xs text-muted">
                    <strong className="text-foreground">{b.categoryName}</strong> exceeded by {formatCurrency(Math.abs(b.variance))} ({b.percent}% of budget)
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════ RECURRING TAB ═══════ */}
      {tab === 'recurring' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">{recurring.length} recurring expenses · {recurring.filter(r => r.isActive).length} active</p>
            <button onClick={() => setShowAddRecurring(true)}
              className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
              <Plus className="w-4 h-4" /> Add Recurring
            </button>
          </div>

          {recurring.length === 0 ? (
            <div className="glass-card py-16 text-center text-muted">
              <Repeat className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium">No recurring expenses</p>
              <p className="text-sm mt-1">Add monthly rent, EMIs, subscriptions etc.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {recurring.map(rec => (
                <div key={rec.id} className={`glass-card p-4 ${!rec.isActive ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${rec.categoryColor}20` }}>
                        <Repeat className="w-4 h-4" style={{ color: rec.categoryColor }} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{rec.description}</p>
                        <p className="text-[11px] text-muted">{rec.categoryName} · {rec.vendor || 'No vendor'}</p>
                      </div>
                    </div>
                    <p className="text-base font-bold text-red-600">{formatCurrency(rec.amount)}</p>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted mb-3">
                    <span className="px-2 py-0.5 bg-surface border border-border rounded-lg">{rec.frequency}</span>
                    {rec.dayOfMonth && rec.frequency === 'Monthly' && <span>Day {rec.dayOfMonth}</span>}
                    <span>{rec.paymentMode}</span>
                    <span className={`px-2 py-0.5 rounded-lg ${rec.isActive ? 'bg-green-500/10 text-green-600' : 'bg-red-500/10 text-red-600'}`}>
                      {rec.isActive ? 'Active' : 'Paused'}
                    </span>
                  </div>
              <div className="flex items-center gap-2">
                    <button onClick={async () => { await toggleRecurringExpense(rec.id); await loadData(dateRange.from, dateRange.to); }}
                      className="flex-1 py-1.5 text-xs font-medium rounded-lg border border-border hover:border-accent/30 text-muted hover:text-foreground transition-all text-center">
                      {rec.isActive ? 'Pause' : 'Resume'}
                    </button>
                    <button onClick={async () => { if (await confirmDialog('Delete?')) { await deleteRecurringExpense(rec.id); await loadData(dateRange.from, dateRange.to); } }}
                      className="py-1.5 px-3 text-xs font-medium rounded-lg bg-red-500/10 text-red-600 hover:bg-red-500/20 transition-all">
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}



      {/* ═══════ CATEGORIES TAB ═══════ */}
      {tab === 'categories' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">{categories.length} active categories</p>
            <button onClick={() => setShowAddCategory(true)}
              className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
              <Plus className="w-4 h-4" /> Add Category
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {categories.map(cat => (
              <div key={cat.id} className="glass-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${cat.color}20` }}>
                      <CatIcon name={cat.icon} className="w-4 h-4" style={{ color: cat.color }} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{cat.name}</p>
                      <p className="text-[11px] text-muted">{cat._count.expenses} expenses</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => { setShowBudgetEdit(cat.id); setBudgetVal(cat.budget); }}
                      className="p-1.5 text-muted hover:text-accent rounded-lg hover:bg-surface transition-colors" title="Edit budget">
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={async () => {
                        const actionLabel = cat._count.expenses > 0 || cat.isDefault ? 'archive' : 'delete'
                        if (await confirmDialog(`Are you sure you want to ${actionLabel} "${cat.name}"?`)) {
                          await deleteExpenseCategory(cat.id)
                          await loadData(dateRange.from, dateRange.to)
                        }
                      }}
                      className="p-1.5 text-muted hover:text-red-600 rounded-lg hover:bg-surface transition-colors"
                      title={cat._count.expenses > 0 || cat.isDefault ? 'Archive category' : 'Delete category'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-muted mt-2 pt-2 border-t border-border">
                  <span>Monthly Budget:</span>
                  <span className="font-medium text-foreground">{cat.budget > 0 ? formatCurrency(cat.budget) : 'Not set'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══════ ADD / EDIT EXPENSE MODAL ═══════ */}
      <Modal isOpen={!!expenseToDraft} onClose={cancelMoveExpenseToDraft} title="Move Expense to Draft" size="sm">
        {expenseToDraft && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Move <strong className="text-foreground">{expenseToDraft.description || `Expense #${expenseToDraft.id}`}</strong> to drafts? It will be permanently deleted after 30 days.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={cancelMoveExpenseToDraft} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
              <button onClick={confirmMoveExpenseToDraft} disabled={deletingExpense} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">
                {deletingExpense ? 'Moving...' : 'Move to Draft'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={showAddExpense} onClose={() => { setShowAddExpense(false); setEditingExpenseId(null); setExpForm({ date: today(), categoryId: '', amount: '', description: '', paymentMode: 'Cash', reference: '', vendor: '', notes: '', receipt: '' }); }} title={editingExpenseId ? "Edit Expense" : "Add Expense"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Date <span className="text-red-500">*</span></label>
              <input type="date" value={expForm.date} onChange={e => setExpForm(f => ({ ...f, date: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Category <span className="text-red-500">*</span></label>
              <select value={expForm.categoryId} onChange={e => setExpForm(f => ({ ...f, categoryId: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                <option value="">Select category</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Amount (₹) <span className="text-red-500">*</span></label>
              <input type="number" min="1" placeholder="e.g. 5000" value={expForm.amount}
                onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Payment Mode</label>
              <select value={expForm.paymentMode} onChange={e => setExpForm(f => ({ ...f, paymentMode: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Description <span className="text-red-500">*</span></label>
            <input type="text" placeholder={IS_TGM ? 'e.g. 20kg tile adhesive from supplier' : 'e.g. Teak wood 50kg from Rajesh Timber'} value={expForm.description}
              onChange={e => setExpForm(f => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Vendor / Paid To</label>
            <input type="text" placeholder={IS_TGM ? 'e.g. Marble & Granite Supplier' : 'e.g. Rajesh Timber Co.'} value={expForm.vendor}
                onChange={e => setExpForm(f => ({ ...f, vendor: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Reference / Bill No.</label>
              <input type="text" placeholder="e.g. BILL-001" value={expForm.reference}
                onChange={e => setExpForm(f => ({ ...f, reference: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Receipt (optional)</label>
            <div className="flex items-center gap-3 flex-wrap">
              {expForm.receipt && (
                <div className="relative w-20 h-20 rounded-xl overflow-hidden border border-border">
                  <img src={expForm.receipt} alt="Receipt preview" className="w-full h-full object-cover" />
                  <button type="button" onClick={clearReceipt}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
              <label className={`w-28 h-20 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center text-[11px] text-muted cursor-pointer transition-colors ${receiptUploading ? 'opacity-60 cursor-not-allowed' : 'hover:border-accent/50 hover:text-foreground'}`}>
                {receiptUploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                <span className="mt-1">{expForm.receipt ? 'Replace' : 'Upload'}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  disabled={receiptUploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    handleReceiptUpload(file);
                    e.target.value = '';
                  }}
                />
              </label>
              {expForm.receipt && (
                <a href={expForm.receipt} target="_blank" rel="noreferrer"
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-accent hover:text-accent-hover border border-border hover:border-accent/40 flex items-center gap-1">
                  <Eye className="w-3.5 h-3.5" /> View
                </a>
              )}
            </div>
            <p className="text-[10px] text-muted mt-1">JPG, PNG, WebP up to 10MB.</p>
            {receiptError && (
              <p className="text-[11px] text-red-600 mt-1">{receiptError}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Notes (optional)</label>
            <textarea rows={2} placeholder="Additional notes..." value={expForm.notes}
              onChange={e => setExpForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm resize-none focus:outline-none focus:border-accent/50" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowAddExpense(false)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">Cancel</button>
            <button onClick={handleSaveExpense} disabled={submitting || !expForm.categoryId || !expForm.amount || !expForm.description || receiptUploading}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-40">
              {submitting ? 'Saving...' : (editingExpenseId ? 'Save Changes' : 'Add Expense')}
            </button>
          </div>
        </div>
      </Modal>

      {/* ═══════ ADD CATEGORY MODAL ═══════ */}
      <Modal isOpen={showAddCategory} onClose={() => setShowAddCategory(false)} title="Add Expense Category">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Category Name <span className="text-red-500">*</span></label>
            <input type="text" placeholder="e.g. Packaging Supplies" value={catForm.name}
              onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Color</label>
              <input type="color" value={catForm.color} onChange={e => setCatForm(f => ({ ...f, color: e.target.value }))}
                className="w-full h-10 bg-surface border border-border rounded-xl cursor-pointer" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Monthly Budget (₹)</label>
              <input type="number" min="0" placeholder="0" value={catForm.budget}
                onChange={e => setCatForm(f => ({ ...f, budget: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowAddCategory(false)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground transition-colors">Cancel</button>
            <button onClick={handleAddCategory} disabled={submitting || !catForm.name}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-40">
              {submitting ? 'Creating...' : 'Create Category'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ═══════ ADD RECURRING MODAL ═══════ */}
      <Modal isOpen={showAddRecurring} onClose={() => setShowAddRecurring(false)} title="Add Recurring Expense">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Category <span className="text-red-500">*</span></label>
              <select value={recForm.categoryId} onChange={e => setRecForm(f => ({ ...f, categoryId: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                <option value="">Select</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Frequency</label>
              <select value={recForm.frequency} onChange={e => setRecForm(f => ({ ...f, frequency: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                {FREQUENCIES.map(f => <option key={f}>{f}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Description <span className="text-red-500">*</span></label>
            <input type="text" placeholder="e.g. Showroom Rent" value={recForm.description}
              onChange={e => setRecForm(f => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Amount (₹) <span className="text-red-500">*</span></label>
              <input type="number" min="1" placeholder="25000" value={recForm.amount}
                onChange={e => setRecForm(f => ({ ...f, amount: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Day of Month</label>
              <input type="number" min="1" max="31" value={recForm.dayOfMonth}
                onChange={e => setRecForm(f => ({ ...f, dayOfMonth: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Payment Mode</label>
              <select value={recForm.paymentMode} onChange={e => setRecForm(f => ({ ...f, paymentMode: e.target.value }))}
                className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                {PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Vendor / Paid To</label>
            <input type="text" placeholder="e.g. Landlord - Mr. Sharma" value={recForm.vendor}
              onChange={e => setRecForm(f => ({ ...f, vendor: e.target.value }))}
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowAddRecurring(false)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground transition-colors">Cancel</button>
            <button onClick={handleAddRecurring} disabled={submitting || !recForm.categoryId || !recForm.amount || !recForm.description}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-40">
              {submitting ? 'Creating...' : 'Create Recurring'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ═══════ EDIT BUDGET MODAL ═══════ */}
      <Modal isOpen={!!showBudgetEdit} onClose={() => setShowBudgetEdit(null)} title="Set Monthly Budget">
        <div className="space-y-4">
          <p className="text-sm text-muted">Set the monthly budget limit for this category. You&apos;ll see alerts when spending exceeds the budget.</p>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Monthly Budget (₹)</label>
            <input type="number" min="0" value={budgetVal} onChange={e => setBudgetVal(parseInt(e.target.value) || 0)}
              className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setShowBudgetEdit(null)} className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground transition-colors">Cancel</button>
            <button onClick={handleSaveBudget} className="px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
              Save Budget
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
