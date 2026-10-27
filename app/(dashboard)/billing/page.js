/* eslint-disable @next/next/no-img-element */
'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search, Plus, Receipt, CreditCard, Banknote,
  FileText, Printer, ShoppingBag, Mail, MessageSquare,
  Percent, Calculator, CheckCircle2, Clock, AlertCircle,
  X, Package, User, Phone, Minus, IndianRupee, MapPin,
  Trash2, Tag, Calendar, Download, Ban,
  ArrowUpRight, ArrowDownRight, TrendingUp,
  RotateCcw, PauseCircle, PlayCircle, ChevronDown,
  ChevronsUpDown, Filter, MoreHorizontal,
  Wallet, BadgeIndianRupee, CircleDollarSign,
  SplitSquareHorizontal, Eye, Edit3, XCircle, Truck, Layers,
} from 'lucide-react';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import ReturningCustomerCard from '@/components/ReturningCustomerCard';
import {
  getInvoices, getInvoice, createInvoice, updateInvoice, recordPayment,
  cancelInvoice, createCreditNote, finalizeHeldInvoice,
  searchContacts, getInvoiceStats, getCustomerProfile,
} from '@/app/actions/invoices';
import { getHsnCodes } from '@/app/actions/gst';
import { moveInvoiceToDraft } from '@/app/actions/drafts';
import { getProducts } from '@/app/actions/products';
import { getStaff } from '@/app/actions/staff';
import { getStoreSettings } from '@/app/actions/settings';
import { getStoneLots } from '@/app/actions/stone-inventory';
import { getGodowns } from '@/app/actions/godowns';
import { getPricelists, getPricesFor } from '@/app/actions/pricelists';
import { getBillableArea } from '@/lib/units';
import { chargesTax, linePrice, principalGstRate } from '@/lib/line-math';
import { getActiveVertical } from '@/lib/brand';
import { stripBankDetails } from '@/lib/quotation-notes';
import { istDate } from '@/lib/local-date';

const DEFAULT_STORE_NAME = getActiveVertical() === 'tiles' ? 'Tiles, Granite & Marble Showroom' : 'Furniture Store';

// ─── CONSTANTS ─────────────────────────────────────────

const paymentMethods = ['Cash', 'UPI', 'Card', 'EMI', 'Bank Transfer', 'Cheque'];

const paymentStatusColors = {
  Paid: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
  Partial: 'bg-amber-500/10 text-amber-700 border-amber-500/20',
  Pending: 'bg-red-500/10 text-red-700 border-red-500/20',
};

const invoiceStatusColors = {
  ACTIVE: 'bg-blue-500/10 text-blue-700 border-blue-500/20',
  CANCELLED: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  REFUNDED: 'bg-purple-500/10 text-purple-700 border-purple-500/20',
};

const paymentMethodIcons = {
  Cash: Banknote,
  UPI: Wallet,
  Card: CreditCard,
  EMI: Calculator,
  'Bank Transfer': CircleDollarSign,
  Cheque: FileText,
};

const POS_RESULT_LIMIT = 30;
const quickAmounts = [500, 1000, 2000, 5000, 10000, 20000];

const indiaStates = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
];

// ─── HELPERS ───────────────────────────────────────────

