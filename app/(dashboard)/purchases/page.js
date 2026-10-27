'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Search, Plus, Truck, Users, RotateCcw, CheckCircle, XCircle, Trash2,
  Eye, FileText, ArrowDownCircle, Clock, AlertTriangle,
  Download, MessageSquare, Mail
} from 'lucide-react'
import {
  getSuppliers, createSupplier, updateSupplier, getPurchaseOrders, createPurchaseOrder,
  approvePurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder,
  receiveStoneLotFromPurchaseOrder,
  getPurchaseReturns, createPurchaseReturn, getPurchaseStats, recordPurchaseOrderPayment,
  updatePurchaseOrder
} from '@/app/actions/purchases'
import { createBillFromPurchaseOrder } from '@/app/actions/vendor-bills'
import { getProducts, createProduct } from '@/app/actions/products'
import { getGodowns } from '@/app/actions/godowns'
import { getStoreSettings } from '@/app/actions/settings'
import { movePurchaseOrderToDraft } from '@/app/actions/drafts'
import Modal from '@/components/Modal'
import { useAlertToast } from '@/components/AlertToastProvider'
import { getActiveVertical } from '@/lib/brand'

const DEFAULT_STORE_NAME = getActiveVertical() === 'tiles' ? 'Tiles, Granite & Marble Showroom' : 'Furniture Store'

const poStatusColors = {
  DRAFT: 'bg-gray-500/10 text-gray-400',
  APPROVED: 'bg-blue-500/10 text-blue-400',
  PARTIALLY_RECEIVED: 'bg-amber-500/10 text-amber-400',
  RECEIVED: 'bg-emerald-500/10 text-emerald-400',
  CANCELLED: 'bg-red-500/10 text-red-400',
}

const ITC_CATEGORIES = ['INPUTS', 'SERVICES', 'CAPITAL_GOODS', 'INELIGIBLE']
const CUSTOM_PO_CATEGORY = 'Custom PO'
const CUSTOM_SKU_PREFIX = 'CPO'

const formatCurrency = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`

const formatDate = (value) => {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-IN')
}

const buildMailtoUrl = (email, subject, body) => {
  if (!email) return ''
  const params = new URLSearchParams()
  if (subject) params.set('subject', subject)
  if (body) params.set('body', body)
  return `mailto:${email}?${params.toString()}`
}

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const buildPurchaseOrderShareMessage = (po, storeSettings) => {
  const storeName = storeSettings?.storeName || DEFAULT_STORE_NAME
  const contactBits = []
  if (storeSettings?.phone) contactBits.push(`Phone: ${storeSettings.phone}`)
  if (storeSettings?.whatsappNumber) contactBits.push(`WhatsApp: ${storeSettings.whatsappNumber}`)
  if (storeSettings?.email) contactBits.push(`Email: ${storeSettings.email}`)
  if (storeSettings?.gstNumber) contactBits.push(`GSTIN: ${storeSettings.gstNumber}`)
  if (storeSettings?.address) contactBits.push(`Address: ${storeSettings.address}`)

  const itemLines = (po.items || []).map(item => (
    `- ${item.name} (${item.sku}) | Qty ${item.quantity} | INR ${Number(item.amount || 0).toLocaleString('en-IN')}`
  ))

  return [
    `*Purchase Order ${po.displayId}*`,
    `Supplier: ${po.supplier?.name || ''}`.trim(),
    `PO Date: ${formatDate(po.date)}`,
    `Expected Delivery: ${formatDate(po.expectedDate)}`,
    `Total: INR ${Number(po.total || 0).toLocaleString('en-IN')}`,
    po.supplier?.paymentTerms ? `Payment Terms: ${po.supplier.paymentTerms} days` : null,
    '',
    'Items:',
    ...itemLines,
    '',
    contactBits.length > 0 ? `Issued by ${storeName} · ${contactBits.join(' | ')}` : `Issued by ${storeName}`,
  ].filter(Boolean).join('\n')
}

const buildPurchaseOrderDocumentHtml = (po, storeSettings) => {
  const store = storeSettings || {}
  const supplier = po.supplier || {}
  const hasIgst = Number(po.igst || 0) > 0
  const hasGst = Number(po.gst || 0) > 0 || Number(po.igst || 0) > 0

  const itemRows = (po.items || []).map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.sku)}</td>
      <td>${escapeHtml(item.hsnCode || '-')}</td>
      <td style="text-align:center">${item.quantity}</td>
      <td style="text-align:right">₹${Number(item.unitCost || 0).toLocaleString('en-IN')}</td>
      <td style="text-align:center">${Number(item.gstRate || 0)}%</td>
      <td style="text-align:right;font-weight:600">₹${Number(item.amount || 0).toLocaleString('en-IN')}</td>
    </tr>
  `).join('')

  return `
  <html>
    <head>
      <title>Purchase Order ${escapeHtml(po.displayId)}</title>
      <style>
        body { font-family: 'Segoe UI', sans-serif; padding: 32px; color: #111827; max-width: 860px; margin: 0 auto; }
        @page { size: A4; margin: 12mm; }
        .header { display:flex; justify-content:space-between; border-bottom:2px solid #e5e7eb; padding-bottom:16px; margin-bottom:16px; }
        .brand { font-size:22px; font-weight:700; color:#0f172a; }
        .meta { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:16px; margin-bottom:18px; }
        .label { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; }
        .box { border:1px solid #e5e7eb; border-radius:8px; padding:12px; }
        table { width:100%; border-collapse:collapse; margin-top:12px; }
        th { text-align:left; font-size:11px; text-transform:uppercase; color:#6b7280; border-bottom:1px solid #e5e7eb; padding:8px 6px; }
        td { padding:8px 6px; border-bottom:1px solid #f3f4f6; font-size:12px; }
        .totals { margin-top:12px; width: 320px; margin-left:auto; }
        .totals .row { display:flex; justify-content:space-between; padding:4px 0; font-size:12px; }
        .totals .grand { border-top:2px solid #111827; padding-top:8px; font-size:14px; font-weight:700; }
        .notes { margin-top:14px; font-size:12px; color:#4b5563; background:#f9fafb; padding:10px; border-radius:8px; border:1px solid #e5e7eb; }
        @media print { body { padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <div class="brand">${escapeHtml(store.storeName || DEFAULT_STORE_NAME)}</div>
          ${store.address ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${escapeHtml(store.address)}</div>` : ''}
          <div style="font-size:12px;color:#6b7280">${escapeHtml(store.phone || '')}${store.email ? ` · ${escapeHtml(store.email)}` : ''}</div>
          ${store.gstNumber ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">GSTIN: ${escapeHtml(store.gstNumber)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:700">${escapeHtml(po.displayId)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">PO Date: ${formatDate(po.date)}</div>
          <div style="font-size:12px;color:#6b7280">Expected: ${formatDate(po.expectedDate)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">Status: ${escapeHtml(po.status || '')}</div>
        </div>
      </div>

      <div class="meta">
        <div class="box">
          <div class="label">Supplier</div>
          <div style="font-weight:600;margin-top:6px">${escapeHtml(supplier.name || '')}</div>
          ${supplier.contactPerson ? `<div style="font-size:12px;color:#6b7280">${escapeHtml(supplier.contactPerson)}</div>` : ''}
          ${supplier.phone ? `<div style="font-size:12px;color:#6b7280">${escapeHtml(supplier.phone)}</div>` : ''}
          ${supplier.email ? `<div style="font-size:12px;color:#6b7280">${escapeHtml(supplier.email)}</div>` : ''}
          ${supplier.gstNumber ? `<div style="font-size:12px;color:#6b7280">GSTIN: ${escapeHtml(supplier.gstNumber)}</div>` : ''}
          ${supplier.address ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${escapeHtml(supplier.address)}</div>` : ''}
        </div>
        <div class="box">
          <div class="label">Ship To</div>
          <div style="font-weight:600;margin-top:6px">${escapeHtml(store.storeName || DEFAULT_STORE_NAME)}</div>
          ${store.address ? `<div style="font-size:12px;color:#6b7280">${escapeHtml(store.address)}</div>` : ''}
          ${store.phone ? `<div style="font-size:12px;color:#6b7280">${escapeHtml(store.phone)}</div>` : ''}
          ${store.gstNumber ? `<div style="font-size:12px;color:#6b7280">GSTIN: ${escapeHtml(store.gstNumber)}</div>` : ''}
        </div>
        <div class="box">
          <div class="label">Compliance</div>
          <div style="font-size:12px;color:#6b7280;margin-top:6px">ITC: ${po.itcEligible ? escapeHtml(po.itcCategory || 'INPUTS') : 'Ineligible'}</div>
          <div style="font-size:12px;color:#6b7280">RCM: ${po.isRCM ? 'Yes' : 'No'}</div>
          ${supplier.paymentTerms ? `<div style="font-size:12px;color:#6b7280">Payment Terms: ${supplier.paymentTerms} days</div>` : ''}
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th>SKU</th>
            <th>HSN</th>
            <th style="text-align:center">Qty</th>
            <th style="text-align:right">Unit Cost</th>
            <th style="text-align:center">GST</th>
            <th style="text-align:right">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>

      <div class="totals">
        <div class="row"><span>Subtotal</span><span>₹${Number(po.subtotal || 0).toLocaleString('en-IN')}</span></div>
        ${Number(po.discount || 0) > 0 ? `<div class="row"><span>Discount</span><span>-₹${Number(po.discount || 0).toLocaleString('en-IN')}</span></div>` : ''}
        ${hasGst
          ? (hasIgst
            ? `<div class="row"><span>IGST</span><span>₹${Number(po.igst || 0).toLocaleString('en-IN')}</span></div>`
            : `<div class="row"><span>CGST</span><span>₹${Number(po.cgst || 0).toLocaleString('en-IN')}</span></div>
               <div class="row"><span>SGST</span><span>₹${Number(po.sgst || 0).toLocaleString('en-IN')}</span></div>`)
          : `<div class="row"><span>GST</span><span>₹0</span></div>`}
        <div class="row grand"><span>Total</span><span>₹${Number(po.total || 0).toLocaleString('en-IN')}</span></div>
        ${Number(po.amountPaid || 0) > 0 ? `<div class="row"><span>Paid</span><span>₹${Number(po.amountPaid || 0).toLocaleString('en-IN')}</span></div>` : ''}
        ${Number(po.balanceDue || 0) > 0 ? `<div class="row"><span>Balance Due</span><span>₹${Number(po.balanceDue || 0).toLocaleString('en-IN')}</span></div>` : ''}
      </div>

      ${po.notes ? `<div class="notes"><strong>Notes:</strong> ${escapeHtml(po.notes)}</div>` : ''}
    </body>
  </html>
  `
}

const buildPurchaseOrderPdfFile = async (po, storeSettings) => {
  const html = buildPurchaseOrderDocumentHtml(po, storeSettings)
  if (!html) return null

  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.left = '-10000px'
  wrapper.style.top = '0'
  wrapper.style.width = '794px'
  wrapper.style.background = '#ffffff'
  wrapper.innerHTML = `${parsed.head.innerHTML}${parsed.body.innerHTML}`
  document.body.appendChild(wrapper)

  try {
    const [{ jsPDF }, html2canvasModule] = await Promise.all([
      import('jspdf'),
      import('html2canvas'),
    ])
    const html2canvas = html2canvasModule.default
    const canvas = await html2canvas(wrapper, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    })
    const imgData = canvas.toDataURL('image/png')
    const pdf = new jsPDF('p', 'pt', 'a4')
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const imgWidth = pageWidth
    const imgHeight = (canvas.height * imgWidth) / canvas.width

    let heightLeft = imgHeight
    let position = 0

    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight)
    heightLeft -= pageHeight

    while (heightLeft > 0) {
      position = heightLeft - imgHeight
      pdf.addPage()
      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight)
      heightLeft -= pageHeight
    }

    const blob = pdf.output('blob')
    const safeId = String(po?.displayId || 'PO').replace(/[^a-zA-Z0-9_-]/g, '_')
    return new File([blob], `${safeId}.pdf`, { type: 'application/pdf' })
  } finally {
    wrapper.remove()
  }
}

