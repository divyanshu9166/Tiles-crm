'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search, Truck, Package, Clock, DollarSign,
  RefreshCw, Plus, Printer, X, Settings2, Edit3, Check,
  Store, Unlink, Link2, ExternalLink, Download, Trash2,
} from 'lucide-react';
import { getOrders, createOrder, updateOrderStatus } from '@/app/actions/orders';
import { Suspense } from 'react';
import { getProducts } from '@/app/actions/products';
import { getGodowns } from '@/app/actions/godowns';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import ReturningCustomerCard from '@/components/ReturningCustomerCard';
import { searchContacts, getCustomerProfile } from '@/app/actions/invoices';
import { moveOrderToDraft } from '@/app/actions/drafts';
import { useSearchParams } from 'next/navigation';
import { getActiveVertical } from '@/lib/brand';

const DEFAULT_STORE_NAME = getActiveVertical() === 'tiles' ? 'Tiles, Granite & Marble Showroom' : 'Furniture Store';

const orderStatuses = ['All', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const orderSources = ['All', 'Store', 'Shopify'];

const statusColors = {
  Confirmed: 'bg-info-light text-info',
  Processing: 'bg-accent-light text-accent',
  Shipped: 'bg-purple-light text-purple',
  Delivered: 'bg-success-light text-success',
  Cancelled: 'bg-danger-light text-danger',
};

// Next step for a store order: packing → shipped → delivered.
const NEXT_ORDER_STEP = {
  Confirmed: { status: 'PROCESSING', label: 'Start packing' },
  Processing: { status: 'SHIPPED', label: 'Mark shipped' },
  Shipped: { status: 'DELIVERED', label: 'Mark delivered' },
};

const paymentColors = {
  Paid: 'bg-success-light text-success',
  Partial: 'bg-warning-light text-warning',
  Pending: 'bg-danger-light text-danger',
};

const sourceConfig = {
  Store: { color: '#f59e0b', bg: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  Shopify: { color: '#96BF48', bg: 'bg-green-500/10 text-green-700 border-green-500/20' },
};

const DEFAULT_SLIP_TEMPLATE = {
  showroomName: '',
  showroomAddress: '',
  showroomPhone: '',
  showroomGST: '',
  footerText: 'Thank you for your purchase!',
  showOrderId: true,
  showDate: true,
  showCustomerPhone: true,
};

function getInitialSlipTemplate() {
  if (typeof window === 'undefined') return DEFAULT_SLIP_TEMPLATE;

  try {
    const saved = window.localStorage.getItem('packagingSlipTemplate');
    if (!saved) return DEFAULT_SLIP_TEMPLATE;

    const parsed = JSON.parse(saved);
    return { ...DEFAULT_SLIP_TEMPLATE, ...parsed };
  } catch {
    return DEFAULT_SLIP_TEMPLATE;
  }
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-muted">Loading orders...</div>}>
      <OrdersPageInner />
    </Suspense>
  );
}

function OrdersPageInner() {
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState([]);
  const [statusBusy, setStatusBusy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sourceFilter, setSourceFilter] = useState('All');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [products, setProducts] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [selectedGodownId, setSelectedGodownId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [orderQty, setOrderQty] = useState(1);
  const [orderCustomer, setOrderCustomer] = useState({ name: '', phone: '' });
  const [orderCustomerSuggestions, setOrderCustomerSuggestions] = useState([]);
  const [showOrderCustomerDropdown, setShowOrderCustomerDropdown] = useState(false);
  const [orderCustomerProfile, setOrderCustomerProfile] = useState(null);
  const [orderCustomerProfileLoading, setOrderCustomerProfileLoading] = useState(false);
  // Packaging slip state
  const [slipOrder, setSlipOrder] = useState(null);
  const [showSlipModal, setShowSlipModal] = useState(false);
  const [slipTemplate, setSlipTemplate] = useState(() => getInitialSlipTemplate());
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [tempTemplate, setTempTemplate] = useState(DEFAULT_SLIP_TEMPLATE);
  const slipRef = useRef(null);

  const { notify } = useAlertToast();

  const [orderToDraft, setOrderToDraft] = useState(null);
  const [deletingOrder, setDeletingOrder] = useState(false);

  useEffect(() => {
    Promise.all([getOrders(), getProducts(), getGodowns()]).then(([ordersRes, productsRes, godownsRes]) => {
      if (ordersRes.success) setOrders(ordersRes.data);
      if (productsRes.success) setProducts(productsRes.data);
      if (godownsRes.success) {
        setGodowns(godownsRes.data);
        const defaultGodown = godownsRes.data.find(g => g.isDefault) || godownsRes.data[0];
        setSelectedGodownId(defaultGodown ? String(defaultGodown.id) : '');
      }
      setLoading(false);
      
      const prefillCustomer = searchParams.get('customer');
      const prefillPhone = searchParams.get('phone');
      if (prefillCustomer && prefillPhone) {
        setOrderCustomer({ name: prefillCustomer, phone: prefillPhone });
        setShowCreateModal(true);
      }
    });
  }, [searchParams]);

  const resetOfflineOrderForm = () => {
    const defaultGodown = godowns.find(g => g.isDefault) || godowns[0];
    setSelectedProduct(null);
    setOrderQty(1);
    setOrderCustomer({ name: '', phone: '' });
    setOrderCustomerProfile(null);
    setSelectedGodownId(defaultGodown ? String(defaultGodown.id) : '');
  };

  // Load JsBarcode script once, then render barcodes when slip opens
  useEffect(() => {
    if (!window.JsBarcode && !document.getElementById('jsbarcode-script')) {
      const script = document.createElement('script');
      script.id = 'jsbarcode-script';
      script.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
      document.head.appendChild(script);
    }
  }, []);

  // Render barcode after slip modal opens
  useEffect(() => {
    if (showSlipModal && slipOrder && !editingTemplate) {
      const renderBarcodes = () => {
        try {
          const svgEls = document.querySelectorAll('.barcode-svg');
          svgEls.forEach(svg => {
            const val = svg.getAttribute('data-value');
            if (val && window.JsBarcode) {
              window.JsBarcode(svg, val, {
                format: 'CODE128', width: 2, height: 50,
                displayValue: true, fontSize: 12, margin: 4,
              });
            }
          });
        } catch {}
      };
      const timer = setTimeout(() => {
        if (window.JsBarcode) {
          renderBarcodes();
        } else {
          // Wait for script to load
          const script = document.getElementById('jsbarcode-script');
          if (script) script.onload = renderBarcodes;
        }
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [showSlipModal, slipOrder, editingTemplate]);

  const openSlipModal = useCallback((order) => {
    setSlipOrder(order);
    setShowSlipModal(true);
    setEditingTemplate(false);
  }, []);

  const saveTemplate = useCallback(() => {
    setSlipTemplate(tempTemplate);
    localStorage.setItem('packagingSlipTemplate', JSON.stringify(tempTemplate));
    setEditingTemplate(false);
  }, [tempTemplate]);

  const handlePrintSlip = useCallback(() => {
    if (!slipRef.current) return;
    const content = slipRef.current.innerHTML;
    const win = window.open('', '_blank', 'width=400,height=600');
    win.document.write(`<!DOCTYPE html><html><head><title>Packaging Slip</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; font-size: 12px; color: #000; background: #fff; padding: 16px; width: 320px; }
        .slip-header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
        .slip-header h2 { font-size: 16px; font-weight: bold; }
        .slip-header p { font-size: 11px; margin-top: 2px; }
        .slip-section { margin: 8px 0; padding: 6px 0; border-bottom: 1px dashed #aaa; }
        .slip-row { display: flex; justify-content: space-between; margin: 3px 0; font-size: 11px; }
        .slip-label { color: #555; }
        .slip-product { font-size: 13px; font-weight: bold; margin: 6px 0; }
        .barcode-wrap { text-align: center; margin: 10px 0; }
        .slip-footer { text-align: center; font-size: 10px; margin-top: 10px; color: #555; }
        @media print { body { padding: 0; } }
      </style>
    </head><body>${content}</body></html>`);
    win.document.close();
    win.focus();
    win.print();
    win.close();
  }, []);

  const handleDownloadSlip = useCallback(() => {
    if (!slipRef.current) return;
    const content = slipRef.current.innerHTML;
    const html = `<!DOCTYPE html><html><head><title>Packaging Slip - ${slipOrder?.id}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; font-size: 12px; color: #000; background: #fff; padding: 16px; width: 320px; }
        .slip-header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 10px; }
        .slip-header h2 { font-size: 16px; font-weight: bold; }
        .slip-header p { font-size: 11px; margin-top: 2px; }
        .slip-section { margin: 8px 0; padding: 6px 0; border-bottom: 1px dashed #aaa; }
        .slip-row { display: flex; justify-content: space-between; margin: 3px 0; font-size: 11px; }
        .slip-label { color: #555; }
        .slip-product { font-size: 13px; font-weight: bold; margin: 6px 0; }
        .barcode-wrap { text-align: center; margin: 10px 0; }
        .slip-footer { text-align: center; font-size: 10px; margin-top: 10px; color: #555; }
      </style>
    </head><body>${content}</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `packaging-slip-${slipOrder?.id || 'order'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [slipOrder]);

  const filtered = useMemo(() => orders.filter(o =>
    (statusFilter === 'All' || o.status === statusFilter) &&
    (sourceFilter === 'All' || o.source === sourceFilter) &&
    (o.customer.toLowerCase().includes(search.toLowerCase()) || o.id.toLowerCase().includes(search.toLowerCase()) || o.product.toLowerCase().includes(search.toLowerCase()))
  ), [statusFilter, sourceFilter, search, orders]);

  const totalRevenue = orders.filter(o => o.payment === 'Paid').reduce((s, o) => s + o.amount, 0);
  const pendingPayment = orders.filter(o => o.payment !== 'Paid').reduce((s, o) => s + o.amount, 0);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="flex gap-3">{[1,2,3,4,5].map(i => <div key={i} className="h-20 min-w-[160px] bg-surface rounded-2xl flex-1" />)}</div>
        <div className="h-64 bg-surface rounded-2xl" />
      </div>
    );
  }

  const handleOrderCustomerSearch = async (value, field) => {
    setOrderCustomer(prev => ({ ...prev, [field]: value }));
    setOrderCustomerProfile(null);
    setOrderCustomerProfileLoading(false);
    if (value.length >= 2) {
      const res = await searchContacts(value);
      if (res.success && res.data.length > 0) {
        setOrderCustomerSuggestions(res.data);
        setShowOrderCustomerDropdown(true);
      } else {
        setOrderCustomerSuggestions([]);
        setShowOrderCustomerDropdown(false);
        if (field === 'phone' && value.replace(/\D/g, '').length === 10) {
          setOrderCustomerProfileLoading(true);
          const profileRes = await getCustomerProfile(value);
          setOrderCustomerProfileLoading(false);
          if (profileRes.success && profileRes.data) setOrderCustomerProfile(profileRes.data);
        }
      }
    } else {
      setShowOrderCustomerDropdown(false);
    }
  };

  const handleMoveOrderToDraft = (order) => {
    setOrderToDraft(order);
  };

  const confirmMoveOrderToDraft = async () => {
    if (!orderToDraft) return;
    setDeletingOrder(true);
    try {
      const res = await moveOrderToDraft(orderToDraft.dbId);
      if (!res?.success) {
        notify(res?.error || 'Failed to move order to drafts', { variant: 'danger' });
        return;
      }
      const refreshed = await getOrders();
      if (refreshed.success) setOrders(refreshed.data);
      notify('Order moved to drafts', { variant: 'success' });
    } catch (err) {
      notify(err?.message || 'Failed to move order to drafts', { variant: 'danger' });
    } finally {
      setDeletingOrder(false);
      setOrderToDraft(null);
    }
  };

  const cancelMoveOrderToDraft = () => setOrderToDraft(null);

  const selectOrderCustomer = async (contact) => {
    setOrderCustomer({ name: contact.name, phone: contact.phone });
    setShowOrderCustomerDropdown(false);
    setOrderCustomerSuggestions([]);
    setOrderCustomerProfileLoading(true);
    const profileRes = await getCustomerProfile(contact.phone, contact.id);
    setOrderCustomerProfileLoading(false);
    if (profileRes.success) setOrderCustomerProfile(profileRes.data);
  };

  const handleOrderStatus = async (order, status) => {
    if (status === 'CANCELLED' && !window.confirm(`Cancel order ${order.id}? The stock goes back to the godown. This cannot be undone.`)) return;
    setStatusBusy(order.dbId);
    const res = await updateOrderStatus({ id: order.dbId, status });
    setStatusBusy(null);
    if (!res?.success) return notify(res?.error || 'Could not update the order', { variant: 'danger' });
    const label = status.charAt(0) + status.slice(1).toLowerCase();
    setOrders(prev => prev.map(o => (o.dbId === order.dbId ? { ...o, status: label } : o)));
    notify(`Order ${order.id} is now ${label}`, { variant: 'success' });
  };

  const renderStatusActions = (order) => {
    const next = NEXT_ORDER_STEP[order.status];
    if (!next) return null;
    const busy = statusBusy === order.dbId;
    return (
      <>
        <button type="button" disabled={busy} onClick={() => handleOrderStatus(order, next.status)}
          className="px-2 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 whitespace-nowrap">
          {next.label}
        </button>
        <button type="button" disabled={busy} onClick={() => handleOrderStatus(order, 'CANCELLED')}
          className="px-2 py-1.5 rounded-lg text-xs font-medium text-muted hover:text-red-700 disabled:opacity-50">
          Cancel
        </button>
      </>
    );
  };

  const getSourceBadge = (source) => {
    const config = sourceConfig[source] || sourceConfig.Store;
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${config.bg}`}>
        {source}
      </span>
    );
  };

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Orders</h1>
          <p className="text-xs md:text-sm text-muted mt-1">{orders.length} orders · ₹{(totalRevenue/1000).toFixed(0)}K collected</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { resetOfflineOrderForm(); setShowCreateModal(true); }} className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
            <Plus className="w-4 h-4" /> New Offline Order
          </button>
        </div>
      </div>


      {/* ─── ORDERS TAB ─── */}
      {(
        <>
          {/* Stats */}
          <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-1">
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-accent-light"><Package className="w-5 h-5 text-accent" /></div>
              <div><p className="text-xs text-muted">Total Orders</p><p className="text-lg font-bold text-foreground">{orders.length}</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-purple-light"><Truck className="w-5 h-5 text-purple" /></div>
              <div><p className="text-xs text-muted">In Transit</p><p className="text-lg font-bold text-foreground">{orders.filter(o => o.status === 'Shipped').length}</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-success-light"><DollarSign className="w-5 h-5 text-success" /></div>
              <div><p className="text-xs text-muted">Revenue Collected</p><p className="text-lg font-bold text-success">₹{(totalRevenue/1000).toFixed(0)}K</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-warning-light"><Clock className="w-5 h-5 text-warning" /></div>
              <div><p className="text-xs text-muted">Pending Payment</p><p className="text-lg font-bold text-warning">₹{(pendingPayment/1000).toFixed(0)}K</p></div>
            </div>
          </div>

          {/* Filters */}
          <div className="glass-card p-4 space-y-3">
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input type="search" autoComplete="off" placeholder="Search orders by customer, product, or ID..." value={search} onChange={e => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 rounded-xl border border-border text-sm focus:ring-2 focus:ring-accent/30 focus:border-accent/50 outline-none transition-all" />
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              {/* Source filter */}
              <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold flex-shrink-0">Source</span>
                <div className="flex gap-1">
                  {orderSources.map(s => (
                    <button key={s} onClick={() => { setSourceFilter(s); setStatusFilter('All'); }} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 flex-shrink-0 ${sourceFilter === s && statusFilter === 'All' ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-foreground hover:bg-surface-hover border border-transparent hover:border-border'}`}>
                      {s !== 'All' && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: sourceConfig[s]?.color }} />}
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="hidden sm:block w-px bg-border self-stretch" />
              {/* Status filter */}
              <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold flex-shrink-0">Status</span>
                <div className="flex gap-1">
                  {orderStatuses.filter(s => s !== 'All').map(s => (
                    <button key={s} onClick={() => { setStatusFilter(statusFilter === s ? 'All' : s); setSourceFilter('All'); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${statusFilter === s ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-foreground hover:bg-surface-hover border border-transparent hover:border-border'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── Mobile Card View ── */}
          <div className="md:hidden space-y-2">
            {filtered.length === 0 ? (
              <div className="text-center py-10 text-muted text-sm glass-card">No orders match your filters</div>
            ) : filtered.map(order => (
              <div key={order.id} className="glass-card p-4 active:scale-[0.99] transition-transform">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">{order.customer}</p>
                    <p className="text-xs text-muted truncate">{order.product} · Qty {order.quantity}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className={`badge ${statusColors[order.status]}`}>{order.status}</span>
                    <span className={`badge ${paymentColors[order.payment]}`}>{order.payment}</span>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-muted">{order.id}</span>
                    {getSourceBadge(order.source)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-foreground">₹{order.amount.toLocaleString()}</span>
                    {renderStatusActions(order)}
                    <button onClick={() => openSlipModal(order)} title="Print Packaging Slip"
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-surface border border-border text-muted hover:text-accent hover:border-accent/40 transition-all">
                      <Printer className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleMoveOrderToDraft(order)} title="Move to Draft"
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-700 hover:bg-red-500/20 transition-all">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* ── Desktop Table View ── */}
          <div className="hidden md:block glass-card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Source</th>
                  <th>Customer</th>
                  <th>Product</th>
                  <th>Qty</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(order => (
                  <tr key={order.id}>
                    <td className="font-mono text-accent font-medium">{order.id}</td>
                    <td>{getSourceBadge(order.source)}</td>
                    <td className="font-medium text-foreground">{order.customer}</td>
                    <td>{order.product}</td>
                    <td className="text-center">{order.quantity}</td>
                    <td className="font-semibold text-foreground">₹{order.amount.toLocaleString()}</td>
                    <td><span className={`badge ${statusColors[order.status]}`}>{order.status}</span></td>
                    <td><span className={`badge ${paymentColors[order.payment]}`}>{order.payment}</span></td>
                    <td className="text-muted">{order.date}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        {renderStatusActions(order)}
                        <button onClick={() => openSlipModal(order)} title="Print Packaging Slip"
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-surface border border-border text-muted hover:text-accent hover:border-accent/40 transition-all">
                          <Printer className="w-3.5 h-3.5" /> Slip
                        </button>
                        <button onClick={() => handleMoveOrderToDraft(order)} title="Move to Draft"
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-700 hover:bg-red-500/20 transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-center py-10 text-muted text-sm">No orders match your filters</div>
            )}
            </div>
          </div>
        </>
      )}


      {/* ─── NEW OFFLINE ORDER MODAL ─── */}
      <Modal isOpen={showCreateModal} onClose={() => { setShowCreateModal(false); resetOfflineOrderForm(); }} title="New Offline Order">
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          setSubmitting(true);
          const f = e.target;
          const qty = parseInt(f.quantity.value) || 1;
          const price = selectedProduct ? selectedProduct.price : 0;
          const res = await createOrder({
            customer: orderCustomer.name.trim() || f.customerName.value.trim(),
            phone: orderCustomer.phone.trim() || f.customerPhone.value.trim(),
            productId: selectedProduct?.id,
            quantity: qty,
            amount: price * qty,
            source: 'STORE',
            godownId: selectedGodownId ? parseInt(selectedGodownId, 10) : undefined,
            payment: f.payment.value,
            notes: f.notes.value,
          });
          if (res.success) {
            setShowCreateModal(false);
            resetOfflineOrderForm();
            const refreshed = await getOrders();
            if (refreshed.success) setOrders(refreshed.data);
          } else {
            alert(res.error || 'Failed to create order');
          }
          setSubmitting(false);
        }}>
          {/* Customer */}
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Customer Name <span className="text-red-500">*</span></label>
                <input type="text" name="customerName" required placeholder="e.g. Rahul Sharma"
                  value={orderCustomer.name}
                  onChange={e => handleOrderCustomerSearch(e.target.value, 'name')}
                  className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:outline-none focus:border-accent/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Phone Number <span className="text-red-500">*</span></label>
                <input type="tel" name="customerPhone" required placeholder="e.g. 9876543210"
                  value={orderCustomer.phone}
                  onChange={e => handleOrderCustomerSearch(e.target.value, 'phone')}
                  className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:outline-none focus:border-accent/50" />
              </div>
            </div>
            {showOrderCustomerDropdown && orderCustomerSuggestions.length > 0 && (
              <div className="bg-surface border border-border rounded-xl shadow-lg max-h-[160px] overflow-y-auto">
                {orderCustomerSuggestions.map(c => (
                  <button key={c.id} type="button" onClick={() => selectOrderCustomer(c)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover transition-colors text-left border-b border-border/50 last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                      <p className="text-xs text-muted">{c.phone}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <ReturningCustomerCard profile={orderCustomerProfile} loading={orderCustomerProfileLoading} />
          </div>

          {/* Product */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Product <span className="text-red-500">*</span></label>
            <select name="productId" required className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:outline-none focus:border-accent/50"
              onChange={e => {
                const p = products.find(p => p.id === parseInt(e.target.value));
                setSelectedProduct(p || null);
                setOrderQty(1);
              }}>
              <option value="">— Select a product —</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.name} — ₹{p.price.toLocaleString()} ({p.stock} in stock)</option>
              ))}
            </select>
          </div>

          {/* Showroom / Godown */}
          {godowns.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Showroom / Godown <span className="text-red-500">*</span></label>
              <select
                name="godownId"
                required
                value={selectedGodownId}
                onChange={e => setSelectedGodownId(e.target.value)}
                className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:outline-none focus:border-accent/50"
              >
                <option value="">— Select showroom / godown —</option>
                {godowns.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name}{g.branch?.name ? ` (${g.branch.name})` : ''}{g.isDefault ? ' · Default' : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted mt-1">Stock will be deducted from this selected location.</p>
            </div>
          )}

          {godowns.length === 0 && (
            <p className="text-[11px] text-amber-700">No showroom/godown configured yet. Stock will be deducted from overall inventory.</p>
          )}

          {/* Qty + Amount */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Quantity</label>
              <input type="number" name="quantity" min="1" max={selectedProduct?.stock || 999} value={orderQty}
                onChange={e => setOrderQty(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Total Amount</label>
              <div className="w-full px-4 py-2.5 bg-surface/50 rounded-xl border border-border text-sm font-semibold text-accent">
                {selectedProduct ? `₹${(selectedProduct.price * orderQty).toLocaleString()}` : '—'}
              </div>
            </div>
          </div>

          {/* Payment */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Payment Status</label>
            <select name="payment" className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:outline-none focus:border-accent/50">
              <option value="PENDING">Pending</option>
              <option value="PARTIAL">Partial</option>
              <option value="PAID">Paid</option>
            </select>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Notes (optional)</label>
            <textarea name="notes" rows={2} placeholder="Any special instructions..." className="w-full px-4 py-2.5 bg-surface rounded-xl border border-border text-sm resize-none focus:outline-none focus:border-accent/50" />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => { setShowCreateModal(false); resetOfflineOrderForm(); }}
              className="px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting || !selectedProduct}
              className="px-6 py-2.5 bg-accent hover:bg-accent-hover disabled:bg-accent/50 text-white rounded-xl text-sm font-semibold transition-all flex items-center gap-2">
              {submitting ? <><RefreshCw className="w-4 h-4 animate-spin" /> Creating...</> : 'Create Order'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Confirm Move Order To Draft Modal */}
      <Modal isOpen={!!orderToDraft} onClose={cancelMoveOrderToDraft} title="Move Order to Draft" size="sm">
        {orderToDraft && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Move <strong className="text-foreground">{orderToDraft.id}</strong> to drafts? It will be permanently deleted after 30 days.</p>
            <div className="flex justify-end gap-3">
              <button onClick={cancelMoveOrderToDraft} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
              <button onClick={confirmMoveOrderToDraft} disabled={deletingOrder} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{deletingOrder ? 'Moving...' : 'Move to Draft'}</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ─── PACKAGING SLIP MODAL ─── */}
      {showSlipModal && slipOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) setShowSlipModal(false); }}>
          <div className="bg-background rounded-2xl shadow-2xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-border">
              <div className="flex items-center gap-3">
                <Package className="w-5 h-5 text-accent" />
                <h2 className="text-base font-semibold text-foreground">Packaging Slip — {slipOrder.id}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { setTempTemplate({ ...slipTemplate }); setEditingTemplate(true); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground bg-surface border border-border rounded-lg transition-colors">
                  <Settings2 className="w-3.5 h-3.5" /> Edit Template
                </button>
                <button onClick={handlePrintSlip}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button onClick={handleDownloadSlip}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground bg-surface border border-border rounded-lg transition-colors">
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
                <button onClick={() => setShowSlipModal(false)} className="p-1.5 text-muted hover:text-foreground rounded-lg hover:bg-surface transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Template Editor */}
            {editingTemplate ? (
              <div className="p-5 space-y-4">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Edit3 className="w-4 h-4 text-accent" /> Edit Slip Template</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { key: 'showroomName', label: 'Showroom Name', placeholder: 'e.g. ABC Furniture' },
                    { key: 'showroomPhone', label: 'Phone', placeholder: 'e.g. +91 9876543210' },
                    { key: 'showroomGST', label: 'GST Number', placeholder: 'e.g. 27ABCDE1234F1Z5' },
                  ].map(({ key, label, placeholder }) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-muted mb-1.5">{label}</label>
                      <input type="text" placeholder={placeholder} value={tempTemplate[key] || ''}
                        onChange={e => setTempTemplate(prev => ({ ...prev, [key]: e.target.value }))}
                        className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                    </div>
                  ))}
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-muted mb-1.5">Showroom Address</label>
                    <textarea rows={2} placeholder="Full showroom address..."
                      value={tempTemplate.showroomAddress || ''}
                      onChange={e => setTempTemplate(prev => ({ ...prev, showroomAddress: e.target.value }))}
                      className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm resize-none focus:outline-none focus:border-accent/50" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-muted mb-1.5">Footer Text</label>
                    <input type="text" placeholder="e.g. Thank you for your purchase!"
                      value={tempTemplate.footerText || ''}
                      onChange={e => setTempTemplate(prev => ({ ...prev, footerText: e.target.value }))}
                      className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
                  </div>
                </div>
                <div className="flex items-center gap-4 pt-1">
                  {[
                    { key: 'showOrderId', label: 'Show Order ID' },
                    { key: 'showDate', label: 'Show Date' },
                    { key: 'showCustomerPhone', label: 'Show Customer Phone' },
                  ].map(({ key, label }) => (
                    <label key={key} className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                      <input type="checkbox" checked={!!tempTemplate[key]}
                        onChange={e => setTempTemplate(prev => ({ ...prev, [key]: e.target.checked }))}
                        className="w-4 h-4 accent-accent rounded" />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={saveTemplate}
                    className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-medium transition-colors">
                    <Check className="w-4 h-4" /> Save Template
                  </button>
                  <button onClick={() => setEditingTemplate(false)}
                    className="px-4 py-2 text-sm text-muted hover:text-foreground hover:bg-surface rounded-xl transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Slip Preview */
              <div className="p-6 flex justify-center">
                <div ref={slipRef} style={{ width: 320, fontFamily: "'Courier New', monospace", fontSize: 12, color: '#000', background: '#fff', padding: 16 }}>
                  {/* Header */}
                  <div className="slip-header" style={{ textAlign: 'center', borderBottom: '2px solid #000', paddingBottom: 8, marginBottom: 10 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 'bold' }}>{slipTemplate.showroomName || DEFAULT_STORE_NAME}</h2>
                    {slipTemplate.showroomAddress && <p style={{ fontSize: 11, marginTop: 2 }}>{slipTemplate.showroomAddress}</p>}
                    {slipTemplate.showroomPhone && <p style={{ fontSize: 11 }}>Ph: {slipTemplate.showroomPhone}</p>}
                    {slipTemplate.showroomGST && <p style={{ fontSize: 10, color: '#555' }}>GSTIN: {slipTemplate.showroomGST}</p>}
                  </div>
                  <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 'bold', letterSpacing: 1, marginBottom: 8 }}>PACKAGING SLIP</div>

                  {/* Order info */}
                  <div className="slip-section" style={{ margin: '8px 0', padding: '6px 0', borderBottom: '1px dashed #aaa' }}>
                    {slipTemplate.showOrderId && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', margin: '3px 0', fontSize: 11 }}>
                        <span style={{ color: '#555' }}>Order ID:</span>
                        <span style={{ fontWeight: 'bold' }}>{slipOrder.id}</span>
                      </div>
                    )}
                    {slipTemplate.showDate && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', margin: '3px 0', fontSize: 11 }}>
                        <span style={{ color: '#555' }}>Date:</span>
                        <span>{slipOrder.date}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', margin: '3px 0', fontSize: 11 }}>
                      <span style={{ color: '#555' }}>Customer:</span>
                      <span style={{ fontWeight: 'bold' }}>{slipOrder.customer}</span>
                    </div>
                    {slipTemplate.showCustomerPhone && slipOrder.phone && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', margin: '3px 0', fontSize: 11 }}>
                        <span style={{ color: '#555' }}>Phone:</span>
                        <span>{slipOrder.phone}</span>
                      </div>
                    )}
                  </div>

                  {/* Product */}
                  <div style={{ margin: '8px 0', padding: '6px 0', borderBottom: '1px dashed #aaa' }}>
                    <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Product</div>
                    <div style={{ fontSize: 13, fontWeight: 'bold', margin: '4px 0' }}>{slipOrder.product}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
                      <span style={{ color: '#555' }}>Qty: <strong>{slipOrder.quantity}</strong></span>
                      <span style={{ color: '#555' }}>Amount: <strong>₹{slipOrder.amount?.toLocaleString('en-IN')}</strong></span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 2 }}>
                      <span style={{ color: '#555' }}>Source:</span>
                      <span>{slipOrder.source}</span>
                    </div>
                  </div>

                  {/* Barcode */}
                  <div style={{ textAlign: 'center', margin: '12px 0' }}>
                    <svg className="barcode-svg" data-value={slipOrder.id} style={{ maxWidth: '100%' }} />
                  </div>

                  {/* Status */}
                  <div style={{ margin: '8px 0', padding: '6px 0', borderBottom: '1px dashed #aaa', display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: '#555' }}>Status:</span>
                    <span style={{ fontWeight: 'bold' }}>{slipOrder.status}</span>
                  </div>

                  {/* Footer */}
                  {slipTemplate.footerText && (
                    <div style={{ textAlign: 'center', fontSize: 10, marginTop: 12, color: '#555' }}>
                      {slipTemplate.footerText}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