const formatCurrency = (val) => {
  if (val === 0) return '₹0';
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(val >= 10000 ? 0 : 1)}K`;
  return `₹${val.toLocaleString('en-IN')}`;
};

const formatFullCurrency = (val) => `₹${val.toLocaleString('en-IN')}`;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const normalizePhoneNumber = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  const trimmed = digits.replace(/^0+/, '');
  if (!trimmed) return '';
  if (trimmed.length === 10) return `91${trimmed}`;
  return trimmed;
};

const buildWhatsAppUrl = (phone, message) => {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return '';
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
};

const buildMailtoUrl = (email, subject, body) => {
  if (!email) return '';
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  return `mailto:${email}?${params.toString()}`;
};

const buildInvoiceShareMessage = (invoice, storeSettings) => {
  const storeName = storeSettings?.storeName || DEFAULT_STORE_NAME;
  const contactBits = [];
  if (storeSettings?.phone) contactBits.push(`Phone: ${storeSettings.phone}`);
  if (storeSettings?.whatsappNumber) contactBits.push(`WhatsApp: ${storeSettings.whatsappNumber}`);
  if (storeSettings?.email) contactBits.push(`Email: ${storeSettings.email}`);

  return [
    `Hello ${invoice?.customer || ''}`.trim(),
    `Your invoice ${invoice?.id || ''} from ${storeName}.`.trim(),
    `Total: ${formatFullCurrency(invoice?.total || 0)}`,
    invoice?.balanceDue > 0
      ? `Balance due: ${formatFullCurrency(invoice.balanceDue)}`
      : 'Status: Paid in full',
    invoice?.date ? `Date: ${invoice.date}` : null,
    contactBits.length > 0 ? `Contact: ${contactBits.join(' | ')}` : null,
  ].filter(Boolean).join('\n');
};

const normalizeHsnCode = (value) => String(value || '').replace(/\s+/g, '').toUpperCase();

/**
 * Computes the amount for a single POS/invoice line, mirroring the quotation
 * engine's area-based logic so tiles SQFT/BOX lines invoice from area while
 * furniture / per-piece (PCS) lines stay at the unchanged quantity * rate.
 *
 *   - quantity is clamped to >= 1
 *   - rate, area, and coveragePerBox are clamped to >= 0
 *   - box conversion is only attempted when coveragePerBox is a positive number
 *
 * @param {object} item - Line item (quantity, rate, and optional area/areaInput).
 * @param {object} [product] - Associated product (unitOfMeasure, coveragePerBox).
 * @returns {{ amount: number, boxes?: number, area?: number }}
 */
function computeLineAmount(item, product) {
  // Same rules as the server (lib/line-math), so the cart total is the saved total.
  return linePrice({
    quantity: item?.quantity,
    rate: item?.rate,
    unitOfMeasure: item?.unitOfMeasure || product?.unitOfMeasure || 'PCS',
    areaSqft: item?.area ?? item?.areaInput,
    coveragePerBox: item?.coveragePerBox ?? product?.coveragePerBox,
  });
}

/** POS cart adapter: cart items carry qty/price plus optional unit/coverage/area. */
function posLine(item) {
  return computeLineAmount(
    { quantity: item.qty, rate: item.price, area: item.area },
    { unitOfMeasure: item.unitOfMeasure, coveragePerBox: item.coveragePerBox }
  );
}

function invoiceLineAmount(item) {
  return computeLineAmount(
    { quantity: item.qty, rate: item.price, area: item.areaSqft },
    { unitOfMeasure: item.unitOfMeasure, coveragePerBox: item.coveragePerBox }
  ).amount;
}

function invoiceQuantityLabel(item) {
  const unit = String(item.unitOfMeasure || 'PCS').toUpperCase();
  return `${item.qty} ${unit}${item.areaSqft ? ` · ${Number(item.areaSqft).toFixed(2)} sq.ft` : ''}`;
}

const buildInvoiceFooterHtml = (store) => {
  const bankLines = [];
  if (store?.bankName) bankLines.push(`Bank: ${store.bankName}`);
  if (store?.bankAccountName) bankLines.push(`A/C Name: ${store.bankAccountName}`);
  if (store?.bankAccountNumber) bankLines.push(`A/C No: ${store.bankAccountNumber}`);
  if (store?.bankIfsc) bankLines.push(`IFSC: ${store.bankIfsc}`);
  if (store?.bankUpiId) bankLines.push(`UPI: ${store.bankUpiId}`);

  const bankBlock = bankLines.length > 0
    ? `<div class="footer-box"><h4>Bank Details</h4>${bankLines.map(line => `<div class="muted">${line}</div>`).join('')}</div>`
    : '';

  const termsText = store?.invoiceTerms ? store.invoiceTerms.replace(/\n/g, '<br/>') : '';
  const termsBlock = termsText
    ? `<div class="footer-box"><h4>Terms</h4><div class="muted">${termsText}</div></div>`
    : '';

  const qrBlock = store?.paymentQr
    ? `<div class="footer-box qr-box"><h4>Pay via QR</h4><img class="qr-img" src="${store.paymentQr}" alt="Payment QR" /></div>`
    : '';

  if (!bankBlock && !termsBlock && !qrBlock) return '';

  return `<div class="footer-grid">${bankBlock}${termsBlock}${qrBlock}</div>`;
};

// ─── MAIN COMPONENT ───────────────────────────────────

export default function BillingPage() {
  // Data state
  const [invoices, setInvoices] = useState([]);
  const [products, setProducts] = useState([]);
  const [stoneLots, setStoneLots] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [storeSettings, setStoreSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hsnCodes, setHsnCodes] = useState([]);

  // Tab & filters
  const [tab, setTab] = useState('invoices');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState('ACTIVE');
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const [sortBy, setSortBy] = useState('date-desc');

  // Modals
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showCreditNoteModal, setShowCreditNoteModal] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { session } = useSession();
  const { notify } = useAlertToast();
  const [invoiceToDraft, setInvoiceToDraft] = useState(null);
  const [movingInvoiceToDraft, setMovingInvoiceToDraft] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState(null);

  // POS state
  const [posItems, setPosItems] = useState([]);
  const [posCustomer, setPosCustomer] = useState({ name: '', phone: '', address: '', gstNumber: '' });
  const [posDiscount, setPosDiscount] = useState(0);
  const [posDiscountType, setPosDiscountType] = useState('flat');
  const [posTransportCost, setPosTransportCost] = useState(0);
  const [posFreightCharge, setPosFreightCharge] = useState(0);
  const [posLoadingCharge, setPosLoadingCharge] = useState(0);
  const [posInstallationCharge, setPosInstallationCharge] = useState(0);
  const [posRoadPermit, setPosRoadPermit] = useState('');
  const [posPayments, setPosPayments] = useState([{ amount: 0, method: 'Cash', reference: '' }]);
  const [posSalesperson, setPosSalesperson] = useState('');
  const [posNotes, setPosNotes] = useState('');
  const [posDueDate, setPosDueDate] = useState('');
  const [posSupplyType, setPosSupplyType] = useState('INTRASTATE');
  const [posPlaceOfSupply, setPosPlaceOfSupply] = useState('');
  const [posPlaceOfSupplyCustom, setPosPlaceOfSupplyCustom] = useState('');
  const [posGodownId, setPosGodownId] = useState('');
  const [pricelists, setPricelists] = useState([]);
  const [posPricelistId, setPosPricelistId] = useState('');
  const [posPricedFrom, setPosPricedFrom] = useState(null);
  const [productSearch, setProductSearch] = useState('');
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  // Mobile-only: full-screen checkout sheet toggle (no effect on md+ layout)
  const [mobileCheckoutOpen, setMobileCheckoutOpen] = useState(false);
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [customerProfile, setCustomerProfile] = useState(null);
  const [customerProfileLoading, setCustomerProfileLoading] = useState(false);
  const [heldBills, setHeldBills] = useState([]);
  const productSearchRef = useRef(null);
  const customerSearchRef = useRef(null);

  // Payment modal state
  const [paymentModalData, setPaymentModalData] = useState({ amount: '', method: 'Cash', reference: '', notes: '' });
  const [creditNoteData, setCreditNoteData] = useState({ amount: '', reason: '' });

  // ─── DATA LOADING ──────────────────────────────────────

  const loadData = useCallback(async () => {
    const [invRes, prodRes, staffRes, settingsRes, statsRes, hsnRes, stoneRes, godownRes] = await Promise.all([
      getInvoices(), getProducts(), getStaff(), getStoreSettings(), getInvoiceStats(), getHsnCodes(), getStoneLots(), getGodowns(),
    ]);
    if (invRes.success) {
      setInvoices(invRes.data);
      setHeldBills(invRes.data.filter(i => i.isHeld && i.invoiceStatus === 'ACTIVE'));
    }
    if (prodRes.success) setProducts(prodRes.data);
    if (staffRes.success) setStaffList(staffRes.data.filter(s => s.status === 'Active'));
    if (settingsRes.success) setStoreSettings(settingsRes.data);
    if (statsRes.success) setStats(statsRes.data);
    if (hsnRes.success) setHsnCodes(hsnRes.data);
    if (stoneRes.success) setStoneLots(stoneRes.data);
    if (godownRes.success) setGodowns(godownRes.data);
    setLoading(false);
    getPricelists().then(res => res.success && setPricelists(res.data.filter(list => list.active)));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void loadData(); }, 0);
    return () => clearTimeout(timer);
  }, [loadData]);

  // Lock background scroll while the mobile checkout sheet is open
  useEffect(() => {
    if (mobileCheckoutOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [mobileCheckoutOpen]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (productSearchRef.current && !productSearchRef.current.contains(e.target)) setShowProductDropdown(false);
      if (customerSearchRef.current && !customerSearchRef.current.contains(e.target)) setShowCustomerDropdown(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ─── CUSTOMER SEARCH ───────────────────────────────────

  const handleCustomerSearch = useCallback(async (value, field) => {
    setPosCustomer(prev => ({ ...prev, [field]: value }));
    setCustomerProfile(null);
    setCustomerProfileLoading(false);
    if (value.length >= 2) {
      const res = await searchContacts(value);
      if (res.success && res.data.length > 0) {
        setCustomerSuggestions(res.data);
        setShowCustomerDropdown(true);
      } else {
        setCustomerSuggestions([]);
        setShowCustomerDropdown(false);
        // Auto-lookup on exact 10-digit phone
        if (field === 'phone' && value.replace(/\D/g, '').length === 10) {
          setCustomerProfileLoading(true);
          const profileRes = await getCustomerProfile(value);
          setCustomerProfileLoading(false);
          if (profileRes.success && profileRes.data) setCustomerProfile(profileRes.data);
        }
      }
    } else {
      setShowCustomerDropdown(false);
    }
  }, []);

  const selectCustomer = async (contact) => {
    setPosCustomer({
      name: contact.name,
      phone: contact.phone,
      address: contact.address || '',
      gstNumber: contact.gstNumber || '',
    });
    setShowCustomerDropdown(false);
    setCustomerSuggestions([]);
    if (!posPricelistId) void repricePOS(posItems.filter(item => !item.slabId), { phone: contact.phone });
    setCustomerProfileLoading(true);
    const profileRes = await getCustomerProfile(contact.phone, contact.id);
    setCustomerProfileLoading(false);
    if (profileRes.success) setCustomerProfile(profileRes.data);
  };

  // ─── COMPUTED VALUES ───────────────────────────────────

  const gstRate = storeSettings?.gstRate || 18;

  const filtered = useMemo(() => {
    let result = invoices.filter(inv => {
      const matchesSearch = inv.customer.toLowerCase().includes(search.toLowerCase()) ||
        inv.id.toLowerCase().includes(search.toLowerCase()) ||
        (inv.salesperson || '').toLowerCase().includes(search.toLowerCase()) ||
        inv.phone.includes(search);
      const matchesPaymentStatus = statusFilter === 'All' || inv.paymentStatus === statusFilter;
      const matchesInvoiceStatus = invoiceStatusFilter === 'All' || inv.invoiceStatus === invoiceStatusFilter;
      const matchesDateFrom = !dateRange.from || inv.date >= dateRange.from;
      const matchesDateTo = !dateRange.to || inv.date <= dateRange.to;
      return matchesSearch && matchesPaymentStatus && matchesInvoiceStatus && matchesDateFrom && matchesDateTo;
    });

    // Sort
    switch (sortBy) {
      case 'date-asc': result.sort((a, b) => a.date.localeCompare(b.date)); break;
      case 'total-desc': result.sort((a, b) => b.total - a.total); break;
      case 'total-asc': result.sort((a, b) => a.total - b.total); break;
      case 'balance-desc': result.sort((a, b) => b.balanceDue - a.balanceDue); break;
      default: result.sort((a, b) => b.date.localeCompare(a.date)); break;
    }
    return result;
  }, [search, statusFilter, invoiceStatusFilter, dateRange, sortBy, invoices]);

  // POS calculations
  const posSubtotal = posItems.reduce((s, item) => s + posLine(item).amount, 0);
  const posDiscountAmount = posDiscountType === 'percent' ? Math.round(posSubtotal * posDiscount / 100) : Math.min(posDiscount, posSubtotal);
  const posDiscountSplits = posItems.map((item, index) => {
    if (posDiscountAmount <= 0 || posSubtotal <= 0) return 0;
    if (index === posItems.length - 1) {
      const allocated = posItems.slice(0, -1).reduce((sum, previousItem) => (
        sum + Math.round((posLine(previousItem).amount / posSubtotal) * posDiscountAmount)
      ), 0);
      return posDiscountAmount - allocated;
    }
    return Math.round((posLine(item).amount / posSubtotal) * posDiscountAmount);
  });

  const posTaxSummary = posItems.reduce((acc, item, index) => {
    const lineTotal = posLine(item).amount;
    const discountShare = posDiscountSplits[index] || 0;
    const taxableAmount = Math.max(0, lineTotal - discountShare);
    const rate = Number.isFinite(item.gstRate) ? item.gstRate : gstRate;
    const itemGst = Math.round(taxableAmount * rate / 100);
    const igst = posSupplyType === 'INTERSTATE' ? itemGst : 0;
    const cgst = posSupplyType === 'INTERSTATE' ? 0 : Math.round(itemGst / 2);
    const sgst = posSupplyType === 'INTERSTATE' ? 0 : itemGst - cgst;

    acc.taxable += taxableAmount;
    acc.totalGst += itemGst;
    acc.igst += igst;
    acc.cgst += cgst;
    acc.sgst += sgst;
    acc.lines.push({ taxable: taxableAmount, gstRate: rate });
    return acc;
  }, { taxable: 0, totalGst: 0, igst: 0, cgst: 0, sgst: 0, lines: [] });

  // Transport/freight/loading/installation carry GST at the principal line's
  // rate, exactly as the server bills them (lib/line-math).
  const posChargesTotal = (posTransportCost || 0) + (posFreightCharge || 0) + (posLoadingCharge || 0) + (posInstallationCharge || 0);
  const posChargeTax = chargesTax(posChargesTotal, principalGstRate(posTaxSummary.lines, gstRate), posSupplyType === 'INTERSTATE');
  const posTotalGst = posTaxSummary.totalGst + posChargeTax.gst;
  const posIgst = posTaxSummary.igst + posChargeTax.igst;
  const posCgst = posTaxSummary.cgst + posChargeTax.cgst;
  const posSgst = posTaxSummary.sgst + posChargeTax.sgst;
  const posTotal = posTaxSummary.taxable + posTotalGst + posChargesTotal;
  const posTotalPayments = posPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const posAdvancePaid = Math.min(posTotalPayments, posTotal);
  const posBalanceDue = Math.max(0, posTotal - posTotalPayments);

  const saleProducts = products.filter(p => p.category !== 'Raw Material');

  const filteredProducts = saleProducts.filter(p =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.sku || '').toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.category || '').toLowerCase().includes(productSearch.toLowerCase())
  );
  // Out-of-stock matches are listed (greyed out) so the cashier knows the
  // product exists but can't be sold, instead of it silently disappearing.
  const posMatches = {
    inStock: filteredProducts.filter(p => p.stock > 0),
    outOfStock: productSearch.trim() ? filteredProducts.filter(p => !(p.stock > 0)) : [],
  };

  // ─── POS ACTIONS ───────────────────────────────────────

  const resolveHsnRate = (hsnCode) => {
    const normalized = normalizeHsnCode(hsnCode);
    const match = hsnCodes.find(h => h.code === normalized);
    return match ? match.gstRate : undefined;
  };

  // Odoo pricelists at the till: the chosen list, else the customer's (by
  // phone), else the default. Manual price edits stay until the next reprice.
  const repricePOS = async (lines, { phone = posCustomer.phone, pricelistId = posPricelistId } = {}) => {
    if (pricelists.length === 0 || lines.length === 0) return;
    const res = await getPricesFor({
      pricelistId: pricelistId ? Number(pricelistId) : null,
      phone: phone?.trim() || null,
      lines: lines.map(line => ({ productId: line.productId, quantity: line.qty || 1 })),
    });
    if (!res.success) return notify(res.error, { variant: 'danger' });
    setPosPricedFrom(res.data.pricelist?.name || null);
    const byId = new Map(lines.map((line, index) => [line.id, res.data.prices[index]?.price]));
    setPosItems(current => current.map(item => (byId.get(item.id) != null ? { ...item, price: byId.get(item.id) } : item)));
  };

  const addToPOS = (product) => {
    if (product.isSlabTracked) {
      notify('Select the exact physical slab from the slab explorer before billing.', { variant: 'info' });
      return;
    }
    const existing = posItems.find(i => i.id === product.id);
    if (existing) {
      if (existing.qty < product.stock) {
        setPosItems(posItems.map(i => i.id === product.id ? { ...i, qty: i.qty + 1 } : i));
      }
    } else {
      const normalizedHsn = normalizeHsnCode(product.hsnCode || '');
      const hsnRate = resolveHsnRate(normalizedHsn);
      setPosItems([...posItems, {
        id: product.id, productId: product.id, name: product.name, sku: product.sku,
        price: product.price, qty: 1, stock: product.stock, category: product.category,
        hsnCode: normalizedHsn,
        gstRate: Number.isFinite(hsnRate) ? hsnRate : gstRate,
         unitOfMeasure: product.unitOfMeasure || 'PCS',
         coveragePerBox: product.coveragePerBox ?? null,
         area: 0,
         batches: product.batches || [],
         batchId: product.batches?.length === 1 ? product.batches[0].id : undefined,
      }]);
      void repricePOS([{ id: product.id, productId: product.id, qty: 1 }]);
    }
    setProductSearch('');
    setShowProductDropdown(false);
  };

  const addSlabToPOS = (slab, lot) => {
    const cartId = `slab-${slab.id}`;
    if (posItems.some(item => item.id === cartId)) return;
    const normalizedHsn = normalizeHsnCode(lot.product.hsnCode || '');
    const hsnRate = resolveHsnRate(normalizedHsn);
    setPosItems([...posItems, {
      id: cartId, productId: lot.product.id, slabId: slab.id,
      name: `${lot.product.name} — Slab ${slab.slabNumber}`,
      sku: lot.product.sku, price: lot.product.price, qty: 1, stock: 1,
      category: 'Stone Slab', hsnCode: normalizedHsn,
      gstRate: Number.isFinite(hsnRate) ? hsnRate : gstRate,
       unitOfMeasure: 'SLAB', coveragePerBox: null, area: slab.sqft,
       batches: [], batchId: undefined,
      slabNumber: slab.slabNumber, lotNumber: lot.lotNumber,
    }]);
  };

  const updateQty = (id, qty) => {
    if (qty < 1) return setPosItems(posItems.filter(i => i.id !== id));
    const item = posItems.find(i => i.id === id);
    if (item && qty <= item.stock) {
      setPosItems(posItems.map(i => i.id === id ? { ...i, qty } : i));
    }
  };

  const updateItemPrice = (id, newPrice) => {
    setPosItems(posItems.map(i => i.id === id ? { ...i, price: Math.max(0, newPrice) } : i));
  };

  const updateItemArea = (id, newArea) => {
    setPosItems(posItems.map(i => i.id === id ? { ...i, area: Math.max(0, Number(newArea) || 0) } : i));
  };

  const updateItemHsn = (id, hsnCode) => {
    const normalized = normalizeHsnCode(hsnCode);
    const hsnRate = resolveHsnRate(normalized);
    setPosItems(posItems.map(i => i.id === id ? {
      ...i,
      hsnCode: normalized,
      gstRate: Number.isFinite(hsnRate) ? hsnRate : i.gstRate,
    } : i));
  };

  const updateItemGstRate = (id, value) => {
    const rate = value === '' ? NaN : Number(value);
    setPosItems(posItems.map(i => i.id === id ? {
      ...i,
      gstRate: Number.isFinite(rate) ? rate : gstRate,
    } : i));
  };

  const clearPOS = () => {
    setPosItems([]);
    setMobileCheckoutOpen(false);
    setPosCustomer({ name: '', phone: '', address: '', gstNumber: '' });
    setCustomerProfile(null);
    setPosDiscount(0);
    setPosDiscountType('flat');
    setPosTransportCost(0);
    setPosFreightCharge(0);
    setPosLoadingCharge(0);
    setPosInstallationCharge(0);
    setPosRoadPermit('');
    setPosPayments([{ amount: 0, method: 'Cash', reference: '' }]);
    setPosSalesperson('');
    setPosNotes('');
    setPosDueDate('');
    setPosSupplyType('INTRASTATE');
    setPosPlaceOfSupply('');
    setPosPlaceOfSupplyCustom('');
    setPosGodownId('');
    setPosPricelistId('');
    setPosPricedFrom(null);
  };

  // Split payment management
  const addPaymentSplit = () => {
    setPosPayments([...posPayments, { amount: 0, method: 'UPI', reference: '' }]);
  };

  const updatePaymentSplit = (index, field, value) => {
    setPosPayments(posPayments.map((p, i) => i === index ? { ...p, [field]: value } : p));
  };

  const removePaymentSplit = (index) => {
    if (posPayments.length === 1) return;
    setPosPayments(posPayments.filter((_, i) => i !== index));
  };

  // Auto-fill first payment amount when total changes (only if user hasn't manually edited)
  const paymentAutoFillRef = useRef(true);
  useEffect(() => {
    if (posPayments.length === 1 && posTotal > 0 && paymentAutoFillRef.current) {
      setPosPayments([{ ...posPayments[0], amount: posTotal }]);
    }
  }, [posTotal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── GENERATE INVOICE ──────────────────────────────────

  const handleGenerateInvoice = async (isHeld = false) => {
    if (posItems.length === 0 || !posCustomer.name || !posCustomer.phone) return;
    const isEditing = !!editingInvoiceId;
    // No payment is allowed only as a credit sale with a due date.
    if (!isHeld && !isEditing && posTotalPayments === 0 && !posDueDate) return;
    setSubmitting(true);
    try {
      const placeOfSupplyValue = posPlaceOfSupply === 'OTHER'
        ? posPlaceOfSupplyCustom.trim()
        : posPlaceOfSupply;
      const paymentsData = isHeld || (posTotalPayments === 0 && posDueDate)
        ? [{ amount: 0, method: 'Cash' }]
        : posPayments.filter(p => p.amount > 0).map(p => ({
          amount: Number(p.amount),
          method: p.method,
          reference: p.reference || undefined,
        }));

      if (!isHeld && !isEditing && paymentsData.length === 0) {
        notify('Enter a payment, or set a due date to sell on credit', { variant: 'warning' });
        setSubmitting(false);
        return;
      }

      const payload = {
        customer: posCustomer.name,
        phone: posCustomer.phone,
        address: posCustomer.address || undefined,
        gstNumber: posCustomer.gstNumber || undefined,
        items: posItems.map(i => ({
          productId: i.productId || i.id,
          name: i.name,
          sku: i.sku || '',
          quantity: i.qty,
          price: i.price,
          hsnCode: i.hsnCode || undefined,
          gstRate: i.gstRate,
          unitOfMeasure: i.unitOfMeasure,
          areaSqft: i.area || undefined,
           coveragePerBox: i.coveragePerBox || undefined,
           slabId: i.slabId || undefined,
           batchId: i.batchId || undefined,
        })),
        discount: posDiscount,
        discountType: posDiscountType === 'flat' ? 'flat' : 'percent',
        transportCost: posTransportCost || 0,
        freightCharge: posFreightCharge || 0,
        loadingCharge: posLoadingCharge || 0,
        installationCharge: posInstallationCharge || 0,
        roadPermit: posRoadPermit || undefined,
        salespersonId: posSalesperson ? parseInt(posSalesperson) : undefined,
        notes: posNotes || undefined,
        dueDate: posDueDate || undefined,
        supplyType: posSupplyType,
        placeOfSupply: placeOfSupplyValue || undefined,
        godownId: posGodownId ? parseInt(posGodownId) : undefined,
        pricelistId: posPricelistId ? Number(posPricelistId) : undefined,
        isHeld,
      };

      const res = isEditing
        ? await updateInvoice(editingInvoiceId, { ...payload, payments: paymentsData.length ? paymentsData : undefined })
        : await createInvoice({ ...payload, payments: paymentsData });
      if (res.success) {
        clearPOS();
        if (isEditing) paymentAutoFillRef.current = true;
        setEditingInvoiceId(null);
        if (!isHeld || isEditing) setTab('invoices');
        await loadData();
      } else {
        notify(res.error || `Failed to ${isEditing ? 'update' : 'create'} invoice`, { variant: 'danger' });
      }
    } catch {
      notify('Something went wrong. Please try again.', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditInvoice = async (inv) => {
    if (!inv) return;
    if (session?.user?.role !== 'ADMIN') {
      notify('Admin access required to edit invoices', { variant: 'danger' });
      return;
    }

    setSubmitting(true);
    try {
      const res = await getInvoice(inv.dbId);
      if (!res.success) {
        notify(res.error || 'Failed to load invoice', { variant: 'danger' });
        return;
      }

      const invoice = res.data;
      const contact = invoice.contact || {};
      const placeValue = (invoice.placeOfSupply || '').trim();
      const dueDateValue = invoice.dueDate
        ? new Date(invoice.dueDate).toISOString().split('T')[0]
        : '';

      setPosCustomer({
        name: contact.name || inv.customer || '',
        phone: contact.phone || inv.phone || '',
        address: contact.address || inv.address || '',
        gstNumber: contact.gstNumber || inv.gstNumber || '',
      });
      setPosItems(invoice.items.map(item => {
        const stock = Math.max(item.product?.stock ?? 0, item.quantity);
        return {
          id: item.slabId ? `slab-${item.slabId}` : item.productId,
          productId: item.productId,
          slabId: item.slabId || undefined,
          name: item.name,
          sku: item.sku || '',
          price: item.price,
          qty: item.quantity,
          stock,
          category: item.product?.category || '',
          hsnCode: normalizeHsnCode(item.hsnCode || item.product?.hsnCode || ''),
          gstRate: Number.isFinite(item.gstRate) ? item.gstRate : gstRate,
          unitOfMeasure: item.unitOfMeasure || item.product?.unitOfMeasure || 'PCS',
          coveragePerBox: item.product?.coveragePerBox ?? null,
           area: item.areaSqft || 0,
           batches: products.find(product => product.id === item.productId)?.batches || [],
           batchId: item.batchId || undefined,
        };
      }));
      // The server stores the discount in rupees (even when it was entered as a
      // percent), so reload it as a flat amount: reading 1,000 back as 1,000%
      // used to wipe the whole bill.
      setPosDiscount(invoice.discount || 0);
      setPosDiscountType('flat');
      setPosTransportCost(invoice.transportCost || 0);
      setPosFreightCharge(invoice.freightCharge || 0);
      setPosLoadingCharge(invoice.loadingCharge || 0);
      setPosInstallationCharge(invoice.installationCharge || 0);
      setPosRoadPermit(invoice.roadPermit || '');
      setPosGodownId(invoice.godownId ? String(invoice.godownId) : '');
      paymentAutoFillRef.current = false;
      setPosPayments([{ amount: invoice.amountPaid || 0, method: invoice.paymentMethod || 'Cash', reference: '' }]);
      setPosSalesperson(invoice.salespersonId ? String(invoice.salespersonId) : '');
      setPosNotes(invoice.notes || '');
      setPosDueDate(dueDateValue);
      setPosSupplyType(invoice.supplyType || 'INTRASTATE');
      if (placeValue && !indiaStates.includes(placeValue)) {
        setPosPlaceOfSupply('OTHER');
        setPosPlaceOfSupplyCustom(placeValue);
      } else {
        setPosPlaceOfSupply(placeValue);
        setPosPlaceOfSupplyCustom('');
      }
      setSelectedInvoice(null);
      setEditingInvoiceId(invoice.id);
      setTab('pos');
    } catch (err) {
      notify(err?.message || 'Failed to load invoice', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  // ─── RECORD PAYMENT (Modal) ────────────────────────────

  const handleRecordPayment = async () => {
    if (!selectedInvoice || !paymentModalData.amount) return;
    if (Number(paymentModalData.amount) > Number(selectedInvoice.balanceDue || 0)) {
      notify(`Amount is more than the balance due (${formatFullCurrency(Number(selectedInvoice.balanceDue || 0))}). Return the change to the customer.`, { variant: 'warning' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await recordPayment({
        invoiceId: selectedInvoice.dbId,
        amount: Number(paymentModalData.amount),
        method: paymentModalData.method,
        reference: paymentModalData.reference || undefined,
        notes: paymentModalData.notes || undefined,
      });
      if (res.success) {
        setShowPaymentModal(false);
        setPaymentModalData({ amount: '', method: 'Cash', reference: '', notes: '' });
        await loadData();
        // Refresh selected invoice
        const updated = (await getInvoices()).data?.find(i => i.dbId === selectedInvoice.dbId);
        if (updated) setSelectedInvoice(updated);
        notify('Payment recorded', { variant: 'success' });
      } else {
        notify(res.error || 'Failed to record payment', { variant: 'danger' });
      }
    } catch {
      notify('Something went wrong', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  // ─── CANCEL INVOICE ────────────────────────────────────

  const handleCancelInvoice = async () => {
    if (!selectedInvoice) return;
    setSubmitting(true);
    try {
      const res = await cancelInvoice(selectedInvoice.dbId);
      if (res.success) {
        setShowCancelConfirm(false);
        setSelectedInvoice(null);
        await loadData();
      } else {
        notify(res.error || 'Failed to cancel invoice', { variant: 'danger' });
      }
    } catch {
      notify('Something went wrong', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleMoveInvoiceToDraft = () => {
    if (!selectedInvoice) return;
    setInvoiceToDraft(selectedInvoice);
  };

  const confirmMoveInvoiceToDraft = async () => {
    if (!invoiceToDraft) return;
    setMovingInvoiceToDraft(true);
    setSubmitting(true);
    try {
      const res = await moveInvoiceToDraft(invoiceToDraft.dbId);
      if (res.success) {
        setShowCancelConfirm(false);
        setSelectedInvoice(null);
        notify('Invoice moved to drafts', { variant: 'success' });
        await loadData();
      } else {
        notify(res.error || 'Failed to move invoice to drafts', { variant: 'danger' });
      }
    } catch (err) {
      notify(err?.message || 'Something went wrong', { variant: 'danger' });
    } finally {
      setSubmitting(false);
      setMovingInvoiceToDraft(false);
      setInvoiceToDraft(null);
    }
  };

  // ─── CREATE CREDIT NOTE ────────────────────────────────

  const handleCreateCreditNote = async () => {
    if (!selectedInvoice || !creditNoteData.amount || !creditNoteData.reason) return;
    setSubmitting(true);
    try {
      const res = await createCreditNote({
        invoiceId: selectedInvoice.dbId,
        amount: Number(creditNoteData.amount),
        reason: creditNoteData.reason,
      });
      if (res.success) {
        setShowCreditNoteModal(false);
        setCreditNoteData({ amount: '', reason: '' });
        await loadData();
        const updated = (await getInvoices()).data?.find(i => i.dbId === selectedInvoice.dbId);
        if (updated) setSelectedInvoice(updated);
      } else {
        notify(res.error || 'Failed to create credit note', { variant: 'danger' });
      }
    } catch {
      notify('Something went wrong', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  // ─── FINALIZE HELD BILL ────────────────────────────────

  const handleFinalizeHeld = async (inv) => {
    setSubmitting(true);
    try {
      const res = await finalizeHeldInvoice(inv.dbId);
      if (res.success) await loadData();
      else notify(res.error || 'Failed to finalize', { variant: 'danger' });
    } catch {
      notify('Something went wrong', { variant: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  // ─── EXPORT CSV ────────────────────────────────────────

  const handleExportCSV = () => {
    const headers = ['Invoice ID', 'Date', 'Customer', 'Phone', 'Items', 'Subtotal', 'Discount', 'GST', 'CGST', 'SGST', 'IGST', 'Total', 'Amount Paid', 'Balance Due', 'Payment Method', 'Payment Status', 'Invoice Status', 'Supply Type', 'Salesperson', 'Notes'];
    const rows = filtered.map(inv => [
      inv.id, inv.date, `"${inv.customer}"`, inv.phone,
      `"${inv.items.map(i => `${i.name} x${i.qty}`).join(', ')}"`,
      inv.subtotal, inv.discount, inv.gst, inv.cgst, inv.sgst, inv.igst || 0, inv.total,
      inv.amountPaid, inv.balanceDue, inv.paymentMethod, inv.paymentStatus,
      inv.invoiceStatus, inv.supplyType || '', inv.salesperson || '', `"${inv.notes || ''}"`,
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoices_${istDate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── html2pdf LOADER (loads once into main document — works on iOS/Android) ─

  const loadHtml2Pdf = () => new Promise((resolve, reject) => {
    if (window.html2pdf) { resolve(window.html2pdf); return; }
    const existing = document.querySelector('script[data-html2pdf]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.html2pdf));
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    script.setAttribute('data-html2pdf', '1');
    script.onload = () => resolve(window.html2pdf);
    script.onerror = () => reject(new Error('Failed to load html2pdf.js'));
    document.head.appendChild(script);
  });

  // ─── PRINT INVOICE ─────────────────────────────────────

  const handlePrintInvoice = (inv) => {

    const store = storeSettings || {};
    const isInterstate = inv.supplyType === 'INTERSTATE' || (inv.igst && inv.igst > 0);
    const invoiceFooter = buildInvoiceFooterHtml(store);
    const printContent = `
      <html><head><title>Invoice ${inv.id}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; color: #1a1a1a; }
        @page { size: A4; margin: 12mm; }
        .invoice-container { width: 100%; max-width: 186mm; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; margin-bottom: 20px; }
        .store-name { font-size: 22px; font-weight: 700; color: #b45309; }
        .invoice-id { font-size: 18px; font-weight: 700; text-align: right; }
        .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
        .meta-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; table-layout: fixed; }
        th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #e5e5e5; font-size: 11px; text-transform: uppercase; color: #888; }
        td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; font-size: 13px; word-break: break-word; }
        .totals { margin-left: auto; width: 300px; }
        .totals .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; }
        .totals .grand { border-top: 2px solid #1a1a1a; padding-top: 10px; font-size: 16px; font-weight: 700; }
        .totals .paid { color: #15803d; }
        .totals .due { color: #b91c1c; font-weight: 600; }
        .payments { margin-top: 16px; padding: 12px; background: #f9fafb; border-radius: 8px; }
        .payments h4 { font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 8px; letter-spacing: 0.5px; }
        .payments .entry { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
        .footer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
        .footer-box { border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px; font-size: 11px; }
        .footer-box h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: 0.5px; }
        .footer-box .muted { color: #555; margin-top: 2px; }
        .qr-box { text-align: center; }
        .qr-img { width: 110px; height: 110px; object-fit: contain; }
        .footer { border-top: 1px solid #e5e5e5; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #888; text-align: center; }
        @media print { body { padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style></head><body>
      <div class="invoice-container">
      <div class="header">
        <div><div class="store-name">${store.storeName || DEFAULT_STORE_NAME}</div>
        <div style="font-size:12px;color:#888;margin-top:4px">${store.address || ''}</div>
        <div style="font-size:12px;color:#888">${store.phone || ''} ${store.email ? '· ' + store.email : ''}</div>
        ${store.gstNumber ? `<div style="font-size:12px;color:#888;margin-top:2px">GSTIN: ${store.gstNumber}</div>` : ''}</div>
        <div><div class="invoice-id">${inv.id}</div>
        <div style="font-size:12px;color:#888;text-align:right;margin-top:4px">${inv.date}${inv.time ? ' · ' + inv.time : ''}</div>
        ${inv.invoiceStatus !== 'ACTIVE' ? `<div style="font-size:12px;color:#b91c1c;text-align:right;font-weight:600;margin-top:4px">${inv.invoiceStatus}</div>` : ''}</div>
      </div>
      <div class="meta">
        <div><div class="meta-label">Bill To</div><div style="font-weight:600;margin-top:4px">${inv.customer}</div><div style="font-size:12px;color:#888">${inv.phone || ''}</div>${inv.address ? `<div style="font-size:12px;color:#888;margin-top:2px">${inv.address}</div>` : ''}${inv.gstNumber ? `<div style="font-size:12px;color:#888;margin-top:2px">GSTIN: ${inv.gstNumber}</div>` : ''}</div>
        <div style="text-align:right"><div class="meta-label">Payment</div><div style="margin-top:4px">${inv.paymentMethod} · <strong>${inv.paymentStatus}</strong></div>
        ${inv.placeOfSupply ? `<div style="font-size:12px;color:#888;margin-top:2px">Place of Supply: ${inv.placeOfSupply}</div>` : ''}
        ${inv.dueDate ? `<div style="font-size:12px;color:#888;margin-top:2px">Due: ${inv.dueDate}</div>` : ''}</div>
      </div>
      <table><thead><tr><th>#</th><th>Item</th><th>SKU</th><th>HSN</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead><tbody>
      ${inv.items.map((item, i) => `<tr><td>${i + 1}</td><td>${item.name}</td><td style="font-family:monospace;font-size:11px;color:#888">${item.sku || '-'}</td><td style="font-size:11px;color:#888">${item.hsnCode || '-'}</td><td style="text-align:center">${invoiceQuantityLabel(item)}</td><td style="text-align:right">₹${item.price.toLocaleString('en-IN')}</td><td style="text-align:right;font-weight:500">₹${invoiceLineAmount(item).toLocaleString('en-IN')}</td></tr>`).join('')}
      </tbody></table>
      <div class="totals">
        <div class="row"><span>Subtotal</span><span>₹${inv.subtotal.toLocaleString('en-IN')}</span></div>
        ${inv.discount > 0 ? `<div class="row"><span>Discount</span><span style="color:#16a34a">-₹${inv.discount.toLocaleString('en-IN')}</span></div>` : ''}
        ${isInterstate
        ? `<div class="row"><span>IGST</span><span>₹${(inv.igst || 0).toLocaleString('en-IN')}</span></div>`
        : `<div class="row"><span>CGST</span><span>₹${inv.cgst.toLocaleString('en-IN')}</span></div>
             <div class="row"><span>SGST</span><span>₹${inv.sgst.toLocaleString('en-IN')}</span></div>`}
        ${inv.transportCost > 0 ? `<div class="row"><span>Transport Cost</span><span>₹${inv.transportCost.toLocaleString('en-IN')}</span></div>` : ''}
        ${inv.freightCharge > 0 ? `<div class="row"><span>Freight</span><span>₹${inv.freightCharge.toLocaleString('en-IN')}</span></div>` : ''}
        ${inv.loadingCharge > 0 ? `<div class="row"><span>Loading / Unloading</span><span>₹${inv.loadingCharge.toLocaleString('en-IN')}</span></div>` : ''}
        ${inv.installationCharge > 0 ? `<div class="row"><span>Installation / Fabrication</span><span>₹${inv.installationCharge.toLocaleString('en-IN')}</span></div>` : ''}
        ${inv.roadPermit ? `<div class="row"><span>Road Permit</span><span>${escapeHtml(inv.roadPermit)}</span></div>` : ''}
        <div class="row grand"><span>Total</span><span>₹${inv.total.toLocaleString('en-IN')}</span></div>
        <div class="row paid"><span>Amount Paid</span><span>₹${inv.amountPaid.toLocaleString('en-IN')}</span></div>
        ${inv.balanceDue > 0 ? `<div class="row due"><span>Balance Due</span><span>₹${inv.balanceDue.toLocaleString('en-IN')}</span></div>` : ''}
      </div>
      ${inv.payments && inv.payments.length > 0 ? `<div class="payments"><h4>Payment History</h4>${inv.payments.map(p => `<div class="entry"><span>${p.method}${p.reference ? ' · ' + p.reference : ''} — ${p.date}</span><span>₹${p.amount.toLocaleString('en-IN')}</span></div>`).join('')}</div>` : ''}
      ${inv.notes ? `<div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px;font-size:12px;color:#666">Notes: ${escapeHtml(stripBankDetails(inv.notes))}</div>` : ''}
      ${invoiceFooter}
      <div class="footer">Thank you for your purchase!</div>
      </div>
      </body></html>`;
    const printFrame = document.createElement('iframe');
    printFrame.style.position = 'fixed';
    printFrame.style.right = '0';
    printFrame.style.bottom = '0';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    printFrame.onload = () => {
      const win = printFrame.contentWindow;
      if (!win) return;
      win.document.title = `Invoice ${inv.id}`;
      win.focus();
      win.print();
      setTimeout(() => {
        printFrame.remove();
      }, 500);
    };
    printFrame.srcdoc = printContent;
    document.body.appendChild(printFrame);
  };

  const handleDownloadInvoice = (inv) => {
    const store = storeSettings || {};
    const isInterstate = inv.supplyType === 'INTERSTATE' || (inv.igst && inv.igst > 0);
    const invoiceFooter = buildInvoiceFooterHtml(store);
    const printContent = `
      <html><head><title>Invoice ${inv.id}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; color: #1a1a1a; }
        @page { size: A4; margin: 12mm; }
        .invoice-container { width: 100%; max-width: 186mm; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; margin-bottom: 20px; }
        .store-name { font-size: 22px; font-weight: 700; color: #b45309; }
        .invoice-id { font-size: 18px; font-weight: 700; text-align: right; }
        .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
        .meta-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; table-layout: fixed; }
        th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #e5e5e5; font-size: 11px; text-transform: uppercase; color: #888; }
        td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; font-size: 13px; word-break: break-word; }
        .totals { margin-left: auto; width: 300px; }
        .totals .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; }
        .totals .grand { border-top: 2px solid #1a1a1a; padding-top: 10px; font-size: 16px; font-weight: 700; }
        .totals .paid { color: #15803d; }
        .totals .due { color: #b91c1c; font-weight: 600; }
        .payments { margin-top: 16px; padding: 12px; background: #f9fafb; border-radius: 8px; }
        .payments h4 { font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 8px; letter-spacing: 0.5px; }
        .payments .entry { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
        .footer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
        .footer-box { border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px; font-size: 11px; }
        .footer-box h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: 0.5px; }
        .footer-box .muted { color: #555; margin-top: 2px; }
        .qr-box { text-align: center; }
        .qr-img { width: 110px; height: 110px; object-fit: contain; }
        .footer { border-top: 1px solid #e5e5e5; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #888; text-align: center; }
      </style></head><body>
      <div class="invoice-container">
        <div class="header">
          <div><div class="store-name">${store.storeName || DEFAULT_STORE_NAME}</div>
          <div style="font-size:12px;color:#888;margin-top:4px">${store.address || ''}</div>
          <div style="font-size:12px;color:#888">${store.phone || ''} ${store.email ? '· ' + store.email : ''}</div>
          ${store.gstNumber ? `<div style="font-size:12px;color:#888;margin-top:2px">GSTIN: ${store.gstNumber}</div>` : ''}</div>
          <div><div class="invoice-id">${inv.id}</div>
          <div style="font-size:12px;color:#888;text-align:right;margin-top:4px">${inv.date}${inv.time ? ' · ' + inv.time : ''}</div>
          ${inv.invoiceStatus !== 'ACTIVE' ? `<div style="font-size:12px;color:#b91c1c;text-align:right;font-weight:600;margin-top:4px">${inv.invoiceStatus}</div>` : ''}</div>
        </div>
        <div class="meta">
          <div><div class="meta-label">Bill To</div><div style="font-weight:600;margin-top:4px">${inv.customer}</div><div style="font-size:12px;color:#888">${inv.phone || ''}</div>${inv.address ? `<div style="font-size:12px;color:#888;margin-top:2px">${inv.address}</div>` : ''}${inv.gstNumber ? `<div style="font-size:12px;color:#888;margin-top:2px">GSTIN: ${inv.gstNumber}</div>` : ''}</div>
          <div style="text-align:right"><div class="meta-label">Payment</div><div style="margin-top:4px">${inv.paymentMethod} · <strong>${inv.paymentStatus}</strong></div>
          ${inv.placeOfSupply ? `<div style="font-size:12px;color:#888;margin-top:2px">Place of Supply: ${inv.placeOfSupply}</div>` : ''}
          ${inv.dueDate ? `<div style="font-size:12px;color:#888;margin-top:2px">Due: ${inv.dueDate}</div>` : ''}</div>
        </div>
        <table><thead><tr><th>#</th><th>Item</th><th>SKU</th><th>HSN</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead><tbody>
        ${inv.items.map((item, i) => `<tr><td>${i + 1}</td><td>${item.name}</td><td style="font-family:monospace;font-size:11px;color:#888">${item.sku || '-'}</td><td style="font-size:11px;color:#888">${item.hsnCode || '-'}</td><td style="text-align:center">${invoiceQuantityLabel(item)}</td><td style="text-align:right">₹${item.price.toLocaleString('en-IN')}</td><td style="text-align:right;font-weight:500">₹${invoiceLineAmount(item).toLocaleString('en-IN')}</td></tr>`).join('')}
        </tbody></table>
        <div class="totals">
          <div class="row"><span>Subtotal</span><span>₹${inv.subtotal.toLocaleString('en-IN')}</span></div>
          ${inv.discount > 0 ? `<div class="row"><span>Discount</span><span style="color:#16a34a">-₹${inv.discount.toLocaleString('en-IN')}</span></div>` : ''}
          ${isInterstate
        ? `<div class="row"><span>IGST</span><span>₹${(inv.igst || 0).toLocaleString('en-IN')}</span></div>`
        : `<div class="row"><span>CGST</span><span>₹${inv.cgst.toLocaleString('en-IN')}</span></div>
               <div class="row"><span>SGST</span><span>₹${inv.sgst.toLocaleString('en-IN')}</span></div>`}
          ${inv.transportCost > 0 ? `<div class="row"><span>Transport Cost</span><span>₹${inv.transportCost.toLocaleString('en-IN')}</span></div>` : ''}
          ${inv.freightCharge > 0 ? `<div class="row"><span>Freight</span><span>₹${inv.freightCharge.toLocaleString('en-IN')}</span></div>` : ''}
          ${inv.loadingCharge > 0 ? `<div class="row"><span>Loading / Unloading</span><span>₹${inv.loadingCharge.toLocaleString('en-IN')}</span></div>` : ''}
          ${inv.installationCharge > 0 ? `<div class="row"><span>Installation / Fabrication</span><span>₹${inv.installationCharge.toLocaleString('en-IN')}</span></div>` : ''}
          ${inv.roadPermit ? `<div class="row"><span>Road Permit</span><span>${escapeHtml(inv.roadPermit)}</span></div>` : ''}
          <div class="row grand"><span>Total</span><span>₹${inv.total.toLocaleString('en-IN')}</span></div>
          <div class="row paid"><span>Amount Paid</span><span>₹${inv.amountPaid.toLocaleString('en-IN')}</span></div>
          ${inv.balanceDue > 0 ? `<div class="row due"><span>Balance Due</span><span>₹${inv.balanceDue.toLocaleString('en-IN')}</span></div>` : ''}
        </div>
        ${inv.payments && inv.payments.length > 0 ? `<div class="payments"><h4>Payment History</h4>${inv.payments.map(p => `<div class="entry"><span>${p.method}${p.reference ? ' · ' + p.reference : ''} — ${p.date}</span><span>₹${p.amount.toLocaleString('en-IN')}</span></div>`).join('')}</div>` : ''}
        ${inv.notes ? `<div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px;font-size:12px;color:#666">Notes: ${escapeHtml(stripBankDetails(inv.notes))}</div>` : ''}
        ${invoiceFooter}
        <div class="footer">Thank you for your purchase!</div>
      </div>
      </body></html>`;

    // Use div in main document (not iframe) — works on iOS Safari & Android Chrome
    loadHtml2Pdf().then(html2pdf => {
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;background:#fff;z-index:-1;';
      container.innerHTML = printContent;
      document.body.appendChild(container);

      const element = container.querySelector('.invoice-container') || container;
      const opt = {
        margin: 0.2,
        filename: `Invoice_${inv.id}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, allowTaint: true },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
      };

      html2pdf().set(opt).from(element).save().then(() => {
        document.body.removeChild(container);
      }).catch(() => {
        document.body.removeChild(container);
      });
    }).catch(() => {
      // Fallback: open print dialog
      handlePrintInvoice(inv);
    });
  };


  const handleShareInvoiceWhatsApp = (inv) => {
    if (!inv?.phone) {
      notify('Customer phone number is missing', { variant: 'danger' });
      return;
    }

    const message = buildInvoiceShareMessage(inv, storeSettings) + '\n\n*(Invoice PDF is attached)*';
    const invoiceFooter = buildInvoiceFooterHtml(storeSettings || {});

    if (navigator.share && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      notify('Preparing PDF for sharing...', { variant: 'info' });
      const element = document.createElement('div');
      element.style.cssText = 'width:794px;background:#fff;';
      element.innerHTML = `
        <html><head><title>Invoice ${inv.id}</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; color: #1a1a1a; }
          @page { size: A4; margin: 12mm; }
          .invoice-container { width: 100%; max-width: 186mm; margin: 0 auto; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #e5e5e5; padding-bottom: 20px; margin-bottom: 20px; }
          .store-name { font-size: 22px; font-weight: 700; color: #b45309; }
          .invoice-id { font-size: 18px; font-weight: 700; text-align: right; }
          .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
          .meta-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 16px; table-layout: fixed; }
          th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #e5e5e5; font-size: 11px; text-transform: uppercase; color: #888; }
          td { padding: 10px 8px; border-bottom: 1px solid #f0f0f0; font-size: 13px; word-break: break-word; }
          .totals { margin-left: auto; width: 300px; }
          .totals .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 13px; }
          .totals .grand { border-top: 2px solid #1a1a1a; padding-top: 10px; font-size: 16px; font-weight: 700; }
          .totals .paid { color: #15803d; }
          .totals .due { color: #b91c1c; font-weight: 600; }
          .payments { margin-top: 16px; padding: 12px; background: #f9fafb; border-radius: 8px; }
          .payments h4 { font-size: 11px; text-transform: uppercase; color: #888; margin-bottom: 8px; letter-spacing: 0.5px; }
          .payments .entry { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
          .footer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
          .footer-box { border: 1px solid #e5e5e5; border-radius: 8px; padding: 10px; font-size: 11px; }
          .footer-box h4 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; color: #888; letter-spacing: 0.5px; }
          .footer-box .muted { color: #555; margin-top: 2px; }
          .qr-box { text-align: center; }
          .qr-img { width: 110px; height: 110px; object-fit: contain; }
          .footer { border-top: 1px solid #e5e5e5; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #888; text-align: center; }
        </style></head><body>
        <div class="invoice-container">
          <div class="header">
            <div><div class="store-name">${storeSettings?.storeName || DEFAULT_STORE_NAME}</div>
            <div style="font-size:12px;color:#888;margin-top:4px">${storeSettings?.address || ''}</div>
            <div style="font-size:12px;color:#888">${storeSettings?.phone || ''} ${storeSettings?.email ? '· ' + storeSettings?.email : ''}</div>
            ${storeSettings?.gstNumber ? `<div style="font-size:12px;color:#888;margin-top:2px">GSTIN: ${storeSettings.gstNumber}</div>` : ''}</div>
            <div><div class="invoice-id">${inv.id}</div>
            <div style="font-size:12px;color:#888;text-align:right;margin-top:4px">${inv.date}${inv.time ? ' · ' + inv.time : ''}</div>
            ${inv.invoiceStatus !== 'ACTIVE' ? `<div style="font-size:12px;color:#b91c1c;text-align:right;font-weight:600;margin-top:4px">${inv.invoiceStatus}</div>` : ''}</div>
          </div>
          <div class="meta">
            <div><div class="meta-label">Bill To</div><div style="font-weight:600;margin-top:4px">${inv.customer}</div><div style="font-size:12px;color:#888">${inv.phone || ''}</div>${inv.address ? `<div style="font-size:12px;color:#888;margin-top:2px">${inv.address}</div>` : ''}${inv.gstNumber ? `<div style="font-size:12px;color:#888;margin-top:2px">GSTIN: ${inv.gstNumber}</div>` : ''}</div>
            <div style="text-align:right"><div class="meta-label">Payment</div><div style="margin-top:4px">${inv.paymentMethod} · <strong>${inv.paymentStatus}</strong></div>
            ${inv.placeOfSupply ? `<div style="font-size:12px;color:#888;margin-top:2px">Place of Supply: ${inv.placeOfSupply}</div>` : ''}
            ${inv.dueDate ? `<div style="font-size:12px;color:#888;margin-top:2px">Due: ${inv.dueDate}</div>` : ''}</div>
          </div>
          <table><thead><tr><th>#</th><th>Item</th><th>SKU</th><th>HSN</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead><tbody>
          ${inv.items.map((item, i) => `<tr><td>${i + 1}</td><td>${item.name}</td><td style="font-family:monospace;font-size:11px;color:#888">${item.sku || '-'}</td><td style="font-size:11px;color:#888">${item.hsnCode || '-'}</td><td style="text-align:center">${invoiceQuantityLabel(item)}</td><td style="text-align:right">₹${item.price.toLocaleString('en-IN')}</td><td style="text-align:right;font-weight:500">₹${invoiceLineAmount(item).toLocaleString('en-IN')}</td></tr>`).join('')}
          </tbody></table>
          <div class="totals">
            <div class="row"><span>Subtotal</span><span>₹${inv.subtotal.toLocaleString('en-IN')}</span></div>
            ${inv.discount > 0 ? `<div class="row"><span>Discount</span><span style="color:#16a34a">-₹${inv.discount.toLocaleString('en-IN')}</span></div>` : ''}
            ${(inv.supplyType === 'INTERSTATE' || (inv.igst && inv.igst > 0))
          ? `<div class="row"><span>IGST</span><span>₹${(inv.igst || 0).toLocaleString('en-IN')}</span></div>`
          : `<div class="row"><span>CGST</span><span>₹${inv.cgst.toLocaleString('en-IN')}</span></div>
                 <div class="row"><span>SGST</span><span>₹${inv.sgst.toLocaleString('en-IN')}</span></div>`}
            ${inv.transportCost > 0 ? `<div class="row"><span>Transport Cost</span><span>₹${inv.transportCost.toLocaleString('en-IN')}</span></div>` : ''}
            ${inv.freightCharge > 0 ? `<div class="row"><span>Freight</span><span>₹${inv.freightCharge.toLocaleString('en-IN')}</span></div>` : ''}
            ${inv.loadingCharge > 0 ? `<div class="row"><span>Loading / Unloading</span><span>₹${inv.loadingCharge.toLocaleString('en-IN')}</span></div>` : ''}
            ${inv.installationCharge > 0 ? `<div class="row"><span>Installation / Fabrication</span><span>₹${inv.installationCharge.toLocaleString('en-IN')}</span></div>` : ''}
            ${inv.roadPermit ? `<div class="row"><span>Road Permit</span><span>${escapeHtml(inv.roadPermit)}</span></div>` : ''}
            <div class="row grand"><span>Total</span><span>₹${inv.total.toLocaleString('en-IN')}</span></div>
            <div class="row paid"><span>Amount Paid</span><span>₹${inv.amountPaid.toLocaleString('en-IN')}</span></div>
            ${inv.balanceDue > 0 ? `<div class="row due"><span>Balance Due</span><span>₹${inv.balanceDue.toLocaleString('en-IN')}</span></div>` : ''}
          </div>
          ${inv.payments && inv.payments.length > 0 ? `<div class="payments"><h4>Payment History</h4>${inv.payments.map(p => `<div class="entry"><span>${p.method}${p.reference ? ' · ' + p.reference : ''} — ${p.date}</span><span>₹${p.amount.toLocaleString('en-IN')}</span></div>`).join('')}</div>` : ''}
          ${inv.notes ? `<div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px;font-size:12px;color:#666">Notes: ${escapeHtml(stripBankDetails(inv.notes))}</div>` : ''}
          ${invoiceFooter}
          <div class="footer">Thank you for your purchase!</div>
        </div>
        </body></html>
      `;

      const opt = {
        margin: 0.2,
        filename: 'Invoice_${inv.id}.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
      };

      html2pdf().set(opt).from(element).outputPdf('blob').then(async (pdfBlob) => {
        const file = new File([pdfBlob], 'Invoice_${inv.id}.pdf', { type: 'application/pdf' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Invoice ${inv.id}',
              text: buildInvoiceShareMessage(inv, storeSettings)
            });
            return;
          } catch (err) {
            console.warn('Share failed', err);
          }
        }
        fallbackShareInvoice(inv, message);
      });
    } else {
      fallbackShareInvoice(inv, message);
    }
  };

  const fallbackShareInvoice = (inv, message) => {
    handleDownloadInvoice(inv);
    notify('PDF downloaded! Please attach it to the WhatsApp chat.', { variant: 'success' });
    const url = buildWhatsAppUrl(inv.phone, message);
    setTimeout(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    }, 600);
  };

  const handleShareInvoiceEmail = (inv) => {
    if (!inv?.email) {
      notify('Customer email is missing', { variant: 'danger' });
      return;
    }
    const subject = `Invoice ${inv.id} from ${storeSettings?.storeName || DEFAULT_STORE_NAME}`;
    const body = buildInvoiceShareMessage(inv, storeSettings);
    const url = buildMailtoUrl(inv.email, subject, body);
    if (!url) return;
    window.location.href = url;
  };

  // ─── LOADING STATE ─────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-surface rounded-lg" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-surface rounded-2xl" />)}</div>
        <div className="h-64 bg-surface rounded-2xl" />
      </div>
    );
  }

  // ─── RENDER ────────────────────────────────────────────

  return (
    <div className="space-y-5 md:space-y-6 animate-[fade-in_0.3s_ease]">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Billing & POS</h1>
          <p className="text-sm text-muted mt-1">
            {stats ? `${stats.todayCount} invoices today · ${formatCurrency(stats.todayRevenue)} collected` : ''}
          </p>
        </div>
        <div className="flex w-full sm:w-auto items-center gap-2 flex-wrap">
          {heldBills.length > 0 && (
            <span className="flex items-center gap-1.5 px-3 py-2 bg-amber-500/10 text-amber-700 rounded-xl text-xs font-medium border border-amber-500/20">
              <PauseCircle className="w-3.5 h-3.5" /> {heldBills.length} held
            </span>
          )}
          <button onClick={handleExportCSV} className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 py-2.5 bg-surface border border-border hover:border-accent/30 rounded-xl text-sm font-medium text-muted hover:text-accent transition-all">
            <Download className="w-4 h-4" /> Export
          </button>
          <button onClick={() => { setTab('pos'); clearPOS(); }} className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all">
            <Plus className="w-4 h-4" /> New Invoice
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex max-w-full overflow-x-auto hide-scrollbar bg-surface rounded-xl border border-border p-0.5 w-fit">
        {[
          { key: 'invoices', label: 'Invoices', icon: Receipt, count: invoices.filter(i => i.invoiceStatus === 'ACTIVE').length },
          { key: 'pos', label: 'POS', icon: Calculator },
          { key: 'held', label: 'Held Bills', icon: PauseCircle, count: heldBills.length },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex flex-shrink-0 items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-2 rounded-lg text-sm font-medium transition-all ${tab === t.key ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
            {t.count > 0 && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${tab === t.key ? 'bg-white/20' : 'bg-accent/10 text-accent'}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════════
           INVOICES TAB
         ════════════════════════════════════════════════════════ */}
      {tab === 'invoices' && (
        <>
          {/* Stats Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Billed', value: formatCurrency(stats?.totalBilled || 0), icon: Receipt, color: 'accent', sub: `${invoices.filter(i => i.invoiceStatus === 'ACTIVE').length} invoices` },
              { label: 'Collected', value: formatCurrency(stats?.totalCollected || 0), icon: CheckCircle2, color: 'success', sub: stats?.monthGrowth > 0 ? `+${stats.monthGrowth}% vs last month` : stats?.monthGrowth < 0 ? `${stats.monthGrowth}% vs last month` : 'This month' },
              { label: 'Pending Dues', value: formatCurrency(stats?.totalPending || 0), icon: Clock, color: 'warning', sub: `${stats?.overdueCount || 0} invoices due` },
              { label: 'Today\'s Revenue', value: formatCurrency(stats?.todayRevenue || 0), icon: TrendingUp, color: 'teal', sub: `${stats?.todayCount || 0} transactions` },
            ].map((s, i) => (
              <div key={i} className="glass-card p-4 flex items-center gap-3">
                <div className={`p-2.5 rounded-xl bg-${s.color}-light`}><s.icon className={`w-5 h-5 text-${s.color}`} /></div>
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className={`text-lg font-bold text-${s.color}`}>{s.value}</p>
                  <p className="text-[10px] text-muted">{s.sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Filters Bar */}
          <div className="glass-card p-4">
            <div className="flex flex-col gap-3">
              {/* Row 1: Search + Payment Status (Mobile Only) */}
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input type="search" autoComplete="off" placeholder="Search by customer, phone, invoice ID, or salesperson..." value={search} onChange={e => setSearch(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-surface rounded-xl border border-border text-sm focus:ring-2 focus:ring-accent/30 focus:border-accent/50 outline-none transition-all" />
                </div>
                <div className="flex sm:hidden overflow-x-auto pb-1 items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted font-semibold flex-shrink-0">Payment</span>
                  {['All', 'Paid', 'Partial', 'Pending'].map(s => (
                    <button key={s} onClick={() => setStatusFilter(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${statusFilter === s ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-foreground hover:bg-surface-hover border border-transparent hover:border-border'}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              {/* Row 2: Invoice Status + Date Range + Sort */}
              <div className="flex flex-col xl:flex-row gap-3 items-start xl:items-center justify-between">
                <div className="flex overflow-x-auto pb-1 items-center gap-2 w-full xl:w-auto">
                  <span className="text-[10px] uppercase tracking-wider text-muted font-semibold flex-shrink-0">Status</span>
                  {['All', 'ACTIVE', 'CANCELLED', 'REFUNDED'].map(s => (
                    <button key={s} onClick={() => setInvoiceStatusFilter(s)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${invoiceStatusFilter === s ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-foreground hover:bg-surface-hover border border-transparent hover:border-border'}`}>
                      {s === 'ACTIVE' ? 'Active' : s === 'CANCELLED' ? 'Cancelled' : s === 'REFUNDED' ? 'Refunded' : s}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2 justify-end w-full xl:w-auto">
                  <div className="flex items-center bg-surface border border-border rounded-xl focus-within:border-accent/50 focus-within:ring-1 focus-within:ring-accent/30 transition-all overflow-hidden h-[34px] flex-shrink-0">
                    <div className="pl-3 pr-2 flex items-center bg-surface-hover/50 h-full border-r border-border/50 text-muted">
                      <Calendar className="w-3.5 h-3.5" />
                    </div>
                    <input type="date" title="Start Date" value={dateRange.from} onChange={e => setDateRange(prev => ({ ...prev, from: e.target.value }))}
                      className="px-2 pr-1 py-1.5 bg-transparent text-xs text-foreground focus:outline-none min-w-[120px]" />
                    <span className="text-[11px] font-medium text-muted px-1.5 bg-surface-hover/30 h-full flex items-center">to</span>
                    <div className="pl-2 pr-2 flex items-center bg-surface-hover/50 h-full border-r border-l border-border/50 text-muted">
                      <Calendar className="w-3.5 h-3.5" />
                    </div>
                    <input type="date" title="End Date" value={dateRange.to} onChange={e => setDateRange(prev => ({ ...prev, to: e.target.value }))}
                      className="px-2 pr-1 py-1.5 bg-transparent text-xs text-foreground focus:outline-none min-w-[120px]" />
                    {(dateRange.from || dateRange.to) && (
                      <button onClick={() => setDateRange({ from: '', to: '' })} className="px-2.5 h-full flex items-center hover:bg-red-500/10 hover:text-red-700 text-muted transition-colors border-l border-border/50">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <select value={sortBy} onChange={e => setSortBy(e.target.value)}
                    className="px-3 py-1.5 bg-surface border border-border rounded-xl text-xs focus:outline-none focus:border-accent/50 h-[34px] min-w-[130px]">
                    <option value="date-desc">Newest first</option>
                    <option value="date-asc">Oldest first</option>
                    <option value="total-desc">Highest amount</option>
                    <option value="total-asc">Lowest amount</option>
                    <option value="balance-desc">Most due</option>
                  </select>
                </div>
              </div>
              {/* Row 3: Payment Status - Desktop Only */}
              <div className="hidden sm:flex items-center gap-2 mt-1">
                <span className="text-[10px] uppercase tracking-wider text-muted font-semibold flex-shrink-0">Payment</span>
                {['All', 'Paid', 'Partial', 'Pending'].map(s => (
                  <button key={s} onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${statusFilter === s ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-foreground hover:bg-surface-hover border border-transparent hover:border-border'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Invoice Table */}
          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto hidden md:block">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Invoice ID</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Total</th>
                    <th>Paid</th>
                    <th>Balance</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(inv => {
                    const MethodIcon = paymentMethodIcons[inv.paymentMethod] || CreditCard;
                    const isCancelled = inv.invoiceStatus === 'CANCELLED' || inv.invoiceStatus === 'REFUNDED';
                    return (
                      <tr key={inv.id} className={`cursor-pointer ${isCancelled ? 'opacity-50' : ''}`} onClick={() => setSelectedInvoice(inv)}>
                        <td>
                          <span className="font-mono text-accent font-medium">{inv.id}</span>
                          {inv.isHeld && <span className="ml-1.5 text-[9px] bg-amber-500/10 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">HELD</span>}
                        </td>
                        <td>
                          <div>
                            <p className="font-medium text-foreground">{inv.customer}</p>
                            <p className="text-xs text-muted">{inv.phone}</p>
                          </div>
                        </td>
                        <td className="text-sm max-w-[180px] truncate">{inv.items.map(i => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}`).join(', ')}</td>
                        <td className="font-semibold text-foreground">{formatFullCurrency(inv.total)}</td>
                        <td className="text-success font-medium">{formatFullCurrency(inv.amountPaid)}</td>
                        <td className={inv.balanceDue > 0 ? 'text-red-600 font-semibold' : 'text-muted'}>{inv.balanceDue > 0 ? formatFullCurrency(inv.balanceDue) : '—'}</td>
                        <td>
                          <span className="flex items-center gap-1.5 text-xs text-muted">
                            <MethodIcon className="w-3.5 h-3.5" /> {inv.paymentMethod}
                          </span>
                        </td>
                        <td>
                          <div className="flex flex-col gap-1">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium border w-fit ${paymentStatusColors[inv.paymentStatus]}`}>{inv.paymentStatus}</span>
                            {isCancelled && <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium border w-fit ${invoiceStatusColors[inv.invoiceStatus]}`}>{inv.invoiceStatus}</span>}
                          </div>
                        </td>
                        <td className="text-muted whitespace-nowrap">{inv.date}</td>
                        <td>
                          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                            <button onClick={() => handleShareInvoiceWhatsApp(inv)}
                              className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-muted hover:text-emerald-700 transition-colors" title="Share on WhatsApp">
                              <MessageSquare className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleShareInvoiceEmail(inv)}
                              className="p-1.5 rounded-lg hover:bg-blue-500/10 text-muted hover:text-blue-700 transition-colors" title="Share by Email">
                              <Mail className="w-4 h-4" />
                            </button>
                            <button onClick={() => handlePrintInvoice(inv)}
                              className="p-1.5 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors" title="Print">
                              <Printer className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDownloadInvoice(inv)}
                              className="p-1.5 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors" title="Download PDF">
                              <Download className="w-4 h-4" />
                            </button>
                            {session?.user?.role === 'ADMIN' && !isCancelled && (
                              <button onClick={() => handleEditInvoice(inv)}
                                className="p-1.5 rounded-lg hover:bg-amber-500/10 text-muted hover:text-amber-700 transition-colors" title="Edit Invoice">
                                <Edit3 className="w-4 h-4" />
                              </button>
                            )}
                            {inv.balanceDue > 0 && inv.invoiceStatus === 'ACTIVE' && (
                              <button onClick={() => { setSelectedInvoice(inv); setPaymentModalData({ ...paymentModalData, amount: inv.balanceDue }); setShowPaymentModal(true); }}
                                className="p-1.5 rounded-lg hover:bg-success/10 text-muted hover:text-success transition-colors" title="Record Payment">
                                <BadgeIndianRupee className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: stacked invoice cards */}
            <div className="md:hidden divide-y divide-border">
              {filtered.map(inv => {
                const MethodIcon = paymentMethodIcons[inv.paymentMethod] || CreditCard;
                const isCancelled = inv.invoiceStatus === 'CANCELLED' || inv.invoiceStatus === 'REFUNDED';
                return (
                  <div key={inv.id} className={`p-4 ${isCancelled ? 'opacity-60' : ''}`}>
                    <button onClick={() => setSelectedInvoice(inv)} className="w-full text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-accent font-semibold text-sm">{inv.id}</span>
                            {inv.isHeld && <span className="text-[9px] bg-warning-light text-warning px-1.5 py-0.5 rounded-full font-medium">HELD</span>}
                          </div>
                          <p className="font-medium text-foreground mt-1 truncate">{inv.customer}</p>
                          <p className="text-xs text-muted">{inv.phone}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-base font-bold text-foreground">{formatFullCurrency(inv.total)}</p>
                          <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${paymentStatusColors[inv.paymentStatus]}`}>{inv.paymentStatus}</span>
                        </div>
                      </div>
                      <p className="text-xs text-muted mt-2 line-clamp-2">{inv.items.map(i => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}`).join(', ')}</p>
                      <div className="flex items-center justify-between gap-3 mt-3 text-xs">
                        <span className="flex items-center gap-1.5 text-muted">
                          <MethodIcon className="w-3.5 h-3.5" /> {inv.paymentMethod}
                        </span>
                        <span className="text-muted">{inv.date}</span>
                        {inv.balanceDue > 0
                          ? <span className="text-danger font-semibold">Due {formatFullCurrency(inv.balanceDue)}</span>
                          : <span className="text-success font-medium">Paid</span>}
                      </div>
                      {isCancelled && (
                        <span className={`inline-block mt-2 px-2 py-0.5 rounded-full text-[10px] font-medium border ${invoiceStatusColors[inv.invoiceStatus]}`}>{inv.invoiceStatus}</span>
                      )}
                    </button>
                    {/* Action row */}
                    <div className="flex items-center gap-1 mt-3 pt-3 border-t border-border/60">
                      <button onClick={() => handleShareInvoiceWhatsApp(inv)}
                        className="touch-target flex-1 flex items-center justify-center rounded-lg bg-surface-hover text-muted hover:text-success transition-colors" title="Share on WhatsApp">
                        <MessageSquare className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleShareInvoiceEmail(inv)}
                        className="touch-target flex-1 flex items-center justify-center rounded-lg bg-surface-hover text-muted hover:text-info transition-colors" title="Share by Email">
                        <Mail className="w-4 h-4" />
                      </button>
                      <button onClick={() => handlePrintInvoice(inv)}
                        className="touch-target flex-1 flex items-center justify-center rounded-lg bg-surface-hover text-muted hover:text-accent transition-colors" title="Print">
                        <Printer className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDownloadInvoice(inv)}
                        className="touch-target flex-1 flex items-center justify-center rounded-lg bg-surface-hover text-muted hover:text-accent transition-colors" title="Download PDF">
                        <Download className="w-4 h-4" />
                      </button>
                      {session?.user?.role === 'ADMIN' && !isCancelled && (
                        <button onClick={() => handleEditInvoice(inv)}
                          className="touch-target flex-1 flex items-center justify-center rounded-lg bg-surface-hover text-muted hover:text-warning transition-colors" title="Edit Invoice">
                          <Edit3 className="w-4 h-4" />
                        </button>
                      )}
                      {inv.balanceDue > 0 && inv.invoiceStatus === 'ACTIVE' && (
                        <button onClick={() => { setSelectedInvoice(inv); setPaymentModalData({ ...paymentModalData, amount: inv.balanceDue }); setShowPaymentModal(true); }}
                          className="touch-target flex-1 flex items-center justify-center rounded-lg bg-success-light text-success transition-colors" title="Record Payment">
                          <BadgeIndianRupee className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {filtered.length === 0 && (
              <div className="text-center py-10 text-muted text-sm">No invoices match your filters</div>
            )}
            <div className="px-4 py-3 border-t border-border flex items-center justify-between text-xs text-muted">
              <span>Showing {filtered.length} of {invoices.length} invoices</span>
              <span>Total: {formatFullCurrency(filtered.reduce((s, i) => s + i.total, 0))} · Due: {formatFullCurrency(filtered.reduce((s, i) => s + i.balanceDue, 0))}</span>
            </div>
          </div>
        </>
      )}

      {/* ════════════════════════════════════════════════════════
           HELD BILLS TAB
         ════════════════════════════════════════════════════════ */}
      {tab === 'held' && (
        <div className="space-y-4">
          {heldBills.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <PauseCircle className="w-12 h-12 mx-auto mb-3 text-muted/20" />
              <p className="text-sm font-medium text-muted">No held bills</p>
              <p className="text-xs text-muted mt-1">Bills you park from the POS will appear here</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {heldBills.map(inv => (
                <div key={inv.dbId} className="glass-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-accent font-semibold text-sm">{inv.id}</span>
                    <span className="text-xs text-muted">{inv.date} {inv.time}</span>
                  </div>
                  <div className="mb-3">
                    <p className="font-medium text-foreground">{inv.customer}</p>
                    <p className="text-xs text-muted">{inv.phone}</p>
                  </div>
                  <div className="text-xs text-muted mb-3">
                    {inv.items.map(i => `${i.name} x${i.qty}`).join(', ')}
                  </div>
                  <div className="flex items-center justify-between mb-4 pt-3 border-t border-border">
                    <span className="text-sm text-muted">Total</span>
                    <span className="text-lg font-bold text-accent">{formatFullCurrency(inv.total)}</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => handleFinalizeHeld(inv)} disabled={submitting}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-accent text-white rounded-xl text-xs font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
                      <PlayCircle className="w-3.5 h-3.5" /> Finalize
                    </button>
                    <button onClick={() => { setSelectedInvoice(inv); setShowCancelConfirm(true); }}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-surface border border-border text-muted rounded-xl text-xs font-medium hover:text-red-600 hover:border-red-600/30 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
           POS TAB
         ════════════════════════════════════════════════════════ */}
      {tab === 'pos' && (
        <div className={`grid grid-cols-1 lg:grid-cols-5 gap-5 ${posItems.length > 0 ? 'pb-44 md:pb-0' : ''}`}>
          {/* Left: Product Search + Catalog + Cart (3 cols) */}
          <div className="lg:col-span-3 space-y-5">
            {stoneLots.some(lot => lot.availableSlabs > 0) && (
              <div className="glass-card p-5">
                <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-2"><Layers className="w-4 h-4 text-accent" /> Granite & Marble Slabs</h3>
                <p className="text-xs text-muted mb-3">Select the actual slab; its measured sq.ft is billed and its status becomes sold on invoice creation.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                  {stoneLots.flatMap(lot => lot.slabs.filter(slab => slab.status === 'AVAILABLE').map(slab => ({ lot, slab }))).map(({ lot, slab }) => (
                    <button key={slab.id} onClick={() => addSlabToPOS(slab, lot)} className="p-3 rounded-xl border border-border bg-surface hover:border-accent/40 hover:bg-accent/5 text-left transition-colors">
                      <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-foreground truncate">{lot.product.name}</span><span className="text-[10px] font-mono text-muted">{slab.slabNumber}</span></div>
                      <p className="text-[11px] text-muted mt-1">Lot {lot.lotNumber} · {slab.lengthInches}″ × {slab.widthInches}″ · <strong>{slab.sqft.toFixed(2)} sq.ft</strong></p>
                      <p className="text-xs font-semibold text-accent mt-1">₹{lot.product.price}/sq.ft</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Product Search with Dropdown */}
            <div className="glass-card p-5" ref={productSearchRef}>
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <Package className="w-4 h-4 text-accent" /> Add Products
              </h3>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input type="search" autoComplete="off" placeholder="Search by product name, SKU, or category..."
                  value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setShowProductDropdown(true); }}
                  onFocus={() => setShowProductDropdown(true)}
                  className="w-full pl-10 pr-4 py-3 bg-surface rounded-xl border border-border text-sm focus:ring-2 focus:ring-accent/30 focus:border-accent/50 outline-none transition-all" />
              </div>
              {/* Search results dropdown — shows on focus (all products) OR on type (filtered) */}
              {showProductDropdown && (
                <div className="mt-2 bg-surface border border-border rounded-xl shadow-lg max-h-[300px] overflow-y-auto z-20 relative">
                  {posMatches.inStock.slice(0, POS_RESULT_LIMIT).map(p => {
                    const inCart = posItems.find(i => i.id === p.id);
                    return (
                      <button key={p.id} onClick={() => addToPOS(p)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-hover transition-colors text-left border-b border-border/50 last:border-0">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center overflow-hidden flex-shrink-0">
                            {p.image && p.image.includes('/') ? (
                              <img src={p.image.split(',')[0]} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <Package className="w-5 h-5 text-muted/30" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{p.name}</p>
                            <p className="text-xs text-muted mt-0.5">{p.category} · <span className="font-mono">{p.sku}</span> · <span className={p.stock <= 5 ? 'text-red-600 font-medium' : ''}>{p.stock} in stock</span></p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                          <span className="text-sm font-semibold text-accent">{formatFullCurrency(p.price)}</span>
                          {inCart && <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-medium">x{inCart.qty}</span>}
                          <Plus className="w-4 h-4 text-accent/50" />
                        </div>
                      </button>
                    );
                  })}
                  {posMatches.inStock.length > POS_RESULT_LIMIT && (
                    <p className="px-4 py-2 text-[11px] text-muted bg-surface-hover/50">Showing {POS_RESULT_LIMIT} of {posMatches.inStock.length} in-stock matches. Type more of the name or SKU to narrow down.</p>
                  )}
                  {posMatches.outOfStock.slice(0, 5).map(p => (
                    <div key={p.id} className="w-full flex items-center justify-between px-4 py-2.5 text-left border-b border-border/50 last:border-0 opacity-60 cursor-not-allowed" title="No stock to sell. Receive stock or transfer it from another godown first.">
                      <div className="min-w-0">
                        <p className="text-sm text-foreground truncate">{p.name}</p>
                        <p className="text-xs text-muted mt-0.5">{p.category} · <span className="font-mono">{p.sku}</span></p>
                      </div>
                      <span className="text-[10px] font-medium text-red-600 bg-red-500/10 px-2 py-0.5 rounded-full flex-shrink-0 ml-3">Out of stock</span>
                    </div>
                  ))}
                  {posMatches.inStock.length === 0 && posMatches.outOfStock.length === 0 && (
                    <p className="text-center text-muted text-xs py-8">No products match “{productSearch}”</p>
                  )}
                </div>
              )}
            </div>

            {/* Quick Product Grid — always visible for fast selection */}
            {!showProductDropdown && (
              <div className="glass-card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                    <ShoppingBag className="w-4 h-4 text-accent" /> Quick Select
                  </h3>
                  <span className="text-[10px] uppercase tracking-wider text-muted font-semibold">
                    {saleProducts.filter(p => p.stock > 0).length} products available
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[320px] overflow-y-auto pr-1">
                  {saleProducts.filter(p => p.stock > 0).slice(0, 18).map(p => {
                    const inCart = posItems.find(i => i.id === p.id);
                    return (
                      <button key={p.id} onClick={() => addToPOS(p)}
                        className={`relative flex flex-col items-start p-3.5 rounded-xl border transition-all text-left ${inCart ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface hover:border-accent/30 hover:bg-surface-hover'}`}>
                        <div className="flex items-center gap-2.5 w-full mb-2">
                          <div className="w-9 h-9 rounded-lg bg-surface-hover flex items-center justify-center overflow-hidden flex-shrink-0">
                            {p.image && p.image.includes('/') ? (
                              <img src={p.image.split(',')[0]} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <Package className="w-4 h-4 text-muted/30" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-foreground truncate leading-tight">{p.name}</p>
                            <p className="text-[10px] text-muted font-mono mt-0.5">{p.sku}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between w-full">
                          <span className="text-sm font-bold text-accent">{formatFullCurrency(p.price)}</span>
                          <span className={`text-[10px] ${p.stock <= 5 ? 'text-red-600 font-medium' : 'text-muted'}`}>{p.stock} left</span>
                        </div>
                        {inCart && (
                          <span className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-accent text-white rounded-full text-[10px] font-bold flex items-center justify-center">{inCart.qty}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {saleProducts.filter(p => p.stock > 0).length === 0 && (
                  <div className="text-center py-10 text-muted">
                    <Package className="w-10 h-10 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No products in stock</p>
                  </div>
                )}
              </div>
            )}

            {/* Cart Items */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-accent" /> Cart
                  {posItems.length > 0 && (
                    <span className="text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full font-medium">
                      {posItems.length} {posItems.length === 1 ? 'item' : 'items'} · {posItems.reduce((s, i) => s + i.qty, 0)} units
                    </span>
                  )}
                </h3>
                {posItems.length > 0 && (
                  <button onClick={clearPOS} className="text-xs text-red-600 hover:text-red-700 font-medium transition-colors flex items-center gap-1">
                    <Trash2 className="w-3 h-3" /> Clear All
                  </button>
                )}
              </div>

              {posItems.length === 0 ? (
                <div className="text-center py-10 text-muted">
                  <ShoppingBag className="w-10 h-10 mx-auto mb-2 opacity-20" />
                  <p className="text-sm font-medium">Cart is empty</p>
                  <p className="text-xs mt-1">Click products above or search to add items</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="hidden md:grid grid-cols-12 gap-3 px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-semibold border-b border-border">
                    <div className="col-span-5">Product / HSN</div>
                    <div className="col-span-2 text-center">Rate</div>
                    <div className="col-span-2 text-center">Qty</div>
                    <div className="col-span-2 text-right">Amount</div>
                    <div className="col-span-1"></div>
                  </div>
                  {posItems.map(item => {
                    const hsnMatch = hsnCodes.find(h => h.code === item.hsnCode);
                    const line = posLine(item);
                    const lineUnit = String(item.unitOfMeasure || 'PCS').toUpperCase();
                    const isAreaUnit = lineUnit === 'SQFT' || lineUnit === 'SQM' || lineUnit === 'BOX' || lineUnit === 'SLAB';
                    const hasConversion = line.boxes !== undefined && line.area !== undefined;
                    return (
                      <div key={item.id}>
                        <div className="hidden md:grid grid-cols-12 gap-3 items-center bg-surface rounded-xl p-3">
                          <div className="col-span-5 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                            <p className="text-[10px] text-muted font-mono mt-0.5">{item.sku} · {item.category}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-[9px] uppercase tracking-wider text-muted">HSN</span>
                              <input
                                type="text"
                                placeholder="HSN code"
                                value={item.hsnCode || ''}
                                onChange={e => updateItemHsn(item.id, e.target.value)}
                                list="hsn-codes"
                                className="w-28 px-2 py-1 text-[10px] bg-transparent border border-border rounded-md focus:outline-none focus:border-accent/50"
                              />
                              <span className="text-[9px] uppercase tracking-wider text-muted">GST %</span>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                value={Number.isFinite(item.gstRate) ? item.gstRate : gstRate}
                                onChange={e => updateItemGstRate(item.id, e.target.value)}
                                className="w-16 px-2 py-1 text-[10px] bg-transparent border border-border rounded-md focus:outline-none focus:border-accent/50"
                              />
                              {hsnMatch?.description && (
                                <span className="text-[10px] text-muted truncate max-w-[220px]">{hsnMatch.description}</span>
                              )}
                              {item.batches?.length > 0 && !item.slabId && (
                                <>
                                  <span className="text-[9px] uppercase tracking-wider text-muted">Batch / shade</span>
                                  <select value={item.batchId || ''} onChange={e => setPosItems(posItems.map(row => row.id === item.id ? { ...row, batchId: e.target.value ? Number(e.target.value) : undefined } : row))} className="max-w-[190px] px-2 py-1 text-[10px] bg-transparent border border-border rounded-md focus:outline-none focus:border-accent/50">
                                    <option value="">No batch selected</option>
                                    {item.batches.map(batch => <option key={batch.id} value={batch.id}>{batch.batchNumber}{batch.shadeCode ? ` · ${batch.shadeCode}` : ''} · {batch.remainingQty} left</option>)}
                                  </select>
                                </>
                              )}
                            </div>
                            {isAreaUnit && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="text-[9px] uppercase tracking-wider text-muted">Area (sq.ft)</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={item.area ?? 0}
                                  onChange={e => updateItemArea(item.id, e.target.value)}
                                  className="w-20 px-2 py-1 text-[10px] bg-transparent border border-border rounded-md focus:outline-none focus:border-accent/50"
                                />
                                {hasConversion && (
                                  <span className="text-[10px] text-accent">
                                    {line.area} sq.ft → <span className="font-semibold">{line.boxes} box{line.boxes === 1 ? '' : 'es'}</span>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="col-span-2">
                            <input type="number" value={item.price} min="0"
                              onChange={e => updateItemPrice(item.id, parseInt(e.target.value) || 0)}
                              className="w-full text-center text-sm font-medium bg-transparent border border-border rounded-lg py-1.5 focus:border-accent/50 outline-none" />
                          </div>
                          <div className="col-span-2 flex items-center justify-center gap-1">
                            <button onClick={() => updateQty(item.id, item.qty - 1)} className="w-7 h-7 rounded-lg bg-surface-hover border border-border flex items-center justify-center text-muted hover:text-foreground transition-colors">
                              <Minus className="w-3 h-3" />
                            </button>
                            <input type="number" value={item.qty} min="1" max={item.stock}
                              onChange={e => updateQty(item.id, parseInt(e.target.value) || 1)}
                              className="w-10 text-center text-sm font-semibold bg-transparent border border-border rounded-lg py-1.5 focus:border-accent/50 outline-none" />
                            <button onClick={() => updateQty(item.id, item.qty + 1)} className="w-7 h-7 rounded-lg bg-surface-hover border border-border flex items-center justify-center text-muted hover:text-foreground transition-colors">
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="col-span-2 text-right">
                            <p className="text-sm font-semibold text-foreground">{formatFullCurrency(line.amount)}</p>
                          </div>
                          <div className="col-span-1 flex justify-end">
                            <button onClick={() => setPosItems(posItems.filter(i => i.id !== item.id))} className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-600 transition-colors">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Mobile: stacked cart card with touch-friendly controls */}
                        <div key={`${item.id}-m`} className="md:hidden bg-surface rounded-xl p-3.5 border border-border">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{item.name}</p>
                              <p className="text-[10px] text-muted font-mono mt-0.5">{item.sku} · {item.category}</p>
                            </div>
                            <button onClick={() => setPosItems(posItems.filter(i => i.id !== item.id))}
                              className="touch-target flex items-center justify-center rounded-lg text-muted hover:text-danger hover:bg-danger-light transition-colors flex-shrink-0">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          {/* Rate + Qty + Amount row */}
                          <div className="flex items-end justify-between gap-3 mt-3">
                            <div className="flex-1 min-w-0">
                              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">Rate</label>
                              <div className="relative">
                                <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                                <input type="number" value={item.price} min="0"
                                  onChange={e => updateItemPrice(item.id, parseInt(e.target.value) || 0)}
                                  className="w-full pl-8 pr-2 h-11 text-sm font-medium bg-background border border-border rounded-lg focus:border-accent/50 outline-none" />
                              </div>
                            </div>
                            <div>
                              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1 text-center">Qty</label>
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => updateQty(item.id, item.qty - 1)}
                                  className="touch-target w-11 h-11 rounded-lg bg-surface-hover border border-border flex items-center justify-center text-foreground active:bg-accent/10 transition-colors">
                                  <Minus className="w-4 h-4" />
                                </button>
                                <input type="number" value={item.qty} min="1" max={item.stock}
                                  onChange={e => updateQty(item.id, parseInt(e.target.value) || 1)}
                                  className="w-12 h-11 text-center text-base font-semibold bg-background border border-border rounded-lg focus:border-accent/50 outline-none" />
                                <button onClick={() => updateQty(item.id, item.qty + 1)}
                                  className="touch-target w-11 h-11 rounded-lg bg-surface-hover border border-border flex items-center justify-center text-foreground active:bg-accent/10 transition-colors">
                                  <Plus className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* HSN + GST */}
                          <div className="flex items-center gap-2 mt-3">
                            <div className="flex-1 min-w-0">
                              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">HSN</label>
                              <input type="text" placeholder="HSN code" value={item.hsnCode || ''}
                                onChange={e => updateItemHsn(item.id, e.target.value)} list="hsn-codes"
                                className="w-full px-2.5 h-10 text-xs bg-background border border-border rounded-lg focus:outline-none focus:border-accent/50" />
                            </div>
                            <div className="w-24">
                              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">GST %</label>
                              <input type="number" min="0" max="100"
                                value={Number.isFinite(item.gstRate) ? item.gstRate : gstRate}
                                onChange={e => updateItemGstRate(item.id, e.target.value)}
                                className="w-full px-2.5 h-10 text-xs bg-background border border-border rounded-lg focus:outline-none focus:border-accent/50" />
                            </div>
                          </div>
                          {hsnMatch?.description && (
                            <p className="text-[10px] text-muted mt-1.5 truncate">{hsnMatch.description}</p>
                          )}

                          {/* Area (tiles SQFT/BOX) */}
                          {isAreaUnit && (
                            <div className="mt-3">
                              <label className="block text-[9px] uppercase tracking-wider text-muted mb-1">Area (sq.ft)</label>
                              <input type="number" min="0" step="0.01" value={item.area ?? 0}
                                onChange={e => updateItemArea(item.id, e.target.value)}
                                className="w-full px-2.5 h-10 text-xs bg-background border border-border rounded-lg focus:outline-none focus:border-accent/50" />
                              {hasConversion && (
                                <p className="text-[10px] text-accent mt-1.5">
                                  {line.area} sq.ft → <span className="font-semibold">{line.boxes} box{line.boxes === 1 ? '' : 'es'}</span>
                                </p>
                              )}
                            </div>
                          )}

                          {/* Line amount */}
                          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/60">
                            <span className="text-xs text-muted">Amount</span>
                            <span className="text-base font-bold text-foreground">{formatFullCurrency(line.amount)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {hsnCodes.length > 0 && (
                    <datalist id="hsn-codes">
                      {hsnCodes.map(code => (
                        <option key={code.id} value={code.code}>{code.description}</option>
                      ))}
                    </datalist>
                  )}
                  {/* Cart subtotal bar */}
                  <div className="flex items-center justify-between px-3 pt-3 border-t border-border">
                    <span className="text-xs text-muted font-medium">{posItems.reduce((s, i) => s + i.qty, 0)} units</span>
                    <span className="text-sm font-bold text-foreground">Subtotal: {formatFullCurrency(posSubtotal)}</span>
                  </div>
                </div>
              )
              }
            </div>
          </div>

          {/* Right: Bill Details & Summary (2 cols) */}
          {/* On mobile this becomes a full-screen checkout sheet; md+ keeps the inline column. */}
          <div className={`space-y-5 lg:col-span-2 ${mobileCheckoutOpen ? 'fixed inset-0 z-[90] bg-background overflow-y-auto p-4 pb-28 animate-slide-up-sheet' : 'hidden'} md:static md:z-auto md:block md:bg-transparent md:overflow-visible md:p-0 md:pb-0`}>
            {/* Mobile sheet header */}
            <div className="md:hidden sticky top-0 -mx-4 px-4 py-3 mb-1 flex items-center justify-between bg-background/95 backdrop-blur-sm border-b border-border z-10">
              <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                <Receipt className="w-4 h-4 text-accent" /> Checkout
              </h2>
              <button onClick={() => setMobileCheckoutOpen(false)}
                className="touch-target flex items-center justify-center rounded-xl text-muted hover:text-foreground hover:bg-surface-hover transition-colors" aria-label="Close checkout">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Customer with Auto-complete */}
            <div className="glass-card p-5" ref={customerSearchRef}>
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <User className="w-4 h-4 text-accent" /> Customer Details
              </h3>
              <div className="space-y-3">
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                  <input type="text" placeholder="Customer name *" value={posCustomer.name}
                    onChange={e => handleCustomerSearch(e.target.value, 'name')}
                    className="w-full pl-9 pr-4 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                </div>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                  <input type="tel" placeholder="Phone number *" value={posCustomer.phone}
                    onChange={e => handleCustomerSearch(e.target.value, 'phone')}
                    className="w-full pl-9 pr-4 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                </div>
                <div className="relative">
                  <MapPin className="absolute left-3 top-3 w-3.5 h-3.5 text-muted" />
                  <textarea placeholder="Address (Optional)" value={posCustomer.address || ''}
                    onChange={e => setPosCustomer({ ...posCustomer, address: e.target.value })}
                    rows={2}
                    className="w-full pl-9 pr-4 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50 resize-none" />
                </div>
                <div className="relative">
                  <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                  <input
                    type="text"
                    placeholder="GSTIN (optional)"
                    value={posCustomer.gstNumber || ''}
                    onChange={e => setPosCustomer({ ...posCustomer, gstNumber: e.target.value.toUpperCase() })}
                    className="w-full pl-9 pr-4 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50"
                  />
                </div>
                {pricelists.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Pricelist</label>
                    <div className="flex gap-2">
                      <select
                        value={posPricelistId}
                        onChange={e => setPosPricelistId(e.target.value)}
                        className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50"
                      >
                        <option value="">Customer&apos;s pricelist / default</option>
                        {pricelists.map(list => <option key={list.id} value={list.id}>{list.name}{list.isDefault ? ' (default)' : ''}</option>)}
                      </select>
                      <button
                        type="button"
                        disabled={posItems.length === 0}
                        onClick={() => repricePOS(posItems.filter(item => !item.slabId))}
                        className="px-3 py-3 rounded-xl text-sm border border-border text-foreground whitespace-nowrap hover:bg-surface-hover disabled:opacity-50"
                      >
                        Apply prices
                      </button>
                    </div>
                    {posPricedFrom && <p className="text-[11px] text-muted mt-1">Cart priced from {posPricedFrom}</p>}
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Supply Type</label>
                    <select
                      value={posSupplyType}
                      onChange={e => setPosSupplyType(e.target.value)}
                      className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50"
                    >
                      <option value="INTRASTATE">Intra-state (CGST + SGST)</option>
                      <option value="INTERSTATE">Inter-state (IGST)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Place of Supply</label>
                    <select
                      value={posPlaceOfSupply}
                      onChange={e => {
                        const value = e.target.value;
                        setPosPlaceOfSupply(value);
                        if (value !== 'OTHER') setPosPlaceOfSupplyCustom('');
                      }}
                      className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50"
                    >
                      <option value="">Select state (optional)</option>
                      {indiaStates.map(state => (
                        <option key={state} value={state}>{state}</option>
                      ))}
                      <option value="OTHER">Other</option>
                    </select>
                    {posPlaceOfSupply === 'OTHER' && (
                      <input
                        type="text"
                        value={posPlaceOfSupplyCustom}
                        onChange={e => setPosPlaceOfSupplyCustom(e.target.value)}
                        placeholder="Enter state"
                        className="w-full mt-2 px-4 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50"
                      />
                    )}
                  </div>
                </div>
                {/* Customer suggestions dropdown */}
                {showCustomerDropdown && customerSuggestions.length > 0 && (
                  <div className="bg-surface border border-border rounded-xl shadow-lg max-h-[180px] overflow-y-auto">
                    {customerSuggestions.map(c => (
                      <button key={c.id} onClick={() => selectCustomer(c)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-hover transition-colors text-left border-b border-border/50 last:border-0">
                        <User className="w-4 h-4 text-muted flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{c.name}</p>
                          <p className="text-xs text-muted">{c.phone}{c.email ? ` · ${c.email}` : ''}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Returning customer banner */}
                <ReturningCustomerCard
                  profile={customerProfile}
                  loading={customerProfileLoading}
                  onApplyDiscount={(value, type) => {
                    setPosDiscount(value);
                    setPosDiscountType(type === 'percent' ? 'percent' : 'flat');
                  }}
                />
              </div>
            </div>

            {/* Salesperson */}
            {staffList.length > 0 && (
              <div className="glass-card p-5">
                <h3 className="text-sm font-semibold text-foreground mb-3">Salesperson</h3>
                <select value={posSalesperson} onChange={e => setPosSalesperson(e.target.value)}
                  className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                  <option value="">— None —</option>
                  {staffList.map(s => <option key={s.id} value={s.id}>{s.name} — {s.role}</option>)}
                </select>
              </div>
            )}

            {/* Discount */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <Tag className="w-4 h-4 text-accent" /> Discount
              </h3>
              <div className="flex gap-2 mb-3">
                <button onClick={() => setPosDiscountType('flat')} className={`flex-1 py-2.5 rounded-xl text-xs font-medium transition-all border ${posDiscountType === 'flat' ? 'bg-accent text-white border-accent' : 'bg-surface border-border text-muted hover:text-foreground'}`}>
                  <IndianRupee className="w-3 h-3 inline -mt-0.5 mr-0.5" /> Flat
                </button>
                <button onClick={() => setPosDiscountType('percent')} className={`flex-1 py-2.5 rounded-xl text-xs font-medium transition-all border ${posDiscountType === 'percent' ? 'bg-accent text-white border-accent' : 'bg-surface border-border text-muted hover:text-foreground'}`}>
                  <Percent className="w-3 h-3 inline -mt-0.5 mr-0.5" /> Percent
                </button>
              </div>
              <input type="number" min="0" max={posDiscountType === 'percent' ? 100 : posSubtotal}
                placeholder={posDiscountType === 'percent' ? 'Enter %' : 'Enter amount'}
                value={posDiscount || ''} onChange={e => setPosDiscount(Number(e.target.value) || 0)}
                className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
              {posDiscountAmount > 0 && (
                <p className="text-xs text-success mt-2.5 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Saving {formatFullCurrency(posDiscountAmount)}
                </p>
              )}
            </div>

            {/* Site logistics */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                <Truck className="w-4 h-4 text-accent" /> Site Logistics
                <span className="text-[10px] text-muted font-normal">(optional)</span>
              </h3>
              <div className="space-y-2">
                <select value={posGodownId} onChange={e => setPosGodownId(e.target.value)} className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50">
                  <option value="">Default godown</option>
                  {godowns.map(godown => <option key={godown.id} value={godown.id}>{godown.name}{godown.isDefault ? ' · Default' : ''}</option>)}
                </select>
                <div className="relative">
                  <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                  <input type="number" min="0" placeholder="Transport amount"
                    value={posTransportCost || ''}
                    onChange={e => setPosTransportCost(Number(e.target.value) || 0)}
                    className="w-full pl-9 pr-3 py-3 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" min="0" placeholder="Freight"
                    value={posFreightCharge || ''} onChange={e => setPosFreightCharge(Number(e.target.value) || 0)}
                    className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                  <input type="number" min="0" placeholder="Loading / unloading"
                    value={posLoadingCharge || ''} onChange={e => setPosLoadingCharge(Number(e.target.value) || 0)}
                    className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                </div>
                <input type="number" min="0" placeholder="Installation / fabrication"
                  value={posInstallationCharge || ''} onChange={e => setPosInstallationCharge(Number(e.target.value) || 0)}
                  className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                <input type="text" placeholder="Road permit / e-way reference"
                  value={posRoadPermit} onChange={e => setPosRoadPermit(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
              </div>
            </div>

            {/* Split Payments */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-accent" /> Payment
                </h3>
                <button onClick={addPaymentSplit} className="text-xs text-accent hover:text-accent-hover font-medium flex items-center gap-1 transition-colors">
                  <SplitSquareHorizontal className="w-3 h-3" /> Split
                </button>
              </div>

              <div className="space-y-4">
                {posPayments.map((payment, idx) => (
                  <div key={idx} className="space-y-2.5">
                    {posPayments.length > 1 && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wider text-muted font-semibold">Payment {idx + 1}</span>
                        <button onClick={() => removePaymentSplit(idx)} className="text-muted hover:text-red-600 transition-colors">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {paymentMethods.map(method => {
                        const Icon = paymentMethodIcons[method] || CreditCard;
                        return (
                          <button key={method} onClick={() => updatePaymentSplit(idx, 'method', method)}
                            className={`py-2 rounded-xl text-[11px] font-medium transition-all border flex items-center justify-center gap-1.5 ${payment.method === method ? 'bg-accent text-white border-accent' : 'bg-surface border-border text-muted hover:text-foreground'}`}>
                            <Icon className="w-3 h-3" /> {method}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex gap-2.5">
                      <div className="relative flex-1">
                        <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                        <input type="number" placeholder="Amount" min="0"
                          value={payment.amount || ''}
                          onChange={e => { paymentAutoFillRef.current = false; updatePaymentSplit(idx, 'amount', Number(e.target.value) || 0); }}
                          className="w-full pl-9 pr-3 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
                      </div>
                      <input type="text" placeholder="Ref #"
                        value={payment.reference}
                        onChange={e => updatePaymentSplit(idx, 'reference', e.target.value)}
                        className="w-28 px-3 py-2.5 bg-surface border border-border rounded-xl text-xs placeholder:text-muted focus:outline-none focus:border-accent/50" />
                    </div>
                    {/* Quick amount buttons for first payment */}
                    {idx === 0 && posTotal > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        <button onClick={() => { paymentAutoFillRef.current = false; updatePaymentSplit(0, 'amount', posTotal); }}
                          className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
                          Full ({formatCurrency(posTotal)})
                        </button>
                        <button onClick={() => { paymentAutoFillRef.current = false; updatePaymentSplit(0, 'amount', Math.round(posTotal / 2)); }}
                          className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-surface-hover border border-border text-muted hover:text-foreground transition-colors">
                          50% ({formatCurrency(Math.round(posTotal / 2))})
                        </button>
                        {quickAmounts.filter(a => a <= posTotal && a !== posTotal).map(a => (
                          <button key={a} onClick={() => { paymentAutoFillRef.current = false; updatePaymentSplit(0, 'amount', a); }}
                            className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-surface-hover border border-border text-muted hover:text-foreground transition-colors">
                            {formatCurrency(a)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Payment totals */}
              {posTotal > 0 && (
                <div className="mt-4 pt-3 border-t border-border space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Paying</span>
                    <span className={`font-medium ${posTotalPayments >= posTotal ? 'text-success' : 'text-foreground'}`}>{formatFullCurrency(posTotalPayments)}</span>
                  </div>
                  {posBalanceDue > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted">Balance due</span>
                      <span className="font-medium text-red-600">{formatFullCurrency(posBalanceDue)}</span>
                    </div>
                  )}
                  {posTotalPayments > posTotal && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted">Change</span>
                      <span className="font-medium text-success">{formatFullCurrency(posTotalPayments - posTotal)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Due Date & Notes combined */}
            <div className="glass-card p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-accent" /> Due Date
                  <span className="text-[10px] text-muted font-normal">(optional)</span>
                </h3>
                <input type="date" value={posDueDate} onChange={e => setPosDueDate(e.target.value)}
                  min={istDate()}
                  className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">Notes</h3>
                <textarea value={posNotes} onChange={e => setPosNotes(e.target.value)} rows={2}
                  placeholder="Additional notes (optional)..."
                  className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm resize-none placeholder:text-muted focus:outline-none focus:border-accent/50" />
              </div>
            </div>

            {/* Bill Total */}
            <div className="glass-card p-5 border-2 border-accent/20">
              <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                <Receipt className="w-4 h-4 text-accent" /> Bill Summary
              </h3>
              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">Subtotal ({posItems.reduce((s, i) => s + i.qty, 0)} units)</span>
                  <span className="text-foreground font-medium">{formatFullCurrency(posSubtotal)}</span>
                </div>
                {posDiscountAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted">Discount {posDiscountType === 'percent' ? `(${posDiscount}%)` : ''}</span>
                    <span className="text-success font-medium">-{formatFullCurrency(posDiscountAmount)}</span>
                  </div>
                )}
                {posAdvancePaid > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted">Advance Paid</span>
                    <span className="text-success font-medium">-{formatFullCurrency(posAdvancePaid)}</span>
                  </div>
                )}
                {posSupplyType === 'INTERSTATE' ? (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">IGST</span>
                    <span className="text-foreground">{formatFullCurrency(posIgst)}</span>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted">CGST</span>
                      <span className="text-foreground">{formatFullCurrency(posCgst)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted">SGST</span>
                      <span className="text-foreground">{formatFullCurrency(posSgst)}</span>
                    </div>
                  </>
                )}
                {posTransportCost > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Transport Cost</span>
                    <span className="text-foreground">{formatFullCurrency(posTransportCost)}</span>
                  </div>
                )}
                {posFreightCharge > 0 && (
                  <div className="flex justify-between text-xs"><span className="text-muted">Freight</span><span className="text-foreground">{formatFullCurrency(posFreightCharge)}</span></div>
                )}
                {posLoadingCharge > 0 && (
                  <div className="flex justify-between text-xs"><span className="text-muted">Loading / unloading</span><span className="text-foreground">{formatFullCurrency(posLoadingCharge)}</span></div>
                )}
                {posInstallationCharge > 0 && (
                  <div className="flex justify-between text-xs"><span className="text-muted">Installation / fabrication</span><span className="text-foreground">{formatFullCurrency(posInstallationCharge)}</span></div>
                )}
                <div className="flex justify-between text-lg font-bold pt-3 border-t border-border mt-1">
                  <span className="text-foreground">Total</span>
                  <span className="text-accent">{formatFullCurrency(posTotal)}</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3 sticky bottom-0 -mx-4 px-4 py-3 bg-background/95 backdrop-blur-sm border-t border-border pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:px-0 md:py-0 md:pb-0 md:bg-transparent md:border-0 md:backdrop-blur-none">
              {editingInvoiceId ? (
                <>
                  <button
                    disabled={posItems.length === 0 || !posCustomer.name || !posCustomer.phone || submitting}
                    onClick={() => handleGenerateInvoice(false)}
                    className="w-full py-3.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {submitting ? (
                      <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Saving...</>
                    ) : (
                      <><Receipt className="w-4 h-4" /> Update Invoice</>
                    )}
                  </button>
                  <button
                    disabled={submitting}
                    onClick={() => { clearPOS(); paymentAutoFillRef.current = true; setEditingInvoiceId(null); }}
                    className="w-full py-3 bg-surface border border-border text-muted hover:text-foreground hover:border-accent/30 rounded-xl text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <X className="w-4 h-4" /> Cancel Edit
                  </button>
                </>
              ) : (
                <>
                  <button
                    disabled={posItems.length === 0 || !posCustomer.name || !posCustomer.phone || submitting || (posTotalPayments === 0 && !posDueDate)}
                    title={posTotalPayments === 0 && !posDueDate ? 'Enter a payment, or set a due date to sell on credit' : undefined}
                    onClick={() => handleGenerateInvoice(false)}
                    className="w-full py-3.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {submitting ? (
                      <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Generating...</>
                    ) : (
                      <><Receipt className="w-4 h-4" /> {posTotalPayments === 0 && posDueDate ? 'Generate Credit Invoice' : 'Generate Invoice'}</>
                    )}
                  </button>
                  <button
                    disabled={posItems.length === 0 || !posCustomer.name || !posCustomer.phone || submitting}
                    onClick={() => handleGenerateInvoice(true)}
                    className="w-full py-3 bg-surface border border-border text-muted hover:text-foreground hover:border-accent/30 rounded-xl text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <PauseCircle className="w-4 h-4" /> Hold Bill
                  </button>
                </>
              )}
              {(!posCustomer.name || !posCustomer.phone) && posItems.length > 0 && (
                <p className="text-xs text-amber-600 flex items-center gap-1 justify-center">
                  <AlertCircle className="w-3 h-3" /> Customer name and phone required
                </p>
              )}
            </div>
          </div>

          {/* Mobile: sticky cart summary bar → opens checkout sheet (clears bottom nav) */}
          {posItems.length > 0 && !mobileCheckoutOpen && (
            <div className="md:hidden fixed left-0 right-0 z-[70] px-3" style={{ bottom: 'calc(60px + env(safe-area-inset-bottom))' }}>
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface/95 backdrop-blur-xl px-4 py-2.5 shadow-lg">
                <div className="min-w-0">
                  <p className="text-[11px] text-muted">
                    {posItems.length} {posItems.length === 1 ? 'item' : 'items'} · {posItems.reduce((s, i) => s + i.qty, 0)} units
                  </p>
                  <p className="text-lg font-bold text-foreground leading-tight truncate">{formatFullCurrency(posTotal)}</p>
                </div>
                <button onClick={() => setMobileCheckoutOpen(true)}
                  className="touch-target flex items-center gap-2 px-5 py-3 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-colors flex-shrink-0">
                  <CreditCard className="w-4 h-4" /> {editingInvoiceId ? 'Review' : 'Checkout'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
           INVOICE DETAIL MODAL
         ════════════════════════════════════════════════════════ */}
      <Modal isOpen={!!selectedInvoice && !showPaymentModal && !showCreditNoteModal && !showCancelConfirm} onClose={() => setSelectedInvoice(null)} title="Invoice Details" size="lg">
        {selectedInvoice && (
          <div className="space-y-4">
            {/* Invoice Status Banner */}
            {selectedInvoice.invoiceStatus !== 'ACTIVE' && (
              <div className={`px-4 py-2.5 rounded-xl text-sm font-medium text-center border ${invoiceStatusColors[selectedInvoice.invoiceStatus]}`}>
                This invoice has been {selectedInvoice.invoiceStatus.toLowerCase()}
              </div>
            )}
            {selectedInvoice.isHeld && (
              <div className="px-4 py-2.5 rounded-xl text-sm font-medium text-center border bg-amber-500/10 text-amber-700 border-amber-500/20">
                This bill is on hold and can be finalized when you are ready
              </div>
            )}

            <div className="border border-border rounded-xl p-5 bg-surface">
              {/* Header */}
              <div className="flex items-center justify-between mb-4 pb-4 border-b border-border">
                <div>
                  <h3 className="text-xl font-bold text-accent">{storeSettings?.storeName || DEFAULT_STORE_NAME}</h3>
                  {storeSettings?.address && <p className="text-xs text-muted mt-0.5">{storeSettings.address}</p>}
                  {storeSettings?.gstNumber && <p className="text-xs text-muted">GSTIN: {storeSettings.gstNumber}</p>}
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-foreground">{selectedInvoice.id}</p>
                  <p className="text-xs text-muted">{selectedInvoice.date}{selectedInvoice.time ? ` · ${selectedInvoice.time}` : ''}</p>
                  {selectedInvoice.dueDate && <p className="text-xs text-warning mt-0.5">Due: {selectedInvoice.dueDate}</p>}
                </div>
              </div>

              {/* Customer & Salesperson */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Bill To</p>
                  <p className="text-sm font-medium text-foreground">{selectedInvoice.customer}</p>
                  <p className="text-xs text-muted">{selectedInvoice.phone}</p>
                  {selectedInvoice.address && <p className="text-xs text-muted mt-0.5">{selectedInvoice.address}</p>}
                  {selectedInvoice.gstNumber && <p className="text-xs text-muted mt-0.5">GSTIN: {selectedInvoice.gstNumber}</p>}
                  {selectedInvoice.placeOfSupply && (
                    <p className="text-xs text-muted mt-0.5">Place of Supply: {selectedInvoice.placeOfSupply}</p>
                  )}
                </div>
                <div className="text-right">
                  {selectedInvoice.salesperson && (
                    <>
                      <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Salesperson</p>
                      <p className="text-sm font-medium text-foreground">{selectedInvoice.salesperson}</p>
                    </>
                  )}
                </div>
              </div>

              {/* Items */}
              <table className="w-full text-sm mb-4">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">#</th>
                    <th className="text-left py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">Item</th>
                    <th className="text-center py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">SKU</th>
                    <th className="text-center py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">HSN</th>
                    <th className="text-center py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">Qty</th>
                    <th className="text-right py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">Rate</th>
                    <th className="text-right py-2 text-[10px] uppercase tracking-wider text-muted font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedInvoice.items.map((item, idx) => (
                    <tr key={idx} className="border-b border-border/50">
                      <td className="py-2.5 text-muted">{idx + 1}</td>
                      <td className="py-2.5 text-foreground font-medium">{item.name}</td>
                      <td className="py-2.5 text-center text-muted font-mono text-xs">{item.sku || '—'}</td>
                      <td className="py-2.5 text-center text-muted text-xs">{item.hsnCode || '-'}</td>
                      <td className="py-2.5 text-center text-foreground">{invoiceQuantityLabel(item)}</td>
                      <td className="py-2.5 text-right text-foreground">{formatFullCurrency(item.price)}</td>
                      <td className="py-2.5 text-right font-semibold text-foreground">{formatFullCurrency(invoiceLineAmount(item))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-72 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.subtotal)}</span></div>
                  {selectedInvoice.discount > 0 && (
                    <div className="flex justify-between"><span className="text-muted">Discount</span><span className="text-success">-{formatFullCurrency(selectedInvoice.discount)}</span></div>
                  )}
                  {selectedInvoice.transportCost > 0 && (
                    <div className="flex justify-between"><span className="text-muted">Transport Cost</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.transportCost)}</span></div>
                  )}
                  {selectedInvoice.freightCharge > 0 && (
                    <div className="flex justify-between"><span className="text-muted">Freight</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.freightCharge)}</span></div>
                  )}
                  {selectedInvoice.loadingCharge > 0 && (
                    <div className="flex justify-between"><span className="text-muted">Loading / unloading</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.loadingCharge)}</span></div>
                  )}
                  {selectedInvoice.installationCharge > 0 && (
                    <div className="flex justify-between"><span className="text-muted">Installation / fabrication</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.installationCharge)}</span></div>
                  )}
                  {(selectedInvoice.supplyType === 'INTERSTATE' || selectedInvoice.igst > 0) ? (
                    <div className="flex justify-between text-xs"><span className="text-muted">IGST</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.igst || 0)}</span></div>
                  ) : (
                    <>
                      <div className="flex justify-between text-xs"><span className="text-muted">CGST</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.cgst)}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-muted">SGST</span><span className="text-foreground">{formatFullCurrency(selectedInvoice.sgst)}</span></div>
                    </>
                  )}
                  <div className="flex justify-between text-base font-bold pt-2 border-t border-border">
                    <span className="text-foreground">Total</span>
                    <span className="text-accent">{formatFullCurrency(selectedInvoice.total)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted">Amount Paid</span>
                    <span className="text-success font-medium">{formatFullCurrency(selectedInvoice.amountPaid)}</span>
                  </div>
                  {selectedInvoice.balanceDue > 0 && (
                    <div className="flex justify-between text-sm font-semibold">
                      <span className="text-red-600">Balance Due</span>
                      <span className="text-red-600">{formatFullCurrency(selectedInvoice.balanceDue)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Payment History */}
              {selectedInvoice.payments && selectedInvoice.payments.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border">
                  <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">Payment History</p>
                  <div className="space-y-1.5">
                    {selectedInvoice.payments.map((p, idx) => (
                      <div key={idx} className="flex items-center justify-between text-xs bg-surface-hover rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{p.method}</span>
                          {p.reference && <span className="text-muted font-mono">#{p.reference}</span>}
                          <span className="text-muted">{p.date}</span>
                        </div>
                        <span className="font-semibold text-success">{formatFullCurrency(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Credit Notes */}
              {selectedInvoice.creditNotes && selectedInvoice.creditNotes.length > 0 && (
                <div className="mt-4 pt-3 border-t border-border">
                  <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">Credit Notes</p>
                  <div className="space-y-1.5">
                    {selectedInvoice.creditNotes.map((cn, idx) => (
                      <div key={idx} className="flex items-center justify-between text-xs bg-purple-500/5 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-purple-700">{cn.displayId}</span>
                          <span className="text-muted">{cn.reason}</span>
                          <span className="text-muted">{cn.date}</span>
                        </div>
                        <span className="font-semibold text-purple-700">-{formatFullCurrency(cn.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Notes */}
              {selectedInvoice.notes && (
                <div className="mt-3 pt-3 border-t border-border">
                  <p className="text-xs text-muted"><span className="font-medium">Notes:</span> {selectedInvoice.notes}</p>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => handleShareInvoiceWhatsApp(selectedInvoice)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-500/10 text-emerald-700 border border-emerald-500/20 rounded-xl text-sm font-medium hover:bg-emerald-500/20 transition-colors">
                <MessageSquare className="w-4 h-4" /> WhatsApp
              </button>
              <button onClick={() => handleShareInvoiceEmail(selectedInvoice)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-blue-500/10 text-blue-700 border border-blue-500/20 rounded-xl text-sm font-medium hover:bg-blue-500/20 transition-colors">
                <Mail className="w-4 h-4" /> Email
              </button>
              <button onClick={() => handlePrintInvoice(selectedInvoice)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-accent text-white rounded-xl text-sm font-medium hover:bg-accent-hover transition-colors">
                <Printer className="w-4 h-4" /> Print
              </button>
              <button onClick={() => handleDownloadInvoice(selectedInvoice)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-surface border border-border text-muted rounded-xl text-sm font-medium hover:text-accent hover:border-accent/40 transition-colors">
                <Download className="w-4 h-4" /> Download
              </button>
              {selectedInvoice.invoiceStatus === 'ACTIVE' && selectedInvoice.balanceDue > 0 && (
                <button onClick={() => { setPaymentModalData({ amount: selectedInvoice.balanceDue, method: 'Cash', reference: '', notes: '' }); setShowPaymentModal(true); }}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-success text-white rounded-xl text-sm font-medium hover:bg-success/90 transition-colors">
                  <BadgeIndianRupee className="w-4 h-4" /> Record Payment
                </button>
              )}
              {selectedInvoice.invoiceStatus === 'ACTIVE' && (
                <>
                  <button onClick={() => { setCreditNoteData({ amount: '', reason: '' }); setShowCreditNoteModal(true); }}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 bg-surface border border-border text-muted rounded-xl text-sm font-medium hover:text-purple-700 hover:border-purple-700/30 transition-colors">
                    <RotateCcw className="w-4 h-4" /> Credit Note
                  </button>
                  <button onClick={handleMoveInvoiceToDraft}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 bg-red-500/10 border border-red-500/20 text-red-700 rounded-xl text-sm font-medium hover:bg-red-500/20 transition-colors">
                    <Trash2 className="w-4 h-4" /> Move to Draft
                  </button>
                  <button onClick={() => setShowCancelConfirm(true)}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 bg-surface border border-border text-muted rounded-xl text-sm font-medium hover:text-red-600 hover:border-red-600/30 transition-colors">
                    <Ban className="w-4 h-4" /> Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* ─── RECORD PAYMENT MODAL ─── */}
      <Modal isOpen={showPaymentModal} onClose={() => setShowPaymentModal(false)} title="Record Payment" size="sm">
        {selectedInvoice && (
          <div className="space-y-4">
            <div className="p-3 bg-surface rounded-xl text-sm">
              <div className="flex justify-between"><span className="text-muted">Invoice</span><span className="font-mono font-medium text-accent">{selectedInvoice.id}</span></div>
              <div className="flex justify-between mt-1"><span className="text-muted">Balance Due</span><span className="font-semibold text-red-600">{formatFullCurrency(selectedInvoice.balanceDue)}</span></div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted mb-1.5 block">Amount *</label>
              <div className="relative">
                <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                <input type="number" min="1" max={selectedInvoice.balanceDue} value={paymentModalData.amount}
                  onChange={e => setPaymentModalData({ ...paymentModalData, amount: e.target.value })}
                  className="w-full pl-9 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
              <div className="flex gap-1.5 mt-2">
                {[selectedInvoice.balanceDue, Math.round(selectedInvoice.balanceDue / 2)].filter(a => a > 0).map(a => (
                  <button key={a} onClick={() => setPaymentModalData({ ...paymentModalData, amount: a })}
                    className="px-2.5 py-1 rounded-lg text-[10px] font-medium bg-surface-hover border border-border text-muted hover:text-foreground transition-colors">
                    {a === selectedInvoice.balanceDue ? 'Full' : 'Half'} ({formatCurrency(a)})
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted mb-1.5 block">Payment Method</label>
              <div className="grid grid-cols-3 gap-1.5">
                {paymentMethods.map(method => {
                  const Icon = paymentMethodIcons[method] || CreditCard;
                  return (
                    <button key={method} onClick={() => setPaymentModalData({ ...paymentModalData, method })}
                      className={`py-2 rounded-xl text-xs font-medium transition-all border flex items-center justify-center gap-1.5 ${paymentModalData.method === method ? 'bg-accent text-white border-accent' : 'bg-surface border-border text-muted hover:text-foreground'}`}>
                      <Icon className="w-3 h-3" /> {method}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted mb-1.5 block">Reference / Transaction ID</label>
              <input type="text" placeholder="e.g. UPI Ref, Cheque No." value={paymentModalData.reference}
                onChange={e => setPaymentModalData({ ...paymentModalData, reference: e.target.value })}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted mb-1.5 block">Notes</label>
              <input type="text" placeholder="Optional notes" value={paymentModalData.notes}
                onChange={e => setPaymentModalData({ ...paymentModalData, notes: e.target.value })}
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
            <button onClick={handleRecordPayment} disabled={!paymentModalData.amount || submitting}
              className="w-full py-3 bg-success text-white rounded-xl text-sm font-semibold hover:bg-success/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              {submitting ? 'Processing...' : <><BadgeIndianRupee className="w-4 h-4" /> Record Payment</>}
            </button>
          </div>
        )}
      </Modal>

      {/* ─── CREDIT NOTE MODAL ─── */}
      <Modal isOpen={showCreditNoteModal} onClose={() => setShowCreditNoteModal(false)} title="Create Credit Note" size="sm">
        {selectedInvoice && (
          <div className="space-y-4">
            <div className="p-3 bg-surface rounded-xl text-sm">
              <div className="flex justify-between"><span className="text-muted">Invoice</span><span className="font-mono font-medium text-accent">{selectedInvoice.id}</span></div>
              <div className="flex justify-between mt-1"><span className="text-muted">Invoice Total</span><span className="font-semibold">{formatFullCurrency(selectedInvoice.total)}</span></div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted mb-1.5 block">Credit Amount *</label>
              <div className="relative">
                <IndianRupee className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
                <input type="number" min="1" max={selectedInvoice.total} value={creditNoteData.amount}
                  onChange={e => setCreditNoteData({ ...creditNoteData, amount: e.target.value })}
                  className="w-full pl-9 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-accent/50" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted mb-1.5 block">Reason *</label>
              <textarea value={creditNoteData.reason} onChange={e => setCreditNoteData({ ...creditNoteData, reason: e.target.value })}
                rows={2} placeholder="e.g. Product return, defective item, overcharge..."
                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm resize-none placeholder:text-muted focus:outline-none focus:border-accent/50" />
            </div>
            <button onClick={handleCreateCreditNote} disabled={!creditNoteData.amount || !creditNoteData.reason || submitting}
              className="w-full py-3 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              {submitting ? 'Processing...' : <><RotateCcw className="w-4 h-4" /> Create Credit Note</>}
            </button>
          </div>
        )}
      </Modal>

      {/* ─── CANCEL CONFIRM MODAL ─── */}
      <Modal isOpen={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} title="Cancel Invoice" size="sm">
        {selectedInvoice && (
          <div className="space-y-4">
            <div className="p-4 bg-red-500/5 border border-red-500/20 rounded-xl">
              <p className="text-sm text-red-700 font-medium">Are you sure you want to cancel invoice {selectedInvoice.id}?</p>
              <p className="text-xs text-red-600/70 mt-1">This will mark the invoice as cancelled. This action cannot be undone.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowCancelConfirm(false)}
                className="flex-1 py-2.5 bg-surface border border-border text-foreground rounded-xl text-sm font-medium hover:bg-surface-hover transition-colors">
                Keep Invoice
              </button>
              <button onClick={handleCancelInvoice} disabled={submitting}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                {submitting ? 'Cancelling...' : <><Ban className="w-4 h-4" /> Cancel Invoice</>}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ─── MOVE TO DRAFT MODAL ─── */}
      <Modal isOpen={!!invoiceToDraft} onClose={() => setInvoiceToDraft(null)} title="Move Invoice to Draft" size="sm">
        {invoiceToDraft && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Move invoice <strong className="text-foreground">{invoiceToDraft.id}</strong> to drafts? It will be permanently deleted after 30 days.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setInvoiceToDraft(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
              <button onClick={confirmMoveInvoiceToDraft} disabled={movingInvoiceToDraft} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{movingInvoiceToDraft ? 'Moving...' : 'Move to Draft'}</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