const createEmptyPOItem = (overrides = {}) => ({
  productId: '',
  quantity: 1,
  unitCost: 0,
  gstRate: 18,
  hsnCode: '',
  isCustom: false,
  customName: '',
  customSku: '',
  customUom: 'PCS',
  ...overrides,
})

const generateCustomSku = (name) => {
  const base = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const stamp = Date.now().toString(36).toUpperCase()
  return `${CUSTOM_SKU_PREFIX}-${base || 'ITEM'}-${stamp}`
}

const createEmptyPOForm = () => ({
  supplierId: '',
  expectedDate: '',
  discount: 0,
  isRCM: false,
  itcEligible: true,
  itcCategory: 'INPUTS',
  applyGst: true,
  notes: '',
  items: [createEmptyPOItem()],
})

const createEmptySupplierForm = () => ({
  name: '',
  phone: '',
  email: '',
  gstNumber: '',
  address: '',
  contactPerson: '',
  paymentTerms: 30,
})

export default function PurchasesPage() {
  const [tab, setTab] = useState('orders')
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState([])
  const [suppliers, setSuppliers] = useState([])
  const [returns, setReturns] = useState([])
  const [products, setProducts] = useState([])
  const [godowns, setGodowns] = useState([])
  const [stats, setStats] = useState(null)
  const [storeSettings, setStoreSettings] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')

  // Modals
  const [showSupplierModal, setShowSupplierModal] = useState(false)
  const [showPOModal, setShowPOModal] = useState(false)
  const [showReturnModal, setShowReturnModal] = useState(false)
  const [showDetailModal, setShowDetailModal] = useState(false)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [selectedPO, setSelectedPO] = useState(null)
  const [editingSupplierId, setEditingSupplierId] = useState(null)
  const [editingPOId, setEditingPOId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const { notify } = useAlertToast()
  const [poToCancel, setPoToCancel] = useState(null)
  const [cancelingPo, setCancelingPo] = useState(false)
  const [poToDraft, setPoToDraft] = useState(null)
  const [movingPoToDraft, setMovingPoToDraft] = useState(false)

  // Forms
  const [supplierForm, setSupplierForm] = useState(createEmptySupplierForm())
  const [poForm, setPOForm] = useState(createEmptyPOForm())
  const [returnForm, setReturnForm] = useState({ poId: '', supplierId: '', godownId: '', reason: '', notes: '', items: [{ productId: '', quantity: 1, unitCost: 0 }] })
  const [stoneReceivePO, setStoneReceivePO] = useState(null)
  const [stoneReceiveForm, setStoneReceiveForm] = useState({ poItemId: '', lotNumber: '', godownId: '', origin: '', shadeCode: '', qualityGrade: '', thicknessMm: '', costPerSqft: '', notes: '', slabsText: '01/01, 120, 72' })
  const [paymentForm, setPaymentForm] = useState({ poId: '', amount: '', note: '', method: 'Bank Transfer', reference: '', paidAt: new Date().toISOString().slice(0, 10) })

  const loadData = useCallback(() => {
    setLoading(true)
    Promise.all([
      getPurchaseOrders(),
      getSuppliers(),
      getPurchaseReturns(),
      getProducts(),
      getGodowns(),
      getPurchaseStats(),
      getStoreSettings(),
    ])
      .then(([poRes, supRes, retRes, prodRes, godownRes, statsRes, settingsRes]) => {
        if (poRes.success) setOrders(poRes.data)
        if (supRes.success) setSuppliers(supRes.data)
        if (retRes.success) setReturns(retRes.data)
        if (prodRes.success) setProducts(prodRes.data)
        if (godownRes.success) setGodowns(godownRes.data)
        if (statsRes.success) setStats(statsRes.data)
        if (settingsRes.success) setStoreSettings(settingsRes.data)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void loadData() }, 0)
    return () => clearTimeout(timer)
  }, [loadData])

  const filteredOrders = useMemo(() => orders.filter(o =>
    (statusFilter === 'All' || o.status === statusFilter) &&
    (o.displayId?.toLowerCase().includes(search.toLowerCase()) ||
     o.supplier?.name?.toLowerCase().includes(search.toLowerCase()))
  ), [orders, search, statusFilter])

  const filteredSuppliers = useMemo(() => suppliers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.phone?.toLowerCase().includes(search.toLowerCase()) ||
    s.gstNumber?.toLowerCase().includes(search.toLowerCase())
  ), [suppliers, search])

  const poPreview = useMemo(() => {
    const rows = poForm.items
      .filter(item => item.productId || (item.isCustom && item.customName))
      .map(item => {
        const quantity = Math.max(1, Number(item.quantity) || 1)
        const unitCost = Math.max(0, Number(item.unitCost) || 0)
        const gstRate = poForm.applyGst ? Math.max(0, Number(item.gstRate) || 0) : 0
        return { amount: quantity * unitCost, gstRate }
      })

    const subtotal = rows.reduce((sum, row) => sum + row.amount, 0)
    const discount = Math.min(subtotal, Math.max(0, Number(poForm.discount) || 0))
    const taxable = Math.max(0, subtotal - discount)
    const grossGst = rows.reduce((sum, row) => sum + Math.round(row.amount * row.gstRate / 100), 0)
    const gst = Math.max(0, Math.round(grossGst * (subtotal > 0 ? taxable / subtotal : 1)))

    return {
      subtotal,
      discount,
      taxable,
      gst,
      total: taxable + gst,
    }
  }, [poForm.items, poForm.discount, poForm.applyGst])

  const resetSupplierForm = () => {
    setEditingSupplierId(null)
    setSupplierForm(createEmptySupplierForm())
  }

  const openCreateSupplierModal = () => {
    resetSupplierForm()
    setShowSupplierModal(true)
  }

  const openEditSupplierModal = (supplier) => {
    setEditingSupplierId(supplier.id)
    setSupplierForm({
      name: supplier.name || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      gstNumber: supplier.gstNumber || '',
      address: supplier.address || '',
      contactPerson: supplier.contactPerson || '',
      paymentTerms: Number(supplier.paymentTerms || 0),
    })
    setShowSupplierModal(true)
  }

  const handleSaveSupplier = async () => {
    setSubmitting(true)
    const payload = { ...supplierForm, paymentTerms: Number(supplierForm.paymentTerms) }
    const res = editingSupplierId
      ? await updateSupplier(editingSupplierId, payload)
      : await createSupplier(payload)

    if (res.success) {
      setShowSupplierModal(false)
      resetSupplierForm()
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  const resetPOForm = () => {
    setEditingPOId(null)
    setPOForm(createEmptyPOForm())
  }

  const openCreatePOModal = () => {
    resetPOForm()
    setShowPOModal(true)
  }

  const handleEditPO = (po) => {
    if (po.status !== 'DRAFT') {
      alert('Only DRAFT purchase orders can be edited')
      return
    }

    const editableItems = (po.items || []).map(item => ({
      productId: String(item.productId || ''),
      quantity: Number(item.quantity || 1),
      unitCost: Number(item.unitCost || 0),
      gstRate: typeof item.gstRate === 'number' ? item.gstRate : 18,
      hsnCode: item.hsnCode || '',
      isCustom: false,
      customName: '',
      customSku: '',
      customUom: 'PCS',
    }))
    const applyGst = Number(po.gst || 0) > 0 || (po.items || []).some(item => Number(item.gstRate || 0) > 0)

    setEditingPOId(po.id)
    setPOForm({
      supplierId: String(po.supplierId || ''),
      expectedDate: po.expectedDate ? new Date(po.expectedDate).toISOString().slice(0, 10) : '',
      discount: Number(po.discount || 0),
      isRCM: !!po.isRCM,
      itcEligible: po.itcEligible !== false,
      itcCategory: po.itcCategory || 'INPUTS',
      applyGst,
      notes: po.notes || '',
      items: editableItems.length > 0 ? editableItems : createEmptyPOForm().items,
    })
    setShowDetailModal(false)
    setShowPOModal(true)
  }

  const handleCreatePO = async () => {
    setSubmitting(true)
    const isEditMode = Boolean(editingPOId)

    try {
      const items = []

      for (const item of poForm.items) {
        const quantity = Math.max(1, Number(item.quantity) || 1)
        const unitCost = Math.max(0, Number(item.unitCost) || 0)
        const gstRate = poForm.applyGst ? Math.max(0, Number(item.gstRate) || 0) : 0

        if (item.isCustom) {
          if (!item.customName?.trim()) continue

          let sku = item.customSku?.trim()
          let existingProduct = null

          if (sku) {
            existingProduct = products.find(p => p.sku === sku) || null
          }

          let product = existingProduct
          if (!product) {
            sku = sku || generateCustomSku(item.customName)
            const createRes = await createProduct({
              sku,
              name: item.customName.trim(),
              category: CUSTOM_PO_CATEGORY,
              price: unitCost,
              costPrice: unitCost,
              stock: 0,
              reorderLevel: 0,
              unitOfMeasure: item.customUom || 'PCS',
              description: 'Created from purchase order',
            })

            if (!createRes?.success) {
              notify(createRes?.error || 'Failed to create custom product', { variant: 'danger' })
              setSubmitting(false)
              return
            }
            product = createRes.data
          }

          items.push({
            productId: Number(product.id),
            name: product.name || item.customName.trim(),
            sku: product.sku || sku || '',
            hsnCode: item.hsnCode || '',
            quantity,
            unitCost,
            gstRate,
          })
          continue
        }

        if (!item.productId) continue
        const prod = products.find(p => p.id === Number(item.productId))
        if (!prod) continue

        items.push({
          productId: Number(item.productId),
          name: prod?.name || '',
          sku: prod?.sku || '',
          hsnCode: item.hsnCode || prod?.hsnCode || '',
          quantity,
          unitCost,
          gstRate,
        })
      }

      if (items.length === 0) {
        notify('Add at least one item to create a purchase order', { variant: 'danger' })
        setSubmitting(false)
        return
      }

      const payload = {
        supplierId: Number(poForm.supplierId),
        expectedDate: poForm.expectedDate || undefined,
        discount: Math.max(0, Number(poForm.discount) || 0),
        isRCM: !!poForm.isRCM,
        itcEligible: !!poForm.itcEligible,
        itcCategory: poForm.itcCategory,
        notes: poForm.notes,
        items,
      }

      const res = isEditMode
        ? await updatePurchaseOrder(editingPOId, payload)
        : await createPurchaseOrder(payload)

      if (res.success) {
        setShowPOModal(false)
        resetPOForm()
        loadData()
      } else alert(res.error)
    } catch (err) {
      notify(err?.message || 'Failed to create purchase order', { variant: 'danger' })
    } finally {
      setSubmitting(false)
    }
  }

  const handleApprovePO = async (id) => {
    const res = await approvePurchaseOrder(id)
    if (res.success) {
      if (res.warning) alert(res.warning)
      if (res.message) alert(res.message)
      loadData()
    } else alert(res.error)
  }

  const handleReceivePO = async (id) => {
    const res = await receivePurchaseOrder(id)
    if (res.success) {
      notify('All pending quantities received into stock', { variant: 'success' })
      loadData()
    } else notify(res.error, { variant: 'danger' })
  }

  // Partial receipts, backorders and the receiving location live on the
  // goods receipt (GRN) in Inventory → Operations.
  // Odoo bill control: bill what was received, matched against the PO.
  const handleCreateBill = async (po) => {
    const res = await createBillFromPurchaseOrder(po.id)
    if (!res.success) return notify(res.error, { variant: 'danger' })
    window.location.href = `/vendor-bills/${res.data.id}`
  }

  const openReceipt = (po) => {
    window.location.href = `/operations?type=RECEIPT&status=READY&search=${encodeURIComponent(po.displayId)}`
  }

  const openStoneReceive = (po) => {
    const firstStoneItem = (po.items || []).find(item => item.product?.isSlabTracked && item.receivedQty < item.quantity)
    setStoneReceivePO(po)
    setStoneReceiveForm(form => ({ ...form, poItemId: firstStoneItem ? String(firstStoneItem.id) : '', lotNumber: '', slabsText: '01/01, 120, 72' }))
  }

  const handleStoneReceive = async () => {
    if (!stoneReceivePO) return
    const slabs = stoneReceiveForm.slabsText.split('\n').map((line, index) => {
      const [slabNumber, length, width] = line.split(',').map(value => value.trim())
      return { slabNumber: slabNumber || String(index + 1), lengthInches: Number(length), widthInches: Number(width) }
    }).filter(slab => slab.slabNumber && slab.lengthInches > 0 && slab.widthInches > 0)
    const result = await receiveStoneLotFromPurchaseOrder({
      poId: stoneReceivePO.id,
      poItemId: Number(stoneReceiveForm.poItemId),
      lotNumber: stoneReceiveForm.lotNumber,
      godownId: stoneReceiveForm.godownId ? Number(stoneReceiveForm.godownId) : undefined,
      origin: stoneReceiveForm.origin || undefined,
      shadeCode: stoneReceiveForm.shadeCode || undefined,
      qualityGrade: stoneReceiveForm.qualityGrade || undefined,
      avgThicknessMm: stoneReceiveForm.thicknessMm ? Number(stoneReceiveForm.thicknessMm) : undefined,
      costPerSqft: Number(stoneReceiveForm.costPerSqft) || 0,
      notes: stoneReceiveForm.notes || undefined,
      slabs,
    })
    if (result.success) { setStoneReceivePO(null); loadData(); notify('Stone lot received and linked to the purchase order.', { variant: 'success' }) }
    else notify(result.error || 'Could not receive stone lot', { variant: 'danger' })
  }

  const handleCancelPO = (id) => {
    setPoToCancel(id)
  }

  const confirmCancelPO = async () => {
    if (!poToCancel) return
    setCancelingPo(true)
    try {
      const res = await cancelPurchaseOrder(poToCancel)
      if (res.success) {
        notify('Purchase order cancelled', { variant: 'info' })
        loadData()
      } else {
        notify(res.error || 'Failed to cancel purchase order', { variant: 'danger' })
      }
    } catch (err) {
      notify(err?.message || 'Failed to cancel purchase order', { variant: 'danger' })
    } finally {
      setCancelingPo(false)
      setPoToCancel(null)
    }
  }

  const handleMovePOToDraft = (id) => {
    setPoToDraft(id)
  }

  const confirmMovePOToDraft = async () => {
    if (!poToDraft) return
    setMovingPoToDraft(true)
    try {
      const res = await movePurchaseOrderToDraft(poToDraft)
      if (res.success) {
        notify('Purchase order moved to drafts', { variant: 'success' })
        loadData()
      } else {
        notify(res.error || 'Failed to move purchase order to drafts', { variant: 'danger' })
      }
    } catch (err) {
      notify(err?.message || 'Failed to move purchase order to drafts', { variant: 'danger' })
    } finally {
      setMovingPoToDraft(false)
      setPoToDraft(null)
    }
  }

  const handleDownloadPO = (po) => {
    if (!po) return
    const printContent = buildPurchaseOrderDocumentHtml(po, storeSettings)
    if (!printContent) return
    const printFrame = document.createElement('iframe')
    printFrame.style.position = 'fixed'
    printFrame.style.right = '0'
    printFrame.style.bottom = '0'
    printFrame.style.width = '0'
    printFrame.style.height = '0'
    printFrame.style.border = '0'
    printFrame.onload = () => {
      const win = printFrame.contentWindow
      if (!win) return
      win.document.title = `Purchase Order ${po.displayId}`
      win.focus()
      win.print()
      setTimeout(() => {
        printFrame.remove()
      }, 500)
    }
    printFrame.srcdoc = printContent
    document.body.appendChild(printFrame)
  }

  const handleSharePOWhatsApp = async (po) => {
    if (!po) return
    try {
      const pdfFile = await buildPurchaseOrderPdfFile(po, storeSettings)
      if (!pdfFile) {
        notify('Unable to generate PO PDF', { variant: 'danger' })
        return
      }

      const shareData = {
        title: `Purchase Order ${po.displayId}`,
        text: `Purchase Order ${po.displayId}`,
        files: [pdfFile],
      }

      if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
        await navigator.share(shareData)
        return
      }

      const url = URL.createObjectURL(pdfFile)
      const link = document.createElement('a')
      link.href = url
      link.download = pdfFile.name
      link.click()
      URL.revokeObjectURL(url)
      notify('PDF downloaded. Share it on WhatsApp from your device.', { variant: 'info' })
    } catch (err) {
      notify(err?.message || 'WhatsApp sharing failed', { variant: 'danger' })
    }
  }

  const handleSharePOEmail = (po) => {
    if (!po?.supplier?.email) {
      notify('Supplier email is missing', { variant: 'danger' })
      return
    }
    const subject = `Purchase Order ${po.displayId} from ${storeSettings?.storeName || DEFAULT_STORE_NAME}`
    const body = buildPurchaseOrderShareMessage(po, storeSettings)
    const url = buildMailtoUrl(po.supplier.email, subject, body)
    if (!url) return
    window.location.href = url
  }

  const openPaymentModal = (po) => {
    setPaymentForm({
      poId: po.id,
      amount: String(po.balanceDue || ''),
      note: '',
      method: 'Bank Transfer',
      reference: '',
      paidAt: new Date().toISOString().slice(0, 10),
    })
    setShowPaymentModal(true)
  }

  const handleRecordPayment = async () => {
    const amount = Number(paymentForm.amount)
    if (!paymentForm.poId || !amount || amount <= 0) {
      alert('Enter a valid payment amount')
      return
    }

    setSubmitting(true)
    const res = await recordPurchaseOrderPayment(
      Number(paymentForm.poId),
      amount,
      paymentForm.note,
      paymentForm.method,
      paymentForm.reference,
      paymentForm.paidAt
    )
    if (res.success) {
      setShowPaymentModal(false)
      setPaymentForm({ poId: '', amount: '', note: '', method: 'Bank Transfer', reference: '', paidAt: new Date().toISOString().slice(0, 10) })
      loadData()
    } else {
      alert(res.error)
    }
    setSubmitting(false)
  }

  const handleCreateReturn = async () => {
    setSubmitting(true)
    const items = returnForm.items.filter(i => i.productId).map(i => {
      const prod = products.find(p => p.id === Number(i.productId))
      return { productId: Number(i.productId), name: prod?.name || '', sku: prod?.sku || '', quantity: Number(i.quantity), unitCost: Number(i.unitCost) }
    })
    const total = items.reduce((s, i) => s + i.quantity * i.unitCost, 0)
    const res = await createPurchaseReturn({
      poId: returnForm.poId ? Number(returnForm.poId) : undefined,
      supplierId: Number(returnForm.supplierId),
      godownId: returnForm.godownId ? Number(returnForm.godownId) : undefined,
      reason: returnForm.reason, notes: returnForm.notes,
      totalAmount: total, items
    })
    if (res.success) {
      setShowReturnModal(false)
      setReturnForm({ poId: '', supplierId: '', godownId: '', reason: '', notes: '', items: [{ productId: '', quantity: 1, unitCost: 0 }] })
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  // Confirm modals
  

  // Confirm modals
  

  const addPOItem = () => setPOForm(f => ({ ...f, items: [...f.items, createEmptyPOItem()] }))
  const addCustomPOItem = () => setPOForm(f => ({ ...f, items: [...f.items, createEmptyPOItem({ isCustom: true })] }))
  const addReturnItem = () => setReturnForm(f => ({ ...f, items: [...f.items, { productId: '', quantity: 1, unitCost: 0 }] }))

  const tabs = [
    { id: 'orders', label: 'Purchase Orders', icon: FileText },
    { id: 'suppliers', label: 'Suppliers', icon: Users },
    { id: 'returns', label: 'Returns', icon: RotateCcw },
  ]

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Purchase Management</h1>
          <p className="text-muted text-sm mt-1">Manage suppliers, purchase orders & returns</p>
        </div>
        <div className="flex gap-2 w-full md:w-auto flex-wrap">
          {tab === 'orders' && <button onClick={openCreatePOModal} className="w-full md:w-auto px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center justify-center gap-2"><Plus className="w-4 h-4" /> New PO</button>}
          {tab === 'suppliers' && <button onClick={openCreateSupplierModal} className="w-full md:w-auto px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center justify-center gap-2"><Plus className="w-4 h-4" /> Add Supplier</button>}
          {tab === 'returns' && <button onClick={() => setShowReturnModal(true)} className="w-full md:w-auto px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center justify-center gap-2"><Plus className="w-4 h-4" /> New Return</button>}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-1 -mx-4 px-4 md:mx-0 md:px-0 md:grid md:grid-cols-3 xl:grid-cols-5 md:gap-4">
          {[
            { label: 'Total POs', value: stats.totalPOs, icon: FileText, color: 'text-blue-400' },
            { label: 'Open Payables', value: `₹${(stats.outstandingPayables || 0).toLocaleString('en-IN')}`, icon: Truck, color: 'text-emerald-400' },
            { label: 'Pending Receipts', value: stats.pendingPOs, icon: Clock, color: 'text-amber-400' },
            { label: 'Overdue POs', value: stats.overduePOs, icon: AlertTriangle, color: 'text-red-400' },
            { label: 'Suppliers', value: stats.totalSuppliers || stats.suppliers, icon: Users, color: 'text-purple-400' },
          ].map((s, i) => (
            <div key={i} className="glass-card p-4 min-w-[160px] flex-shrink-0 md:min-w-0 md:flex-shrink">
              <div className="flex items-center gap-3">
                <s.icon className={`w-5 h-5 ${s.color}`} />
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="text-lg font-semibold text-foreground">{s.value}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="overflow-x-auto hide-scrollbar -mx-4 md:mx-0 px-4 md:px-0">
        <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 w-max">
          {tabs.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setSearch(''); setStatusFilter('All') }}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all whitespace-nowrap ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="relative w-full sm:flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50" />
        </div>
        {tab === 'orders' && (
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="w-full sm:w-auto px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50">
            {['All', 'DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'].map(s => <option key={s} value={s}>{s === 'All' ? 'All Status' : s.replace(/_/g, ' ')}</option>)}
          </select>
        )}
      </div>

      {/* Purchase Orders Tab */}
      {tab === 'orders' && (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap md:whitespace-normal">
            <thead><tr className="border-b border-border">
              {['PO #', 'Supplier', 'Date', 'Expected', 'Items', 'Total', 'Paid', 'Balance', 'Compliance', 'Status', 'Actions'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {filteredOrders.map(po => (
                <tr key={po.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                  {(() => {
                    const isOverdue = po.expectedDate && ['DRAFT', 'APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status) && new Date(po.expectedDate) < new Date()
                    return (
                      <>
                  <td className="px-4 py-3 font-medium text-foreground">{po.displayId}</td>
                  <td className="px-4 py-3 text-foreground">{po.supplier?.name}</td>
                  <td className="px-4 py-3 text-muted">{new Date(po.date).toLocaleDateString('en-IN')}</td>
                  <td className={`px-4 py-3 text-xs ${isOverdue ? 'text-red-400 font-medium' : 'text-muted'}`}>
                    {po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-IN') : '—'}
                  </td>
                  <td className="px-4 py-3 text-muted">{po.items?.length || 0}</td>
                  <td className="px-4 py-3 font-medium text-foreground">₹{po.total?.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-emerald-400">₹{po.amountPaid?.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-amber-400">₹{po.balanceDue?.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium w-fit ${po.itcEligible ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                        {po.itcEligible ? `ITC: ${po.itcCategory?.replace(/_/g, ' ') || 'INPUTS'}` : 'ITC: Ineligible'}
                      </span>
                      {po.isRCM && <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 w-fit">RCM</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${poStatusColors[po.status] || ''}`}>{po.status?.replace(/_/g, ' ')}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setSelectedPO(po); setShowDetailModal(true) }} className="p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-foreground" title="View"><Eye className="w-4 h-4" /></button>
                      {po.status === 'DRAFT' && (
                        <button
                          onClick={() => handleEditPO(po)}
                          className="px-2.5 py-1 rounded-lg border border-border text-xs font-medium text-muted hover:text-accent hover:border-accent/40"
                          title="Edit PO"
                        >
                          Edit
                        </button>
                      )}
                      {po.status !== 'CANCELLED' && (
                        <>
                          <button
                            onClick={() => handleDownloadPO(po)}
                            className="p-1.5 rounded-lg hover:bg-surface-hover text-muted hover:text-foreground"
                            title="Download PO"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleSharePOWhatsApp(po)}
                            className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-muted hover:text-emerald-400"
                            title="Share PDF on WhatsApp"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                          {po.supplier?.email && (
                            <button
                              onClick={() => handleSharePOEmail(po)}
                              className="p-1.5 rounded-lg hover:bg-blue-500/10 text-muted hover:text-blue-400"
                              title="Share by Email"
                            >
                              <Mail className="w-4 h-4" />
                            </button>
                          )}
                        </>
                      )}
                      {po.status === 'DRAFT' && <button onClick={() => handleApprovePO(po.id)} className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-muted hover:text-emerald-400" title="Approve"><CheckCircle className="w-4 h-4" /></button>}
                      {(po.status === 'APPROVED' || po.status === 'PARTIALLY_RECEIVED') && <button onClick={() => openReceipt(po)} className="p-1.5 rounded-lg hover:bg-blue-500/10 text-muted hover:text-blue-400" title="Receive (GRN: partial quantities, backorders, location)"><ArrowDownCircle className="w-4 h-4" /></button>}
                      {po.status !== 'CANCELLED' && po.balanceDue > 0 && (
                        <button onClick={() => openPaymentModal(po)} className="p-1.5 rounded-lg hover:bg-purple-500/10 text-muted hover:text-purple-400" title="Record Payment">
                          <span className="text-sm font-bold">₹</span>
                        </button>
                      )}
                      {po.status !== 'CANCELLED' && <button onClick={() => handleMovePOToDraft(po.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-400" title="Move to Draft"><Trash2 className="w-4 h-4" /></button>}
                      {po.status === 'DRAFT' && <button onClick={() => handleCancelPO(po.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-400" title="Cancel"><XCircle className="w-4 h-4" /></button>}
                    </div>
                  </td>
                      </>
                    )
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
          {filteredOrders.length === 0 && <div className="text-center py-12 text-muted">No purchase orders found</div>}
        </div>
      )}

      {/* Suppliers Tab */}
      {tab === 'suppliers' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSuppliers.map(s => (
            <div key={s.id} className="glass-card p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-foreground">{s.name}</h3>
                  {s.contactPerson && <p className="text-xs text-muted mt-0.5">{s.contactPerson}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEditSupplierModal(s)}
                    className="px-2.5 py-1 rounded-lg border border-border text-xs font-medium text-muted hover:text-accent hover:border-accent/40"
                  >
                    Edit
                  </button>
                  <span className="text-xs text-muted bg-surface-hover px-2 py-1 rounded-full">{s._count?.purchaseOrders || 0} POs</span>
                </div>
              </div>
              <div className="space-y-1.5 text-sm text-muted">
                {s.phone && <p>Phone: {s.phone}</p>}
                {s.email && <p>Email: {s.email}</p>}
                {s.gstNumber && <p>GST: {s.gstNumber}</p>}
                {s.address && <p className="truncate">Address: {s.address}</p>}
                <p>Payment Terms: {s.paymentTerms} days</p>
              </div>
            </div>
          ))}
          {filteredSuppliers.length === 0 && <div className="col-span-full text-center py-12 text-muted">No suppliers found</div>}
        </div>
      )}

      {/* Returns Tab */}
      {tab === 'returns' && (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap md:whitespace-normal">
            <thead><tr className="border-b border-border">
              {['Return #', 'PO Ref', 'Supplier', 'Reason', 'Amount', 'Date', 'Status'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>)}
            </tr></thead>
            <tbody>
              {returns.map(r => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">{r.displayId}</td>
                  <td className="px-4 py-3 text-muted">{r.po?.displayId || '—'}</td>
                  <td className="px-4 py-3 text-foreground">{r.supplier?.name}</td>
                  <td className="px-4 py-3 text-muted truncate max-w-[200px]">{r.reason}</td>
                  <td className="px-4 py-3 font-medium text-foreground">₹{r.totalAmount?.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-muted">{new Date(r.date).toLocaleDateString('en-IN')}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${r.status === 'Completed' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {returns.length === 0 && (
            <div className="text-center py-16 space-y-3">
              <RotateCcw className="w-10 h-10 text-muted mx-auto opacity-40" />
              <p className="text-muted text-sm font-medium">No purchase returns yet</p>
              <p className="text-muted text-xs">Use the <strong className="text-foreground">New Return</strong> button (top right) or click below to create one</p>
              <button onClick={() => setShowReturnModal(true)} className="mt-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2 mx-auto">
                <Plus className="w-4 h-4" /> Create First Return
              </button>
            </div>
          )}
        </div>
      )}

      {/* PO Detail Modal */}
      <Modal isOpen={showDetailModal} onClose={() => setShowDetailModal(false)} title={`Purchase Order: ${selectedPO?.displayId}`} size="lg">
        {selectedPO && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-sm">
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wider text-muted font-semibold">Supplier</p>
                <p className="text-sm font-medium text-foreground">{selectedPO.supplier?.name}</p>
                {selectedPO.supplier?.contactPerson && <p className="text-xs text-muted">Contact: {selectedPO.supplier.contactPerson}</p>}
                {selectedPO.supplier?.phone && <p className="text-xs text-muted">Phone: {selectedPO.supplier.phone}</p>}
                {selectedPO.supplier?.email && <p className="text-xs text-muted">Email: {selectedPO.supplier.email}</p>}
                {selectedPO.supplier?.gstNumber && <p className="text-xs text-muted">GSTIN: {selectedPO.supplier.gstNumber}</p>}
                {selectedPO.supplier?.address && <p className="text-xs text-muted">Address: {selectedPO.supplier.address}</p>}
              </div>
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wider text-muted font-semibold">Ship To</p>
                <p className="text-sm font-medium text-foreground">{storeSettings?.storeName || DEFAULT_STORE_NAME}</p>
                {storeSettings?.address && <p className="text-xs text-muted">{storeSettings.address}</p>}
                {storeSettings?.phone && <p className="text-xs text-muted">Phone: {storeSettings.phone}</p>}
                {storeSettings?.gstNumber && <p className="text-xs text-muted">GSTIN: {storeSettings.gstNumber}</p>}
              </div>
              <div className="space-y-1">
                <p className="text-[10px] uppercase tracking-wider text-muted font-semibold">PO Details</p>
                <p className="text-xs text-muted">Date: <span className="text-foreground">{formatDate(selectedPO.date)}</span></p>
                <p className="text-xs text-muted">Expected: <span className="text-foreground">{formatDate(selectedPO.expectedDate)}</span></p>
                <p className="text-xs text-muted">Status: <span className={`px-2 py-0.5 rounded-full text-xs ${poStatusColors[selectedPO.status]}`}>{selectedPO.status}</span></p>
                <p className="text-xs text-muted">ITC: <span className="text-foreground">{selectedPO.itcEligible ? selectedPO.itcCategory?.replace(/_/g, ' ') : 'Ineligible'}</span></p>
                <p className="text-xs text-muted">RCM: <span className="text-foreground">{selectedPO.isRCM ? 'Yes' : 'No'}</span></p>
                {selectedPO.supplier?.paymentTerms && <p className="text-xs text-muted">Payment Terms: <span className="text-foreground">{selectedPO.supplier.paymentTerms} days</span></p>}
              </div>
            </div>
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="bg-surface-hover">
                {['Product', 'SKU', 'HSN', 'Qty', 'Received', 'Unit Cost', 'GST', 'Amount'].map(h => <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>)}
              </tr></thead>
              <tbody>
                {selectedPO.items?.map((item, i) => (
                  <tr key={i} className="border-t border-border/50">
                    <td className="px-3 py-2 text-foreground">{item.name}</td>
                    <td className="px-3 py-2 text-muted">{item.sku}</td>
                    <td className="px-3 py-2 text-muted">{item.hsnCode || '—'}</td>
                    <td className="px-3 py-2 text-foreground">{item.quantity}</td>
                    <td className="px-3 py-2 text-foreground">{item.receivedQty}</td>
                    <td className="px-3 py-2 text-foreground">₹{item.unitCost?.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2 text-foreground">{item.gstRate || 0}%</td>
                    <td className="px-3 py-2 text-foreground">₹{item.amount?.toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="flex justify-end pt-3 border-t border-border">
              <div className="w-72 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted">Subtotal</span><span className="text-foreground">{formatCurrency(selectedPO.subtotal)}</span></div>
                {Number(selectedPO.discount || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted">Discount</span><span className="text-foreground">- {formatCurrency(selectedPO.discount)}</span></div>
                )}
                {Number(selectedPO.igst || 0) > 0 ? (
                  <div className="flex justify-between text-xs"><span className="text-muted">IGST</span><span className="text-foreground">{formatCurrency(selectedPO.igst)}</span></div>
                ) : (
                  <>
                    <div className="flex justify-between text-xs"><span className="text-muted">CGST</span><span className="text-foreground">{formatCurrency(selectedPO.cgst)}</span></div>
                    <div className="flex justify-between text-xs"><span className="text-muted">SGST</span><span className="text-foreground">{formatCurrency(selectedPO.sgst)}</span></div>
                  </>
                )}
                <div className="flex justify-between text-base font-bold pt-2 border-t border-border">
                  <span className="text-foreground">Total</span>
                  <span className="text-foreground">{formatCurrency(selectedPO.total)}</span>
                </div>
                {Number(selectedPO.amountPaid || 0) > 0 && (
                  <div className="flex justify-between text-xs"><span className="text-muted">Paid</span><span className="text-foreground">{formatCurrency(selectedPO.amountPaid)}</span></div>
                )}
                {Number(selectedPO.balanceDue || 0) > 0 && (
                  <div className="flex justify-between text-xs"><span className="text-muted">Balance Due</span><span className="text-foreground">{formatCurrency(selectedPO.balanceDue)}</span></div>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-3 space-y-2">
              <p className="text-xs font-semibold text-muted uppercase tracking-wide">Share & Download</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => handleDownloadPO(selectedPO)}
                  className="px-3 py-1.5 rounded-lg bg-surface border border-border text-xs font-medium text-muted hover:text-foreground"
                >
                  <Download className="w-3.5 h-3.5 inline-block mr-1" /> Download PO
                </button>
                <button
                  onClick={() => handleSharePOWhatsApp(selectedPO)}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20"
                >
                  <MessageSquare className="w-3.5 h-3.5 inline-block mr-1" /> WhatsApp (PDF)
                </button>
                {selectedPO.supplier?.email && (
                  <button
                    onClick={() => handleSharePOEmail(selectedPO)}
                    className="px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-xs font-medium hover:bg-blue-500/20"
                  >
                    <Mail className="w-3.5 h-3.5 inline-block mr-1" /> Email (optional)
                  </button>
                )}
              </div>
            </div>

            <div className="border-t border-border pt-3 space-y-2">
              <p className="text-xs font-semibold text-muted uppercase tracking-wide">PO Status Actions</p>
              <div className="flex flex-wrap items-center gap-2">
                {selectedPO.status === 'DRAFT' && (
                  <button
                    onClick={() => handleEditPO(selectedPO)}
                    className="px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-muted hover:text-accent hover:border-accent/40"
                  >
                    Edit PO
                  </button>
                )}

                {selectedPO.status === 'DRAFT' && (
                  <button
                    onClick={() => {
                      handleApprovePO(selectedPO.id)
                      setShowDetailModal(false)
                    }}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20"
                  >
                    Approve PO
                  </button>
                )}

                {(selectedPO.status === 'APPROVED' || selectedPO.status === 'PARTIALLY_RECEIVED') && (
                  <button
                    onClick={() => {
                      handleReceivePO(selectedPO.id)
                      setShowDetailModal(false)
                    }}
                    className="px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-xs font-medium hover:bg-blue-500/20"
                  >
                    Receive all
                  </button>
                )}
                {(selectedPO.status === 'APPROVED' || selectedPO.status === 'PARTIALLY_RECEIVED') && (
                  <button
                    onClick={() => openReceipt(selectedPO)}
                    className="px-3 py-1.5 rounded-lg border border-blue-500/30 text-blue-400 text-xs font-medium hover:bg-blue-500/10"
                  >
                    Partial receipt (GRN)
                  </button>
                )}
                {(selectedPO.status === 'PARTIALLY_RECEIVED' || selectedPO.status === 'RECEIVED') && selectedPO.items?.some(item => item.receivedQty > (item.billedQty || 0)) && (
                  <button
                    onClick={() => handleCreateBill(selectedPO)}
                    className="px-3 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-400 text-xs font-medium hover:bg-emerald-500/10"
                  >
                    Create vendor bill
                  </button>
                )}
                {(selectedPO.status === 'APPROVED' || selectedPO.status === 'PARTIALLY_RECEIVED') && selectedPO.items?.some(item => item.product?.isSlabTracked && item.receivedQty < item.quantity) && (
                  <button onClick={() => openStoneReceive(selectedPO)} className="px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 text-xs font-medium hover:bg-purple-500/20">Receive stone lot</button>
                )}

                {selectedPO.status === 'DRAFT' && (
                  <button
                    onClick={() => {
                      handleCancelPO(selectedPO.id)
                      setShowDetailModal(false)
                    }}
                    className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20"
                  >
                    Cancel PO
                  </button>
                )}
                {selectedPO.status !== 'CANCELLED' && (
                  <button
                    onClick={() => {
                      handleMovePOToDraft(selectedPO.id)
                      setShowDetailModal(false)
                    }}
                    className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20"
                  >
                    Move to Draft
                  </button>
                )}
              </div>
            </div>

            {selectedPO.notes && (
              <div className="border-t border-border pt-3">
                <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">Notes & Activity</p>
                <pre className="whitespace-pre-wrap text-xs text-foreground bg-surface border border-border rounded-lg p-2.5">{selectedPO.notes}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal isOpen={!!poToCancel} onClose={() => setPoToCancel(null)} title="Cancel Purchase Order" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Are you sure you want to cancel this purchase order?</p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setPoToCancel(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">No</button>
            <button onClick={confirmCancelPO} disabled={cancelingPo} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{cancelingPo ? 'Cancelling...' : 'Yes, Cancel'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!poToDraft} onClose={() => setPoToDraft(null)} title="Move Purchase Order to Draft" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">Move this purchase order to drafts? It will be permanently deleted after 30 days.</p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setPoToDraft(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
            <button onClick={confirmMovePOToDraft} disabled={movingPoToDraft} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{movingPoToDraft ? 'Moving...' : 'Move to Draft'}</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!stoneReceivePO} onClose={() => setStoneReceivePO(null)} title="Receive Stone Lot from PO" size="lg">
        <div className="space-y-4">
          <p className="text-xs text-muted">Record each physical slab against {stoneReceivePO?.displayId}. The normal “Mark Received” action is intentionally blocked for slab-tracked stone.</p>
          <div>
            <label className="text-sm text-muted mb-1 block">Stone PO line *</label>
            <select value={stoneReceiveForm.poItemId} onChange={e => setStoneReceiveForm(form => ({ ...form, poItemId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm">
              <option value="">Select stone line</option>
              {stoneReceivePO?.items?.filter(item => item.product?.isSlabTracked && item.receivedQty < item.quantity).map(item => <option key={item.id} value={item.id}>{item.name} · {item.quantity - item.receivedQty} slab(s) pending</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label className="text-sm text-muted mb-1 block">Lot number *</label><input value={stoneReceiveForm.lotNumber} onChange={e => setStoneReceiveForm(form => ({ ...form, lotNumber: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
            <div><label className="text-sm text-muted mb-1 block">Shade / block code</label><input value={stoneReceiveForm.shadeCode} onChange={e => setStoneReceiveForm(form => ({ ...form, shadeCode: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
            <div><label className="text-sm text-muted mb-1 block">Origin</label><input value={stoneReceiveForm.origin} onChange={e => setStoneReceiveForm(form => ({ ...form, origin: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
            <div><label className="text-sm text-muted mb-1 block">Quality grade</label><input value={stoneReceiveForm.qualityGrade} onChange={e => setStoneReceiveForm(form => ({ ...form, qualityGrade: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
            <div><label className="text-sm text-muted mb-1 block">Thickness (mm)</label><input type="number" min="1" step="0.1" value={stoneReceiveForm.thicknessMm} onChange={e => setStoneReceiveForm(form => ({ ...form, thicknessMm: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
            <div><label className="text-sm text-muted mb-1 block">Cost / sq.ft</label><input type="number" min="0" value={stoneReceiveForm.costPerSqft} onChange={e => setStoneReceiveForm(form => ({ ...form, costPerSqft: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
          </div>
          <div><label className="text-sm text-muted mb-1 block">Slabs (one per line: slab number, length inches, width inches) *</label><textarea rows={6} value={stoneReceiveForm.slabsText} onChange={e => setStoneReceiveForm(form => ({ ...form, slabsText: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" /></div>
          <textarea rows={2} placeholder="Notes" value={stoneReceiveForm.notes} onChange={e => setStoneReceiveForm(form => ({ ...form, notes: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm" />
          <button onClick={handleStoneReceive} disabled={!stoneReceiveForm.poItemId || !stoneReceiveForm.lotNumber} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium disabled:opacity-50">Receive and link lot</button>
        </div>
      </Modal>

      {/* Create Supplier Modal */}
      <Modal
        isOpen={showSupplierModal}
        onClose={() => { setShowSupplierModal(false); resetSupplierForm() }}
        title={editingSupplierId ? 'Edit Supplier' : 'Add Supplier'}
      >
        <div className="space-y-4">
          {[
            { key: 'name', label: 'Name *', type: 'text' },
            { key: 'phone', label: 'Phone', type: 'text' },
            { key: 'email', label: 'Email', type: 'email' },
            { key: 'gstNumber', label: 'GST Number', type: 'text' },
            { key: 'contactPerson', label: 'Contact Person', type: 'text' },
            { key: 'paymentTerms', label: 'Payment Terms (days)', type: 'number' },
          ].map(f => (
            <div key={f.key}>
              <label className="text-sm text-muted mb-1 block">{f.label}</label>
              <input type={f.type} value={supplierForm[f.key]} onChange={e => setSupplierForm(p => ({ ...p, [f.key]: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
          ))}
          <div>
            <label className="text-sm text-muted mb-1 block">Address</label>
            <textarea value={supplierForm.address} onChange={e => setSupplierForm(p => ({ ...p, address: e.target.value }))} rows={2} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
          </div>
          <button onClick={handleSaveSupplier} disabled={submitting || !supplierForm.name} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? (editingSupplierId ? 'Updating...' : 'Creating...') : (editingSupplierId ? 'Update Supplier' : 'Create Supplier')}
          </button>
        </div>
      </Modal>

      {/* Create PO Modal */}
      <Modal
        isOpen={showPOModal}
        onClose={() => { setShowPOModal(false); resetPOForm() }}
        title={editingPOId ? 'Edit Purchase Order' : 'Create Purchase Order'}
        size="lg"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
            <label className="text-sm text-muted mb-1 block">Supplier *</label>
            <select value={poForm.supplierId} onChange={e => setPOForm(p => ({ ...p, supplierId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
              <option value="">Select Supplier</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Expected Delivery</label>
              <input
                type="date"
                value={poForm.expectedDate}
                onChange={e => setPOForm(p => ({ ...p, expectedDate: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="flex items-center gap-2 text-xs text-foreground border border-border rounded-lg px-3 py-2">
              <input
                type="checkbox"
                checked={poForm.itcEligible}
                onChange={e => setPOForm(p => ({ ...p, itcEligible: e.target.checked }))}
              />
              ITC Eligible
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground border border-border rounded-lg px-3 py-2">
              <input
                type="checkbox"
                checked={poForm.isRCM}
                onChange={e => setPOForm(p => ({ ...p, isRCM: e.target.checked }))}
              />
              RCM Purchase
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground border border-border rounded-lg px-3 py-2">
              <input
                type="checkbox"
                checked={poForm.applyGst}
                onChange={e => setPOForm(p => ({ ...p, applyGst: e.target.checked }))}
              />
              Apply GST
            </label>
            <select
              value={poForm.itcCategory}
              onChange={e => setPOForm(p => ({ ...p, itcCategory: e.target.value }))}
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
              disabled={!poForm.itcEligible}
            >
              {ITC_CATEGORIES.map(category => (
                <option key={category} value={category}>{category.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-muted">Items</label>
              <div className="flex items-center gap-2">
                <button onClick={addPOItem} className="text-xs text-accent hover:underline">+ Add Inventory</button>
                <button onClick={addCustomPOItem} className="text-xs text-amber-400 hover:underline">+ Add Custom</button>
              </div>
            </div>
            {poForm.items.map((item, i) => {
              const quantity = Math.max(1, Number(item.quantity) || 1)
              const unitCost = Math.max(0, Number(item.unitCost) || 0)
              const gstRate = poForm.applyGst ? Math.max(0, Number(item.gstRate) || 0) : 0
              const lineSubtotal = quantity * unitCost
              const lineGst = Math.round(lineSubtotal * gstRate / 100)
              const lineTotal = lineSubtotal + lineGst

              return (
                <div key={i} className="flex flex-col sm:grid sm:grid-cols-12 gap-2 mb-4 sm:mb-2 bg-surface sm:bg-transparent border border-border sm:border-none p-3 sm:p-0 rounded-lg sm:rounded-none relative">
                  <div className="absolute top-2 right-2 sm:static sm:col-span-1 flex items-center justify-end gap-2">
                    {item.isCustom && <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">Custom</span>}
                    <button type="button" onClick={() => setPOForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))} className="text-red-400 hover:text-red-300 text-lg">×</button>
                  </div>

                  {item.isCustom ? (
                    <div className="col-span-11 grid grid-cols-1 sm:grid-cols-4 gap-2 mt-6 sm:mt-0">
                      <input
                        type="text"
                        value={item.customName}
                        onChange={e => { const v = [...poForm.items]; v[i].customName = e.target.value; setPOForm(f => ({ ...f, items: v })) }}
                        placeholder="Custom item name *"
                        className="px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
                      />
                      <input
                        type="text"
                        value={item.customSku}
                        onChange={e => { const v = [...poForm.items]; v[i].customSku = e.target.value; setPOForm(f => ({ ...f, items: v })) }}
                        placeholder="SKU (optional)"
                        className="px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
                      />
                      <input
                        type="text"
                        value={item.hsnCode}
                        onChange={e => { const v = [...poForm.items]; v[i].hsnCode = e.target.value; setPOForm(f => ({ ...f, items: v })) }}
                        placeholder="HSN (optional)"
                        className="px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
                      />
                      <input
                        type="text"
                        value={item.customUom || 'PCS'}
                        onChange={e => { const v = [...poForm.items]; v[i].customUom = e.target.value; setPOForm(f => ({ ...f, items: v })) }}
                        placeholder="UOM"
                        className="px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
                      />
                    </div>
                  ) : (
                    <select
                      value={item.productId}
                      onChange={e => {
                        const v = [...poForm.items]
                        v[i].productId = e.target.value
                        const prod = products.find(p => p.id === Number(e.target.value))
                        if (prod) {
                          v[i].unitCost = prod.costPrice || 0
                          v[i].hsnCode = prod.hsnCode || ''
                        }
                        setPOForm(f => ({ ...f, items: v }))
                      }}
                      className="col-span-5 px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground w-full mt-6 sm:mt-0"
                    >
                      <option value="">Select Product</option>
                      {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                    </select>
                  )}

                  <div className={`flex gap-2 ${item.isCustom ? 'col-span-11' : 'col-span-6'}`}>
                    <input type="number" min="1" value={item.quantity} onChange={e => { const v = [...poForm.items]; v[i].quantity = e.target.value; setPOForm(f => ({ ...f, items: v })) }} placeholder="Qty" className="w-1/3 sm:w-full px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                    <input type="number" min="0" value={item.unitCost} onChange={e => { const v = [...poForm.items]; v[i].unitCost = e.target.value; setPOForm(f => ({ ...f, items: v })) }} placeholder="Cost" className="w-1/3 sm:w-full px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                    <input type="number" min="0" max="100" value={item.gstRate || 0} onChange={e => { const v = [...poForm.items]; v[i].gstRate = e.target.value; setPOForm(f => ({ ...f, items: v })) }} placeholder="GST%" disabled={!poForm.applyGst} className={`w-1/3 sm:w-full px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm ${poForm.applyGst ? 'text-foreground' : 'text-muted/70'}`} />
                  </div>

                  <div className="col-span-12 text-[11px] text-muted flex justify-end">
                    Line Total: ₹{lineTotal.toLocaleString('en-IN')}{poForm.applyGst ? ` (GST ₹${lineGst.toLocaleString('en-IN')})` : ''}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted mb-1 block">Order Discount (₹)</label>
              <input
                type="number"
                min="0"
                value={poForm.discount}
                onChange={e => setPOForm(p => ({ ...p, discount: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
              />
            </div>
            <div className="bg-surface border border-border rounded-lg p-2.5 text-xs text-muted">
              <p>Subtotal: <span className="text-foreground font-medium">₹{poPreview.subtotal.toLocaleString('en-IN')}</span></p>
              <p>Discount: <span className="text-foreground font-medium">₹{poPreview.discount.toLocaleString('en-IN')}</span></p>
              <p>GST: <span className="text-foreground font-medium">₹{poPreview.gst.toLocaleString('en-IN')}</span></p>
              <p className="text-sm text-foreground font-semibold mt-1">PO Total: ₹{poPreview.total.toLocaleString('en-IN')}</p>
            </div>
          </div>

          <div>
            <label className="text-sm text-muted mb-1 block">Notes</label>
            <textarea value={poForm.notes} onChange={e => setPOForm(p => ({ ...p, notes: e.target.value }))} rows={2} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
          </div>

          <button onClick={handleCreatePO} disabled={submitting || !poForm.supplierId || !poForm.items.some(i => i.productId || (i.isCustom && i.customName))} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? (editingPOId ? 'Updating...' : 'Creating...') : (editingPOId ? 'Update Purchase Order' : 'Create Purchase Order')}
          </button>
        </div>
      </Modal>

      {/* Record Payment Modal */}
      <Modal isOpen={showPaymentModal} onClose={() => setShowPaymentModal(false)} title="Record PO Payment">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted mb-1 block">Payment Date *</label>
              <input
                type="date"
                value={paymentForm.paidAt}
                onChange={e => setPaymentForm(f => ({ ...f, paidAt: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
              />
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Method *</label>
              <select
                value={paymentForm.method}
                onChange={e => setPaymentForm(f => ({ ...f, method: e.target.value }))}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
              >
                {['Bank Transfer', 'UPI', 'Cash', 'Cheque', 'Card'].map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Amount (₹) *</label>
            <input
              type="number"
              min="1"
              value={paymentForm.amount}
              onChange={e => setPaymentForm(f => ({ ...f, amount: e.target.value }))}
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
            />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Reference (optional)</label>
            <input
              type="text"
              value={paymentForm.reference}
              onChange={e => setPaymentForm(f => ({ ...f, reference: e.target.value }))}
              placeholder="UTR / cheque no / txn id"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
            />
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Note (optional)</label>
            <input
              type="text"
              value={paymentForm.note}
              onChange={e => setPaymentForm(f => ({ ...f, note: e.target.value }))}
              placeholder="UTR / cheque / remark"
              className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground"
            />
          </div>
          <button
            onClick={handleRecordPayment}
            disabled={submitting || !paymentForm.amount || !paymentForm.method || !paymentForm.paidAt}
            className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : 'Save Payment'}
          </button>
        </div>
      </Modal>

      {/* Create Return Modal */}
      <Modal isOpen={showReturnModal} onClose={() => setShowReturnModal(false)} title="Create Purchase Return" size="lg">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted mb-1 block">Supplier *</label>
              <select value={returnForm.supplierId} onChange={e => setReturnForm(p => ({ ...p, supplierId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                <option value="">Select Supplier</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">PO Reference</label>
              <select value={returnForm.poId} onChange={e => setReturnForm(p => ({ ...p, poId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                <option value="">Optional</option>
                {orders.filter(o => o.status === 'RECEIVED').map(o => <option key={o.id} value={o.id}>{o.displayId}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-muted mb-1 block">Return from godown</label>
              <select value={returnForm.godownId} onChange={e => setReturnForm(p => ({ ...p, godownId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                <option value="">Default godown</option>
                {godowns.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm text-muted mb-1 block">Reason *</label>
            <input value={returnForm.reason} onChange={e => setReturnForm(p => ({ ...p, reason: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-muted">Items</label>
              <button onClick={addReturnItem} className="text-xs text-accent hover:underline">+ Add Item</button>
            </div>
            {returnForm.items.map((item, i) => (
              <div key={i} className="flex flex-col sm:grid sm:grid-cols-12 gap-2 mb-4 sm:mb-2 bg-surface sm:bg-transparent border border-border sm:border-none p-3 sm:p-0 rounded-lg sm:rounded-none relative">
                <button type="button" onClick={() => setReturnForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))} className="absolute top-2 right-2 sm:static sm:col-span-1 text-red-400 hover:text-red-300 text-lg flex sm:items-center sm:justify-center">×</button>
                <select value={item.productId} onChange={e => { const v = [...returnForm.items]; v[i].productId = e.target.value; setReturnForm(f => ({ ...f, items: v })) }} className="col-span-6 px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground w-full mt-6 sm:mt-0">
                  <option value="">Select Product</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                </select>
                <div className="flex flex-row gap-2 col-span-5 w-full">
                  <input type="number" min="1" value={item.quantity} onChange={e => { const v = [...returnForm.items]; v[i].quantity = e.target.value; setReturnForm(f => ({ ...f, items: v })) }} placeholder="Qty" className="flex-1 px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                  <input type="number" min="0" value={item.unitCost} onChange={e => { const v = [...returnForm.items]; v[i].unitCost = e.target.value; setReturnForm(f => ({ ...f, items: v })) }} placeholder="Cost" className="flex-1 px-3 sm:px-2 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                </div>
              </div>
            ))}
          </div>
          <button onClick={handleCreateReturn} disabled={submitting || !returnForm.supplierId || !returnForm.reason} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Purchase Return'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
