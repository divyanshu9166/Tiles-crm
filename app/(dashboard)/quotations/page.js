'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import {
  CalendarDays,
  Eye,
  FileText,
  Image as ImageIcon,
  IndianRupee,
  Mail,
  MessageSquare,
  Package,
  Pencil,
  Phone,
  Plus,
  Printer,
  Download,
  QrCode,
  Search,
  Upload,
  Trash2,
  User,
  X,
  ClipboardList,
} from 'lucide-react'
import { moveQuotationToDraft } from '@/app/actions/drafts'
import Modal from '@/components/Modal'
import { useAlertToast } from '@/components/AlertToastProvider'
import { convertQuotationToInvoice, createQuotation, getQuotationStats, getQuotations, updateQuotation, updateQuotationStatus } from '@/app/actions/quotations'
import { createSalesOrderFromQuotation } from '@/app/actions/sales-orders'
import { getProducts } from '@/app/actions/products'
import { getPricelists, getPricesFor } from '@/app/actions/pricelists'
import { linePrice } from '@/lib/line-math'
import { getStoreSettings, updateStoreSettings } from '@/app/actions/settings'
import { getBillableArea } from '@/lib/units'
import { getActiveVertical } from '@/lib/brand'

const DEFAULT_STORE_NAME = getActiveVertical() === 'tiles' ? 'Tiles, Granite & Marble Showroom' : 'Furniture Store'

const statusColors = {
  DRAFT: 'bg-gray-500/10 text-gray-700 border-gray-500/20',
  SENT: 'bg-blue-500/10 text-blue-700 border-blue-500/20',
  APPROVED: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20',
  REJECTED: 'bg-red-500/10 text-red-700 border-red-500/20',
}

const defaultTerms = [
  'Extra work will be accounted separately.',
  '50% payment in advance with purchase order.',
  'Balance payment before dispatch of goods.',
  'GST at applicable rate will be charged extra.',
  'Labour to load/unload vehicle is at consignee expense.',
  'Packing charge and freight are at actual basis.',
  'Once order is confirmed, amendment or cancellation is not allowed.',
]

const createBlankItem = () => ({
  productId: '',
  name: '',
  sku: '',
  description: '',
  quantity: 1,
  rate: 0,
  area: 0,
  unitOfMeasure: 'PCS',
  coveragePerBox: 0,
  productImage: '',
  referenceImage: '',
  imageSource: 'REFERENCE',
  isCustom: false,
})

const BANK_DETAILS_KEY = 'quotation_bank_details'

const createBlankBankDetails = () => ({
  accountName: '',
  bankName: '',
  accountNumber: '',
  ifscCode: '',
  branchName: '',
  upiId: '',
})

function getProductAutoDescription(product) {
  if (!product) return ''

  const directDescription = String(product.description || '').trim()
  if (directDescription) return directDescription

  const detailParts = []
  if (product.material?.trim()) detailParts.push(`Material: ${product.material.trim()}`)
  if (product.color?.trim()) detailParts.push(`Color: ${product.color.trim()}`)
  if (product.category?.trim()) detailParts.push(`Category: ${product.category.trim()}`)

  return detailParts.join(' | ')
}

function loadSavedBankDetails() {
  try {
    const saved = localStorage.getItem(BANK_DETAILS_KEY)
    if (saved) return { ...createBlankBankDetails(), ...JSON.parse(saved) }
  } catch { }
  return createBlankBankDetails()
}

function saveBankDetailsToStorage(details) {
  try {
    localStorage.setItem(BANK_DETAILS_KEY, JSON.stringify(details))
  } catch { }
}

const createInitialForm = () => ({
  customer: '',
  phone: '',
  email: '',
  dispatchAddress: '',
  date: new Date().toISOString().split('T')[0],
  validUntil: '',
  projectName: '',
  deliveryMode: 'CARGO BY ROAD',
  roadPermit: 'REQUIRED',
  contactPerson: '',
  installationPercent: 5,
  discountType: 'PERCENT',
  discountValue: 0,
  freightCharge: 0,
  loadingCharge: 0,
  gstPercent: 18,
  bankDetails: createBlankBankDetails(), // will be replaced with saved on open
  notes: '',
  termsText: defaultTerms.join('\n'),
  pricelistId: '',
  pricedFrom: null,
  items: [createBlankItem()],
})

function formatDateDisplay(dateValue) {
  if (!dateValue) return '-'
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return String(dateValue)
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

function buildFormFromQuotation(quotation) {
  const mappedItems = Array.isArray(quotation?.items) && quotation.items.length > 0
    ? quotation.items.map(item => {
      const productImage = item.productImage || ''
      const savedImage = item.referenceImage || ''
      const imageSource = productImage && savedImage && productImage === savedImage ? 'PRODUCT' : 'REFERENCE'

      return {
        productId: item.productId || '',
        name: item.name || '',
        sku: item.sku || '',
        description: item.description || '',
         quantity: Number(item.quantity) || 1,
         rate: Number(item.rate) || 0,
         area: Number(item.area ?? item.areaInput) || 0,
         unitOfMeasure: item.unitOfMeasure || 'PCS',
         coveragePerBox: Number(item.coveragePerBox) || 0,
        productImage,
        referenceImage: imageSource === 'REFERENCE' ? savedImage : '',
        imageSource,
        isCustom: !item.productId,
      }
    })
    : [createBlankItem()]

  return {
    pricelistId: quotation?.pricelistId || '',
    pricedFrom: null,
    customer: quotation?.customer || '',
    phone: quotation?.phone || '',
    email: quotation?.email || '',
    dispatchAddress: quotation?.dispatchAddress || '',
    date: quotation?.date || new Date().toISOString().split('T')[0],
    validUntil: quotation?.validUntil || '',
    projectName: quotation?.projectName || '',
    deliveryMode: quotation?.deliveryMode || 'CARGO BY ROAD',
    roadPermit: quotation?.roadPermit || 'REQUIRED',
    contactPerson: quotation?.contactPerson || '',
    installationPercent: Number(quotation?.installationPercent) || 0,
    discountType: quotation?.discountType === 'FLAT' ? 'FLAT' : 'PERCENT',
    discountValue: Number(quotation?.discountValue) || 0,
    freightCharge: Number(quotation?.freightCharge) || 0,
    loadingCharge: Number(quotation?.loadingCharge) || 0,
    gstPercent: Number(quotation?.gstPercent) || 18,
    bankDetails: {
      accountName: quotation?.bankDetails?.accountName || '',
      bankName: quotation?.bankDetails?.bankName || '',
      accountNumber: quotation?.bankDetails?.accountNumber || '',
      ifscCode: quotation?.bankDetails?.ifscCode || '',
      branchName: quotation?.bankDetails?.branchName || '',
      upiId: quotation?.bankDetails?.upiId || '',
    },
    notes: quotation?.notes || '',
    termsText: Array.isArray(quotation?.termsAndConditions) && quotation.termsAndConditions.length > 0
      ? quotation.termsAndConditions.join('\n')
      : defaultTerms.join('\n'),
    items: mappedItems,
  }
}

function formatCurrency(amount) {
  return `Rs. ${Number(amount || 0).toLocaleString('en-IN')}`
}

function normalizePhoneNumber(value) {
  const digits = String(value || '').replace(/\D/g, '')
  const trimmed = digits.replace(/^0+/, '')
  if (!trimmed) return ''
  if (trimmed.length === 10) return `91${trimmed}`
  return trimmed
}

function buildWhatsAppUrl(phone, message) {
  const normalized = normalizePhoneNumber(phone)
  if (!normalized) return ''
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`
}

function buildMailtoUrl(email, subject, body) {
  if (!email) return ''
  const params = new URLSearchParams()
  if (subject) params.set('subject', subject)
  if (body) params.set('body', body)
  return `mailto:${email}?${params.toString()}`
}

function buildQuotationShareMessage(quotation, storeSettings) {
  const storeName = storeSettings?.storeName || DEFAULT_STORE_NAME
  const contactBits = []
  if (storeSettings?.phone) contactBits.push(`Phone: ${storeSettings.phone}`)
  if (storeSettings?.whatsappNumber) contactBits.push(`WhatsApp: ${storeSettings.whatsappNumber}`)
  if (storeSettings?.email) contactBits.push(`Email: ${storeSettings.email}`)

  return [
    `Hello ${quotation?.customer || ''}`.trim(),
    `Here is your quotation ${quotation?.id || ''} from ${storeName}.`.trim(),
    `Total: ${formatCurrency(quotation?.grandTotal)}`,
    quotation?.validUntil ? `Valid until: ${formatDateDisplay(quotation.validUntil)}` : null,
    contactBits.length > 0 ? `Contact: ${contactBits.join(' | ')}` : null,
  ].filter(Boolean).join('\n')
}

function getItemDisplayImage(item) {
  const productImage = item?.productImage || ''
  const referenceImage = item?.referenceImage || ''

  if (item?.imageSource === 'PRODUCT') {
    return productImage || referenceImage || ''
  }

  return referenceImage || productImage || ''
}

/**
 * Compute the amount for a single quotation/invoice line, applying tiles
 * area-based math when the product is sold by SQFT or BOX and falling back to
 * the existing per-unit (quantity * rate) behavior for furniture / PCS.
 *
 * Inputs are coerced defensively so callers can pass raw form values:
 *   - quantity is clamped to >= 1 (matching the existing furniture behavior)
 *   - rate, area, and coveragePerBox are clamped to >= 0
 *   - box conversion is only attempted when coveragePerBox is a positive number
 *
 * @param {object} item - The line item (quantity, rate, and optional area/areaInput).
 * @param {object} [product] - The associated product (unitOfMeasure, coveragePerBox).
 * @returns {{ amount: number, boxes?: number, area?: number }} The line amount,
 *   plus the entered area and resulting box count when a conversion occurred.
 */
function computeLineAmount(item, product) {
  // Same rules as the server (lib/line-math): the printed quote matches the saved one.
  return linePrice({
    quantity: item?.quantity,
    rate: Math.round(Number(item?.rate) || 0),
    unitOfMeasure: item?.unitOfMeasure || product?.unitOfMeasure || 'PCS',
    areaSqft: item?.area ?? item?.areaInput,
    coveragePerBox: item?.coveragePerBox ?? product?.coveragePerBox,
  })
}

function computeTotals(items, installationPercent, discountType, discountValue, freightCharge, loadingCharge, gstPercent, products = []) {
  const productById = new Map((products || []).map(p => [p.id, p]))
  const normalizedItems = items.map(item => {
    const quantity = Math.max(1, Number(item.quantity) || 1)
    const rate = Math.max(0, Number(item.rate) || 0)
    const product = item.productId ? productById.get(item.productId) : undefined
    // Per-line stage: area-aware amount for SQFT/BOX tiles lines, unchanged
    // quantity * rate for furniture/PCS. The downstream subtotal -> discount ->
    // installation -> freight -> loading -> GST pipeline below is untouched.
    const line = computeLineAmount({ ...item, quantity, rate }, product)
    return {
      ...item,
      quantity,
      rate,
      amount: line.amount,
      areaInput: line.area,
      boxCount: line.boxes,
    }
  })

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.amount, 0)
  const normalizedDiscountType = discountType === 'FLAT' ? 'FLAT' : 'PERCENT'
  const normalizedDiscountValue = Math.max(0, Number(discountValue) || 0)
  const rawDiscountAmount = normalizedDiscountType === 'PERCENT'
    ? Math.round((subtotal * normalizedDiscountValue) / 100)
    : Math.round(normalizedDiscountValue)
  const discountAmount = Math.max(0, Math.min(subtotal, rawDiscountAmount))
  const subtotalAfterDiscount = Math.max(0, subtotal - discountAmount)
  const installationCharge = Math.round((subtotalAfterDiscount * (Number(installationPercent) || 0)) / 100)
  const freight = Math.max(0, Number(freightCharge) || 0)
  const loading = Math.max(0, Number(loadingCharge) || 0)
  const totalBeforeTax = subtotalAfterDiscount + installationCharge + freight + loading
  const gstAmount = Math.round((totalBeforeTax * (Number(gstPercent) || 0)) / 100)
  const grandTotal = totalBeforeTax + gstAmount

  return {
    normalizedItems,
    subtotal,
    discountType: normalizedDiscountType,
    discountValue: normalizedDiscountValue,
    discountAmount,
    subtotalAfterDiscount,
    installationCharge,
    freight,
    loading,
    totalBeforeTax,
    gstAmount,
    grandTotal,
  }
}

function getAbsoluteImageUrl(url) {
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return `${window.location.origin}${url}`
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildPrintHtml(quotation, storeSettings) {
  const storeName = storeSettings?.storeName || DEFAULT_STORE_NAME
  const storeAddress = storeSettings?.address || ''
  const storePhone = storeSettings?.phone || ''
  const storeEmail = storeSettings?.email || ''
  const paymentQr = storeSettings?.paymentQr || ''
  const bankRows = [
    { label: 'Account Name', value: quotation?.bankDetails?.accountName },
    { label: 'Bank Name', value: quotation?.bankDetails?.bankName },
    { label: 'Account Number', value: quotation?.bankDetails?.accountNumber },
    { label: 'IFSC Code', value: quotation?.bankDetails?.ifscCode },
    { label: 'Branch', value: quotation?.bankDetails?.branchName },
    { label: 'UPI ID', value: quotation?.bankDetails?.upiId },
  ]
  const populatedBankRows = bankRows.filter(row => String(row.value || '').trim())
  const paymentQrHtml = paymentQr
    ? `<img src="${escapeHtml(getAbsoluteImageUrl(paymentQr))}" alt="Payment QR" />`
    : '<div class="qr-placeholder">PAYMENT QR NOT ADDED</div>'
  const discountAmount = Number(quotation.discountAmount || 0)
  const discountTypeLabel = quotation.discountType === 'FLAT'
    ? `DISCOUNT (Rs. ${Number(quotation.discountValue || 0).toLocaleString('en-IN')})`
    : `DISCOUNT (${Number(quotation.discountValue || 0)}%)`
  const subtotalAfterDiscount = Math.max(0, Number(quotation.subtotal || 0) - discountAmount)

  const itemRows = quotation.items
    .map((item, idx) => {
      const displayImage = getItemDisplayImage(item)
      const img = displayImage
        ? `<img src="${escapeHtml(getAbsoluteImageUrl(displayImage))}" alt="item" style="width:110px;height:70px;object-fit:cover;border:1px solid #999;" />`
        : '<span style="color:#666;font-size:10px;">No image</span>'

      return `
        <tr>
          <td>${idx + 1}</td>
          <td><div style="font-weight:700;">${escapeHtml(item.name || '-')}</div></td>
          <td>${item.description ? `<div style="font-size:10px;color:#333;white-space:pre-wrap;">${escapeHtml(item.description)}</div>` : '<span style="color:#666;font-size:10px;">-</span>'}</td>
          <td style="text-align:center;">${img}</td>
          <td style="text-align:center;">${item.quantity} ${escapeHtml(item.unitOfMeasure || 'PCS')}${item.areaSqft ? `<div style="font-size:10px;color:#555;">${Number(item.areaSqft).toFixed(2)} sq.ft</div>` : ''}</td>
          <td style="text-align:right;">${Number(item.rate || 0).toLocaleString('en-IN')}</td>
          <td style="text-align:right;">${Number(item.amount || 0).toLocaleString('en-IN')}</td>
        </tr>
      `
    })
    .join('')

  const terms = (quotation.termsAndConditions || [])
    .map((term, idx) => `<li${idx === 6 ? ' class="highlight"' : ''}>${idx + 1}. ${escapeHtml(term)}</li>`)
    .join('')

  return `
    <html>
      <head>
        <title>${escapeHtml(quotation.id)} - Quotation</title>
        <style>
          @page { size: A4 portrait; margin: 8mm; }
          body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; }
          .sheet { border: 3px solid #111; }
          .center { text-align: center; }
          .title { font-weight: 700; text-decoration: underline; margin-top: 6px; }
          .company { font-size: 42px; font-weight: 800; color: #06a9d6; line-height: 1.05; margin: 2px 0; letter-spacing: 0.5px; }
          .meta { font-size: 11px; margin-bottom: 4px; }
          .meta.small { font-size: 10px; margin-bottom: 2px; }
          table { width: 100%; border-collapse: collapse; }
          td, th { border: 1.5px solid #111; padding: 4px 6px; font-size: 11px; vertical-align: top; }
          .blue { background: #0ea5d8; color: white; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
          .section { margin-top: 0; }
          .totals td { font-size: 11px; }
          .totals td:first-child { text-align: right; font-weight: 700; }
          .totals td:last-child { text-align: right; width: 180px; }
          .totals tr.bar td { background:#0ea5d8; color:#fff; font-weight:700; }
          .totals tr.final td { background:#d9f4ff; font-weight:700; }
          .terms { margin: 10px 8px 12px; font-size: 11px; color:#6b4d8e; }
          .terms h4 { margin: 0 0 6px; font-size: 12px; text-decoration: underline; }
          .terms ul { margin: 0; padding: 0; list-style: none; }
          .terms li { margin: 2px 0; }
          .terms li.highlight { background:#0ea5d8; color:#fff; padding:1px 4px; }
          .bank-wrap { margin: 10px 8px 12px; display:flex; align-items:flex-end; justify-content:space-between; gap: 16px; }
          .bank { margin: 0; font-size: 11px; color:#6b4d8e; flex:1; min-width: 0; }
          .bank strong.brand { color:#06a9d6; }
          .bank p { margin: 3px 0; }
          .pay-qr { width: 120px; text-align: center; color: #111; }
          .pay-qr .pay-title { margin: 0 0 4px; font-size: 10px; font-weight: 700; letter-spacing: 0.3px; }
          .pay-qr img { width: 110px; height: 110px; object-fit: contain; border: 1px solid #999; padding: 4px; background: #fff; }
          .pay-qr .qr-placeholder { width: 110px; height: 110px; border: 1px dashed #999; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #666; padding: 6px; box-sizing: border-box; }
        </style>
      </head>
      <body>
        <div class="sheet">
          <div class="center">
            <div class="title">QUOTATION</div>
            <div class="company">${escapeHtml(storeName).toUpperCase()}</div>
            <div class="meta small">Factory Address :- ${escapeHtml(storeAddress)}</div>
            <div class="meta small">Mob :- ${escapeHtml(storePhone)} ${storeEmail ? `| ${escapeHtml(storeEmail)}` : ''}</div>
          </div>

          <table class="section">
            <tr>
              <td style="width:12%;font-weight:700;">TO,</td>
              <td style="width:48%;font-weight:700;">${escapeHtml(quotation.customer || '-')}</td>
              <td style="width:20%;font-weight:700;">QUOTATION NO.</td>
              <td style="width:20%;">${escapeHtml(quotation.id || '-')}</td>
            </tr>
            <tr>
              <td style="font-weight:700;">SITE:</td>
              <td>${escapeHtml(quotation.dispatchAddress || '-')}</td>
              <td style="font-weight:700;">DATE</td>
              <td>${escapeHtml(formatDateDisplay(quotation.date))}</td>
            </tr>
            <tr>
              <td style="font-weight:700;">ROAD PERMIT</td>
              <td>${escapeHtml(quotation.roadPermit || '-')}</td>
              <td style="font-weight:700;">CONTACT PERSON</td>
              <td>${escapeHtml(quotation.contactPerson || '-')}</td>
            </tr>
            <tr>
              <td style="font-weight:700;">EMAIL</td>
              <td>${escapeHtml(quotation.email || '-')}</td>
              <td style="font-weight:700;">VALID UNTIL</td>
              <td>${escapeHtml(formatDateDisplay(quotation.validUntil))}</td>
            </tr>
          </table>

          <table class="section">
            <thead>
              <tr>
                <th class="blue" style="width:6%;">S.NO</th>
                <th class="blue" style="width:18%;">PRODUCT NAME</th>
                <th class="blue" style="width:24%;">DESCRIPTION</th>
                <th class="blue" style="width:27%;">IMAGE</th>
                <th class="blue" style="width:7%;">QTY.</th>
                <th class="blue" style="width:8%;">RATE</th>
                <th class="blue" style="width:10%;">AMOUNT</th>
              </tr>
            </thead>
            <tbody>
              ${itemRows}
            </tbody>
          </table>

          <table class="totals section">
            <tr class="bar"><td>TOTAL Rs.</td><td>${Number(quotation.subtotal || 0).toLocaleString('en-IN')}</td></tr>
            ${discountAmount > 0
      ? `<tr><td>${discountTypeLabel}</td><td>-${discountAmount.toLocaleString('en-IN')}</td></tr><tr><td>DISCOUNTED TOTAL</td><td>${subtotalAfterDiscount.toLocaleString('en-IN')}</td></tr>`
      : ''}
            ${Number(quotation.installationPercent || 0) > 0
      ? `<tr><td>INSTALLATION @${quotation.installationPercent || 0}%</td><td>${Number(quotation.installationCharge || 0).toLocaleString('en-IN')}</td></tr>`
      : ''}
            <tr><td>FREIGHT CHARGES</td><td>${Number(quotation.freightCharge || 0).toLocaleString('en-IN')}</td></tr>
            <tr><td>LABOUR UNLOADING</td><td>${Number(quotation.loadingCharge || 0).toLocaleString('en-IN')}</td></tr>
            <tr class="bar"><td>GRAND TOTAL</td><td>${Number(quotation.totalBeforeTax || 0).toLocaleString('en-IN')}</td></tr>
            <tr><td>ADD. GST @${quotation.gstPercent || 0}%</td><td>${Number(quotation.gstAmount || 0).toLocaleString('en-IN')}</td></tr>
            <tr class="final"><td><strong>FINAL AMOUNT</strong></td><td><strong>${Number(quotation.grandTotal || 0).toLocaleString('en-IN')}</strong></td></tr>
          </table>

          <div class="terms">
            <h4>Terms & Conditions</h4>
            <ul>${terms}</ul>
          </div>

          <div class="bank-wrap">
            <div class="bank">
              <p><strong>Bank Details</strong></p>
              <p>Make Cheques in favor of <strong class="brand">${escapeHtml(storeName).toUpperCase()}</strong></p>
              ${populatedBankRows.length > 0
      ? populatedBankRows
        .map(row => `<p>${escapeHtml(row.label)}: ${escapeHtml(row.value)}</p>`)
        .join('')
      : '<p>No bank details provided for this quotation.</p>'}
            </div>
            <div class="pay-qr">
              <p class="pay-title">SCAN & PAY</p>
              ${paymentQrHtml}
            </div>
          </div>
        </div>
      </body>
    </html>
  `
}

function QuotationSheetPreview({ quotation, storeSettings }) {
  const toINR = value => Number(value || 0).toLocaleString('en-IN')
  const terms = Array.isArray(quotation.termsAndConditions) && quotation.termsAndConditions.length > 0
    ? quotation.termsAndConditions
    : defaultTerms
  const items = Array.isArray(quotation.items) ? quotation.items : []
  const paymentQr = storeSettings?.paymentQr || ''
  const bankRows = [
    { label: 'Account Name', value: quotation?.bankDetails?.accountName },
    { label: 'Bank Name', value: quotation?.bankDetails?.bankName },
    { label: 'Account Number', value: quotation?.bankDetails?.accountNumber },
    { label: 'IFSC Code', value: quotation?.bankDetails?.ifscCode },
    { label: 'Branch', value: quotation?.bankDetails?.branchName },
    { label: 'UPI ID', value: quotation?.bankDetails?.upiId },
  ].filter(row => String(row.value || '').trim())
  const discountAmount = Number(quotation.discountAmount || 0)
  const discountTypeLabel = quotation.discountType === 'FLAT'
    ? `DISCOUNT (Rs. ${toINR(quotation.discountValue || 0)})`
    : `DISCOUNT (${Number(quotation.discountValue || 0)}%)`
  const subtotalAfterDiscount = Math.max(0, Number(quotation.subtotal || 0) - discountAmount)

  return (
    <div className="bg-white text-black border-[3px] border-black rounded-sm overflow-hidden text-[10px]">
      <div className="text-center border-b-2 border-black">
        <p className="font-bold text-[12px] underline mt-1">QUOTATION</p>
        <p className="font-extrabold text-[24px] md:text-[30px] tracking-wide text-[#06a9d6] leading-tight px-2 mt-1">
          {(storeSettings?.storeName || DEFAULT_STORE_NAME).toUpperCase()}
        </p>
        <p className="px-2 text-[10px]">Factory Address :- {storeSettings?.address || 'Store address not set'}</p>
        <p className="px-2 pb-1 text-[10px]">
          Mob :- {storeSettings?.phone || ''}
          {storeSettings?.email ? ` | ${storeSettings.email}` : ''}
        </p>
      </div>

      <table className="w-full border-collapse text-[10px]">
        <tbody>
          <tr>
            <td className="border border-black p-1 font-semibold w-[12%]">TO,</td>
            <td className="border border-black p-1 font-semibold w-[48%]">{quotation.customer || 'Customer Name'}</td>
            <td className="border border-black p-1 font-semibold w-[20%]">QUOTATION NO.</td>
            <td className="border border-black p-1 w-[20%]">{quotation.id || 'Auto'}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 font-semibold">SITE</td>
            <td className="border border-black p-1 whitespace-pre-wrap">{quotation.dispatchAddress || '-'}</td>
            <td className="border border-black p-1 font-semibold">DATE</td>
            <td className="border border-black p-1">{formatDateDisplay(quotation.date)}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 font-semibold">ROAD PERMIT</td>
            <td className="border border-black p-1">{quotation.roadPermit || '-'}</td>
            <td className="border border-black p-1 font-semibold">CONTACT PERSON</td>
            <td className="border border-black p-1">{quotation.contactPerson || '-'}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 font-semibold">EMAIL</td>
            <td className="border border-black p-1">{quotation.email || '-'}</td>
            <td className="border border-black p-1 font-semibold">VALID UNTIL</td>
            <td className="border border-black p-1">{formatDateDisplay(quotation.validUntil)}</td>
          </tr>
        </tbody>
      </table>

      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[6%]">S.NO</th>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[18%]">PRODUCT NAME</th>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[24%]">DESCRIPTION</th>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[27%]">IMAGE</th>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[7%]">QTY / UOM</th>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[8%]">RATE</th>
            <th className="border border-black bg-[#0ea5d8] text-white font-bold p-1 w-[10%]">AMOUNT</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr key={`${item.name}-${idx}`}>
              <td className="border border-black p-1 text-center align-top">{idx + 1}</td>
              <td className="border border-black p-1 align-top font-semibold">{item.name || 'Item name'}</td>
              <td className="border border-black p-1 align-top whitespace-pre-wrap">{item.description || '-'}</td>
              <td className="border border-black p-1 align-top text-center">
                {getItemDisplayImage(item) ? (
                  <Image
                    src={getItemDisplayImage(item)}
                    alt="item"
                    width={96}
                    height={64}
                    unoptimized
                    className="w-24 h-16 object-cover border border-gray-400 mx-auto"
                  />
                ) : (
                  <span className="text-[9px] text-gray-600">No image</span>
                )}
              </td>
              <td className="border border-black p-1 text-center align-top">{item.quantity} {item.unitOfMeasure || 'PCS'}{item.areaSqft ? <div className="text-[9px] text-gray-600">{Number(item.areaSqft).toFixed(2)} sq.ft</div> : null}</td>
              <td className="border border-black p-1 text-right align-top">{toINR(item.rate)}</td>
              <td className="border border-black p-1 text-right align-top">{toINR(item.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="w-full border-collapse text-[10px]">
        <tbody>
          <tr>
            <td className="border border-black p-1 text-right font-semibold bg-[#0ea5d8] text-white">TOTAL Rs.</td>
            <td className="border border-black p-1 text-right w-[28%] bg-[#0ea5d8] text-white font-semibold">{toINR(quotation.subtotal)}</td>
          </tr>
          {discountAmount > 0 && (
            <>
              <tr>
                <td className="border border-black p-1 text-right font-semibold">{discountTypeLabel}</td>
                <td className="border border-black p-1 text-right">-{toINR(discountAmount)}</td>
              </tr>
              <tr>
                <td className="border border-black p-1 text-right font-semibold">DISCOUNTED TOTAL</td>
                <td className="border border-black p-1 text-right">{toINR(subtotalAfterDiscount)}</td>
              </tr>
            </>
          )}
          {Number(quotation.installationPercent || 0) > 0 && (
            <tr>
              <td className="border border-black p-1 text-right font-semibold">INSTALLATION @{Number(quotation.installationPercent || 0)}%</td>
              <td className="border border-black p-1 text-right">{toINR(quotation.installationCharge)}</td>
            </tr>
          )}
          <tr>
            <td className="border border-black p-1 text-right font-semibold">FREIGHT CHARGES</td>
            <td className="border border-black p-1 text-right">{toINR(quotation.freightCharge)}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 text-right font-semibold">LABOUR UNLOADING</td>
            <td className="border border-black p-1 text-right">{toINR(quotation.loadingCharge)}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 text-right font-semibold bg-[#0ea5d8] text-white">GRAND TOTAL</td>
            <td className="border border-black p-1 text-right bg-[#0ea5d8] text-white font-semibold">{toINR(quotation.totalBeforeTax)}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 text-right font-semibold">ADD. GST @{Number(quotation.gstPercent || 0)}%</td>
            <td className="border border-black p-1 text-right">{toINR(quotation.gstAmount)}</td>
          </tr>
          <tr>
            <td className="border border-black p-1 text-right font-bold bg-[#e8f7fc]">FINAL AMOUNT</td>
            <td className="border border-black p-1 text-right font-bold bg-[#e8f7fc]">{toINR(quotation.grandTotal)}</td>
          </tr>
        </tbody>
      </table>

      <div className="p-2 border-t-2 border-black">
        <h4 className="text-[11px] font-bold underline mb-1">Terms & Conditions</h4>
        <ul className="space-y-0.5">
          {terms.map((term, idx) => (
            <li key={`${term}-${idx}`} className={`text-[#6b4d8e] ${idx === 6 ? 'bg-[#0ea5d8] text-white px-1' : ''}`}>
              {idx + 1}. {term}
            </li>
          ))}
        </ul>
      </div>

      <div className="px-2 pb-2 text-[10px] text-[#6b4d8e]">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p>Make Cheques in Favor of <span className="text-[#06a9d6] font-bold">{(storeSettings?.storeName || DEFAULT_STORE_NAME).toUpperCase()}</span>.</p>
            {bankRows.length > 0 ? (
              <div className="mt-1 space-y-0.5">
                {bankRows.map(row => (
                  <p key={row.label}>{row.label}: {row.value}</p>
                ))}
              </div>
            ) : (
              <p>No bank details provided for this quotation.</p>
            )}
          </div>
          <div className="w-28 shrink-0 text-center text-black">
            <p className="text-[9px] font-bold tracking-wide">SCAN & PAY</p>
            {paymentQr ? (
              <Image
                src={paymentQr}
                alt="Payment QR"
                width={96}
                height={96}
                unoptimized
                className="mt-1 mx-auto w-24 h-24 object-contain border border-black p-1 bg-white"
              />
            ) : (
              <div className="mt-1 mx-auto w-24 h-24 border border-dashed border-gray-500 text-[8px] text-gray-600 px-1 flex items-center justify-center">
                PAYMENT QR NOT ADDED
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function QuotationsPage() {
  const { notify } = useAlertToast()
  const [quotationToDraft, setQuotationToDraft] = useState(null)
  const [deletingQuotation, setDeletingQuotation] = useState(false)
  const [quotations, setQuotations] = useState([])
  const [products, setProducts] = useState([])
  const [storeSettings, setStoreSettings] = useState(null)
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [showGenerator, setShowGenerator] = useState(false)
  const [editingQuotationId, setEditingQuotationId] = useState(null)
  const [selectedQuotation, setSelectedQuotation] = useState(null)
  const [uploadingIndex, setUploadingIndex] = useState(null)
  const [uploadingPaymentQr, setUploadingPaymentQr] = useState(false)
  const [form, setForm] = useState(createInitialForm())
  const [pricelists, setPricelists] = useState([])

  const loadData = useCallback(async () => {
    const [qRes, pRes, sRes, statRes, plRes] = await Promise.all([
      getQuotations(),
      getProducts(),
      getStoreSettings(),
      getQuotationStats(),
      getPricelists(),
    ])

    if (plRes.success) setPricelists(plRes.data.filter(list => list.active))

    if (qRes.success) setQuotations(qRes.data)
    if (pRes.success) setProducts(pRes.data)
    if (sRes.success) setStoreSettings(sRes.data)
    if (statRes.success) setStats(statRes.data)

    setLoading(false)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void loadData() }, 0)
    return () => clearTimeout(timer)
  }, [loadData])

  const computed = useMemo(
    () => computeTotals(
      form.items,
      form.installationPercent,
      form.discountType,
      form.discountValue,
      form.freightCharge,
      form.loadingCharge,
      form.gstPercent,
      products
    ),
    [form.items, form.installationPercent, form.discountType, form.discountValue, form.freightCharge, form.loadingCharge, form.gstPercent, products]
  )

  const previewQuotation = useMemo(() => {
    const termsAndConditions = form.termsText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)

    return {
      id: 'PREVIEW',
      customer: form.customer,
      phone: form.phone,
      email: form.email,
      dispatchAddress: form.dispatchAddress,
      date: form.date,
      deliveryMode: form.deliveryMode,
      roadPermit: form.roadPermit,
      contactPerson: form.contactPerson,
      items: computed.normalizedItems,
      subtotal: computed.subtotal,
      installationPercent: Number(form.installationPercent) || 0,
      discountType: computed.discountType,
      discountValue: computed.discountValue,
      discountAmount: computed.discountAmount,
      subtotalAfterDiscount: computed.subtotalAfterDiscount,
      installationCharge: computed.installationCharge,
      freightCharge: computed.freight,
      loadingCharge: computed.loading,
      totalBeforeTax: computed.totalBeforeTax,
      gstPercent: Number(form.gstPercent) || 0,
      gstAmount: computed.gstAmount,
      grandTotal: computed.grandTotal,
      bankDetails: form.bankDetails,
      termsAndConditions: termsAndConditions.length > 0 ? termsAndConditions : defaultTerms,
    }
  }, [form, computed])

  const filteredQuotations = useMemo(() => {
    return quotations.filter(quotation => {
      const inSearch =
        quotation.id.toLowerCase().includes(search.toLowerCase()) ||
        quotation.customer.toLowerCase().includes(search.toLowerCase()) ||
        quotation.phone.toLowerCase().includes(search.toLowerCase())

      const inStatus = statusFilter === 'ALL' || quotation.statusKey === statusFilter
      return inSearch && inStatus
    })
  }, [quotations, search, statusFilter])

  const isEditMode = editingQuotationId !== null

  const openNewQuotationModal = () => {
    setEditingQuotationId(null)
    setForm({ ...createInitialForm(), bankDetails: loadSavedBankDetails() })
    setShowGenerator(true)
  }

  const openEditQuotationModal = quotation => {
    setEditingQuotationId(quotation.dbId)
    setForm(buildFormFromQuotation(quotation))
    setSelectedQuotation(null)
    setShowGenerator(true)
  }

  const updateItem = (index, patch) => {
    setForm(prev => ({
      ...prev,
      items: prev.items.map((item, idx) => (idx === index ? { ...item, ...patch } : item)),
    }))
  }

  const updateBankDetails = patch => {
    setForm(prev => ({
      ...prev,
      bankDetails: {
        ...(prev.bankDetails || createBlankBankDetails()),
        ...patch,
      },
    }))
  }

  const addItem = () => {
    setForm(prev => ({ ...prev, items: [...prev.items, createBlankItem()] }))
  }

  const removeItem = index => {
    setForm(prev => ({
      ...prev,
      items: prev.items.length > 1 ? prev.items.filter((_, idx) => idx !== index) : prev.items,
    }))
  }

  // Odoo pricelists: rates come from the chosen pricelist, else the customer's
  // (matched by phone), else the default list. Quantity breaks apply.
  const priceLines = async (items, indices) => {
    const targets = indices.filter(index => items[index]?.productId)
    if (targets.length === 0) return
    const res = await getPricesFor({
      pricelistId: form.pricelistId ? Number(form.pricelistId) : null,
      phone: form.phone.trim() || null,
      lines: targets.map(index => ({ productId: Number(items[index].productId), quantity: Number(items[index].quantity) || 1 })),
    })
    if (!res.success) return notify(res.error, { variant: 'danger' })
    setForm(prev => ({
      ...prev,
      pricedFrom: res.data.pricelist?.name || null,
      items: prev.items.map((item, index) => {
        const at = targets.indexOf(index)
        const price = at > -1 ? res.data.prices[at]?.price : null
        return price != null && String(item.productId) === String(items[index].productId) ? { ...item, rate: price } : item
      }),
    }))
  }

  const handleProductSelect = (index, productIdValue) => {
    const selection = String(productIdValue || '')

    if (selection === 'custom') {
      updateItem(index, {
        productId: '',
        productImage: '',
        imageSource: 'REFERENCE',
        isCustom: true,
      })
      return
    }

    if (!selection) {
      updateItem(index, {
        productId: '',
        name: '',
        sku: '',
        rate: 0,
        description: '',
        productImage: '',
        imageSource: 'REFERENCE',
        isCustom: false,
      })
      return
    }

    const productId = parseInt(selection, 10)
    const product = products.find(p => p.id === productId)

    if (!product) {
      updateItem(index, {
        productId: '',
        productImage: '',
        imageSource: 'REFERENCE',
        isCustom: true,
      })
      return
    }

    updateItem(index, {
      productId: product.id,
      name: product.name,
      sku: product.sku,
      description: getProductAutoDescription(product),
      rate: product.price,
      unitOfMeasure: product.unitOfMeasure || 'PCS',
      coveragePerBox: product.coveragePerBox || 0,
      productImage: product.image || '',
      imageSource: product.image ? 'PRODUCT' : 'REFERENCE',
      isCustom: false,
    })
    if (pricelists.length > 0) void priceLines(form.items.map((item, idx) => (idx === index ? { ...item, productId: product.id } : item)), [index])
  }

  const handlePaymentQrUpload = async files => {
    const file = files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      notify('Please upload a valid image file', { variant: 'danger' })
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      notify('File too large. Maximum size is 5MB', { variant: 'danger' })
      return
    }

    setUploadingPaymentQr(true)
    try {
      const formData = new FormData()
      formData.set('folder', 'payments')
      formData.append('files', file)

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()

      if (!data.success || !data.urls?.[0]) {
        notify(data.error || 'QR upload failed', { variant: 'danger' })
        return
      }

      const paymentQrUrl = data.urls[0]
      const saveRes = await updateStoreSettings({ paymentQr: paymentQrUrl })
      if (!saveRes?.success) {
        notify(saveRes?.error || 'Failed to save payment QR', { variant: 'danger' })
        return
      }

      setStoreSettings(prev => ({ ...(prev || {}), paymentQr: paymentQrUrl }))
      notify('Payment QR saved for all quotations', { variant: 'success' })
    } catch (error) {
      console.error(error)
      notify('QR upload failed. Please try again.', { variant: 'danger' })
    } finally {
      setUploadingPaymentQr(false)
    }
  }

  const handleDeletePaymentQr = async () => {
    if (!confirm('Are you sure you want to remove the Payment QR code?')) return

    setUploadingPaymentQr(true)
    try {
      const saveRes = await updateStoreSettings({ paymentQr: null })
      if (!saveRes?.success) {
        notify(saveRes?.error || 'Failed to remove payment QR', { variant: 'danger' })
        return
      }

      setStoreSettings(prev => ({ ...(prev || {}), paymentQr: '' }))
      notify('Payment QR removed successfully', { variant: 'success' })
    } catch (error) {
      console.error(error)
      notify('Failed to remove QR. Please try again.', { variant: 'danger' })
    } finally {
      setUploadingPaymentQr(false)
    }
  }

  const handleReferenceImageUpload = async (index, files) => {
    const file = files?.[0]
    if (!file) return

    setUploadingIndex(index)

    try {
      const formData = new FormData()
      formData.set('folder', 'quotations')
      formData.append('file', file)

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      })
      const data = await response.json()

      if (data.success && data.urls?.[0]) {
        updateItem(index, { referenceImage: data.urls[0], imageSource: 'REFERENCE' })
      } else {
        alert(data.error || 'Image upload failed')
      }
    } catch (error) {
      console.error(error)
      alert('Image upload failed. Please try again.')
    } finally {
      setUploadingIndex(null)
    }
  }

  const handleCreateQuotation = async e => {
    e.preventDefault()

    if (!form.customer.trim() || !form.phone.trim()) {
      alert('Customer name and phone are required')
      return
    }

    const termsAndConditions = form.termsText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)

    const payload = {
      customer: form.customer.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      dispatchAddress: form.dispatchAddress.trim(),
      date: form.date,
      validUntil: form.validUntil || undefined,
      projectName: form.projectName.trim(),
      deliveryMode: form.deliveryMode.trim(),
      roadPermit: form.roadPermit.trim(),
      contactPerson: form.contactPerson.trim(),
      installationPercent: Number(form.installationPercent) || 0,
      discountType: form.discountType === 'FLAT' ? 'FLAT' : 'PERCENT',
      discountValue: Number(form.discountValue) || 0,
      freightCharge: Number(form.freightCharge) || 0,
      loadingCharge: Number(form.loadingCharge) || 0,
      gstPercent: Number(form.gstPercent) || 0,
      bankDetails: {
        accountName: (form.bankDetails?.accountName || '').trim(),
        bankName: (form.bankDetails?.bankName || '').trim(),
        accountNumber: (form.bankDetails?.accountNumber || '').trim(),
        ifscCode: (form.bankDetails?.ifscCode || '').trim(),
        branchName: (form.bankDetails?.branchName || '').trim(),
        upiId: (form.bankDetails?.upiId || '').trim(),
      },
      notes: form.notes.trim(),
      termsAndConditions,
      pricelistId: form.pricelistId ? Number(form.pricelistId) : null,
      items: computed.normalizedItems.map(item => ({
        productId: item.productId || undefined,
        name: item.name.trim(),
        sku: item.sku?.trim(),
         description: item.description?.trim(),
         quantity: Number(item.quantity) || 1,
         rate: Number(item.rate) || 0,
         unitOfMeasure: item.unitOfMeasure || 'PCS',
         areaSqft: Number(item.area ?? item.areaInput) > 0 ? Number(item.area ?? item.areaInput) : undefined,
         coveragePerBox: Number(item.coveragePerBox) > 0 ? Number(item.coveragePerBox) : undefined,
         referenceImage: getItemDisplayImage(item) || undefined,
      })),
    }

    setSaving(true)

    const result = isEditMode
      ? await updateQuotation({ id: editingQuotationId, ...payload })
      : await createQuotation(payload)

    if (result.success) {
      // Persist bank details so they auto-fill next time
      saveBankDetailsToStorage({
        accountName: (form.bankDetails?.accountName || '').trim(),
        bankName: (form.bankDetails?.bankName || '').trim(),
        accountNumber: (form.bankDetails?.accountNumber || '').trim(),
        ifscCode: (form.bankDetails?.ifscCode || '').trim(),
        branchName: (form.bankDetails?.branchName || '').trim(),
        upiId: (form.bankDetails?.upiId || '').trim(),
      })
      setForm(createInitialForm())
      setEditingQuotationId(null)
      setShowGenerator(false)
      await loadData()
      setSelectedQuotation(result.data)
    } else {
      alert(result.error || 'Failed to create quotation')
    }

    setSaving(false)
  }

  const handleStatusChange = async (quotationId, status) => {
    const result = await updateQuotationStatus({ id: quotationId, status })
    if (!result.success) {
      alert(result.error || 'Unable to update status')
      return
    }

    await loadData()
    if (selectedQuotation?.dbId === quotationId) {
      const fresh = await getQuotations()
      if (fresh.success) {
        const updated = fresh.data.find(item => item.dbId === quotationId)
        if (updated) setSelectedQuotation(updated)
      }
    }
  }

  // Odoo flow: an accepted quotation is confirmed into a Sales Order, which
  // plans the delivery orders and invoices what is actually delivered.
  const handleConfirmSalesOrder = async (quotation) => {
    if (!quotation?.dbId) return
    if (quotation.salesOrder) {
      window.location.href = `/sales-orders/${quotation.salesOrder.id}`
      return
    }
    const confirmed = window.confirm(`Confirm quotation ${quotation.id} as a sales order? A delivery order is planned from the default location.`)
    if (!confirmed) return
    const result = await createSalesOrderFromQuotation({ quotationId: quotation.dbId })
    if (!result.success) {
      notify(result.error || 'Unable to confirm the quotation', { variant: 'danger' })
      return
    }
    if (result.data.warnings?.length) notify(`${result.data.displayId} confirmed with stock warnings: ${result.data.warnings.join('; ')}`, { variant: 'warning' })
    else notify(`Sales order ${result.data.displayId} confirmed`, { variant: 'success' })
    window.location.href = `/sales-orders/${result.data.id}`
  }

  const handleConvertToInvoice = async (quotation) => {
    if (!quotation?.dbId) return
    const confirmed = window.confirm(`Create a held invoice from quotation ${quotation.id}?`)
    if (!confirmed) return
    const result = await convertQuotationToInvoice(quotation.dbId)
    if (!result.success) {
      notify(result.error || 'Unable to convert quotation', { variant: 'danger' })
      return
    }
    notify(`Held invoice ${result.data?.displayId || ''} created. Open Billing to finalize it.`, { variant: 'success' })
    setSelectedQuotation(null)
    await loadData()
  }

  const handleMoveToDraft = (quotation) => {
    // open confirmation modal
    setQuotationToDraft(quotation)
  }

  const confirmMoveQuotationToDraft = async () => {
    if (!quotationToDraft) return
    setDeletingQuotation(true)
    try {
      const result = await moveQuotationToDraft(quotationToDraft.dbId)
      if (!result.success) {
        notify(result.error || 'Failed to move quotation to drafts', { variant: 'danger' })
      } else {
        notify('Quotation moved to drafts', { variant: 'success' })
        await loadData()
        if (selectedQuotation?.dbId === quotationToDraft.dbId) setSelectedQuotation(null)
      }
    } catch (err) {
      notify(err?.message || 'Failed to move quotation to drafts', { variant: 'danger' })
    } finally {
      setDeletingQuotation(false)
      setQuotationToDraft(null)
    }
  }

  const handlePrint = quotation => {
    const printWindow = window.open('', '_blank', 'width=900,height=1200')
    if (!printWindow) return

    printWindow.document.write(buildPrintHtml(quotation, storeSettings))
    printWindow.document.close()
    printWindow.focus()

    setTimeout(() => {
      printWindow.print()
    }, 300)
  }

  // Loads html2pdf.js once into the main document (safe for all browsers including iOS)
  const loadHtml2Pdf = () => new Promise((resolve, reject) => {
    if (window.html2pdf) { resolve(window.html2pdf); return; }
    const existing = document.querySelector('script[data-html2pdf]');
    if (existing) {
      // Already loading — wait for it
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

  const handleDownload = async (quotation) => {
    try {
      const html2pdf = await loadHtml2Pdf();

      // Render into a hidden div in the MAIN document (not an iframe)
      // This avoids all iframe sandboxing and cross-origin restrictions on mobile
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;left:-9999px;top:0;width:900px;background:#fff;z-index:-1;';
      container.innerHTML = buildPrintHtml(quotation, storeSettings);
      document.body.appendChild(container);

      const element = container.querySelector('.sheet') || container;
      const opt = {
        margin: 0,
        filename: `Quotation_${quotation.id}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, allowTaint: true },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
      };

      await html2pdf().set(opt).from(element).save();
      document.body.removeChild(container);
    } catch (err) {
      console.error('PDF download failed:', err);
      // Graceful fallback: open print dialog (works on all mobile browsers)
      handlePrint(quotation);
    }
  }



  const handleShareQuotationWhatsApp = (quotation) => {
    if (!quotation?.phone) {
      notify('Customer phone number is missing', { variant: 'danger' })
      return
    }

    const message = buildQuotationShareMessage(quotation, storeSettings) + '\n\n*(Quotation PDF is attached)*'

    // For mobile devices, try to use native Web Share API to attach the file directly
    if (navigator.share && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
      notify('Preparing PDF for sharing...', { variant: 'info' })
      const element = document.createElement('div')
      element.innerHTML = buildPrintHtml(quotation, storeSettings)

      const opt = {
        margin: 0,
        filename: 'Quotation_${quotation.id}.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
      }

      html2pdf().set(opt).from(element).outputPdf('blob').then(async (pdfBlob) => {
        const file = new File([pdfBlob], 'Quotation_${quotation.id}.pdf', { type: 'application/pdf' })
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Quotation ${quotation.id}',
              text: buildQuotationShareMessage(quotation, storeSettings)
            })
            return
          } catch (err) {
            console.warn('Share failed', err)
          }
        }
        // Fallback if sharing fails
        fallbackShare(quotation, message)
      })
    } else {
      fallbackShare(quotation, message)
    }
  }

  const fallbackShare = (quotation, message) => {
    handleDownload(quotation)
    notify('PDF downloaded! Please attach it to the WhatsApp chat.', { variant: 'success' })
    const url = buildWhatsAppUrl(quotation.phone, message)
    setTimeout(() => {
      window.open(url, '_blank', 'noopener,noreferrer')
    }, 600)
  }

  const handleShareQuotationEmail = (quotation) => {
    if (!quotation?.email) {
      notify('Customer email is missing', { variant: 'danger' })
      return
    }
    const subject = `Quotation ${quotation.id} from ${storeSettings?.storeName || DEFAULT_STORE_NAME}`
    const body = buildQuotationShareMessage(quotation, storeSettings)
    const url = buildMailtoUrl(quotation.email, subject, body)
    if (!url) return
    window.location.href = url
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-72 bg-surface rounded-lg" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-24 bg-surface rounded-2xl" />
          ))}
        </div>
        <div className="h-64 bg-surface rounded-2xl" />
      </div>
    )
  }

  return (
    <div className="space-y-5 md:space-y-6 animate-[fade-in_0.3s_ease]">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Quotation Generator</h1>
          <p className="text-sm text-muted mt-1">Generate structured quotations with inventory-linked items and reference images</p>
        </div>
        <button
          onClick={openNewQuotationModal}
          className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"
        >
          <Plus className="w-4 h-4" /> New Quotation
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-accent-light"><FileText className="w-5 h-5 text-accent" /></div>
          <div>
            <p className="text-xs text-muted">Total Quotations</p>
            <p className="text-lg font-bold text-foreground">{stats?.total || 0}</p>
          </div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/10"><CalendarDays className="w-5 h-5 text-blue-700" /></div>
          <div>
            <p className="text-xs text-muted">Draft + Sent</p>
            <p className="text-lg font-bold text-blue-700">{(stats?.draft || 0) + (stats?.sent || 0)}</p>
          </div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10"><Package className="w-5 h-5 text-emerald-700" /></div>
          <div>
            <p className="text-xs text-muted">Approved</p>
            <p className="text-lg font-bold text-emerald-700">{stats?.approved || 0}</p>
          </div>
        </div>
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-purple-500/10"><IndianRupee className="w-5 h-5 text-purple-700" /></div>
          <div>
            <p className="text-xs text-muted">Quoted Value</p>
            <p className="text-lg font-bold text-purple-700">{formatCurrency(stats?.totalValue || 0)}</p>
          </div>
        </div>
      </div>

      <div className="glass-card p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by quotation no, customer, or phone"
              className="w-full pl-10 pr-4 py-2.5 bg-surface rounded-xl border border-border text-sm"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto hide-scrollbar">
            {['ALL', 'DRAFT', 'SENT', 'APPROVED', 'REJECTED'].map(status => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${statusFilter === status ? 'bg-accent text-white' : 'text-muted hover:text-foreground hover:bg-surface-hover'
                  }`}
              >
                {status === 'ALL' ? 'All' : status.charAt(0) + status.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto hidden md:block">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Quotation No.</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredQuotations.map(quotation => (
                <tr key={quotation.dbId}>
                  <td>
                    <span className="font-mono text-accent font-medium">{quotation.id}</span>
                  </td>
                  <td>
                    <p className="font-medium text-foreground">{quotation.customer}</p>
                    <p className="text-xs text-muted">{quotation.phone}</p>
                  </td>
                  <td>{quotation.date}</td>
                  <td>{quotation.items.length}</td>
                  <td className="font-semibold text-foreground">{formatCurrency(quotation.grandTotal)}</td>
                  <td>
                    <select
                      value={quotation.statusKey}
                      onChange={e => handleStatusChange(quotation.dbId, e.target.value)}
                      className={`px-2 py-1 rounded-lg text-xs border ${statusColors[quotation.statusKey]}`}
                    >
                      {['DRAFT', 'SENT', 'APPROVED', 'REJECTED'].map(status => (
                        <option key={status} value={status}>{status.charAt(0) + status.slice(1).toLowerCase()}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleShareQuotationWhatsApp(quotation)}
                        className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-muted hover:text-emerald-700 transition-colors"
                        title="Share on WhatsApp"
                      >
                        <MessageSquare className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleShareQuotationEmail(quotation)}
                        className="p-1.5 rounded-lg hover:bg-blue-500/10 text-muted hover:text-blue-700 transition-colors"
                        title="Share by Email"
                      >
                        <Mail className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => openEditQuotationModal(quotation)}
                        className="p-1.5 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setSelectedQuotation(quotation)}
                        className="p-1.5 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                        title="View"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handlePrint(quotation)}
                        className="p-1.5 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                        title="Print"
                      >
                        <Printer className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDownload(quotation)}
                        className="p-1.5 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                        title="Download PDF"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleMoveToDraft(quotation)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted hover:text-red-600 transition-colors"
                        title="Move to Draft"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredQuotations.length === 0 && (
            <div className="text-center py-10 text-sm text-muted">No quotations found for current filters</div>
          )}
        </div>

        {/* Mobile stacked cards */}
        <div className="md:hidden space-y-3">
          {filteredQuotations.map(quotation => (
            <div key={quotation.dbId} className="rounded-2xl border border-border bg-surface p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-mono text-accent font-semibold text-sm">{quotation.id}</span>
                  <p className="font-semibold text-foreground truncate mt-0.5">{quotation.customer}</p>
                  <p className="text-xs text-muted truncate">{quotation.phone}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-base font-bold text-foreground">{formatCurrency(quotation.grandTotal)}</p>
                  <p className="text-xs text-muted mt-0.5">{quotation.items.length} item{quotation.items.length === 1 ? '' : 's'}</p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <CalendarDays className="w-3.5 h-3.5" /> {quotation.date}
                </span>
                <select
                  value={quotation.statusKey}
                  onChange={e => handleStatusChange(quotation.dbId, e.target.value)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs border ${statusColors[quotation.statusKey]}`}
                >
                  {['DRAFT', 'SENT', 'APPROVED', 'REJECTED'].map(status => (
                    <option key={status} value={status}>{status.charAt(0) + status.slice(1).toLowerCase()}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-7 gap-1 pt-2 border-t border-border">
                <button
                  onClick={() => handleShareQuotationWhatsApp(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-emerald-500/10 text-muted hover:text-emerald-600 transition-colors"
                  title="Share on WhatsApp"
                >
                  <MessageSquare className="w-5 h-5" />
                </button>
                <button
                  onClick={() => handleShareQuotationEmail(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-blue-500/10 text-muted hover:text-blue-600 transition-colors"
                  title="Share by Email"
                >
                  <Mail className="w-5 h-5" />
                </button>
                <button
                  onClick={() => openEditQuotationModal(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                  title="Edit"
                >
                  <Pencil className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setSelectedQuotation(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                  title="View"
                >
                  <Eye className="w-5 h-5" />
                </button>
                <button
                  onClick={() => handlePrint(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                  title="Print"
                >
                  <Printer className="w-5 h-5" />
                </button>
                <button
                  onClick={() => handleDownload(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                  title="Download PDF"
                >
                  <Download className="w-5 h-5" />
                </button>
                <button
                  onClick={() => handleMoveToDraft(quotation)}
                  className="touch-target flex items-center justify-center rounded-lg hover:bg-red-500/10 text-muted hover:text-red-600 transition-colors"
                  title="Move to Draft"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
          {filteredQuotations.length === 0 && (
            <div className="text-center py-10 text-sm text-muted">No quotations found for current filters</div>
          )}
        </div>
      </div>

      <Modal isOpen={!!quotationToDraft} onClose={() => setQuotationToDraft(null)} title="Move Quotation to Draft" size="sm">
        {quotationToDraft && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Move <strong className="text-foreground">{quotationToDraft.customer || quotationToDraft.id}</strong> to drafts? It will be permanently deleted after 30 days.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setQuotationToDraft(null)} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
              <button onClick={confirmMoveQuotationToDraft} disabled={deletingQuotation} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">{deletingQuotation ? 'Moving...' : 'Move to Draft'}</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={showGenerator}
        onClose={() => {
          setShowGenerator(false)
          setEditingQuotationId(null)
          setForm(createInitialForm())
        }}
        title={isEditMode ? 'Edit Quotation' : 'Create Quotation'}
        size="xl"
      >
        <form onSubmit={handleCreateQuotation} className="space-y-5">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Customer Name *</label>
                  <input
                    value={form.customer}
                    onChange={e => setForm(prev => ({ ...prev, customer: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Phone *</label>
                  <input
                    value={form.phone}
                    onChange={e => setForm(prev => ({ ...prev, phone: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                    required
                  />
                </div>
                {pricelists.length > 0 && (
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-muted mb-1.5">Pricelist</label>
                    <div className="flex gap-2">
                      <select
                        value={form.pricelistId}
                        onChange={e => setForm(prev => ({ ...prev, pricelistId: e.target.value }))}
                        className="w-full px-3 py-2.5 rounded-xl text-sm"
                      >
                        <option value="">Customer&apos;s pricelist / default</option>
                        {pricelists.map(list => <option key={list.id} value={list.id}>{list.name}{list.isDefault ? ' (default)' : ''}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={() => priceLines(form.items, form.items.map((_, idx) => idx))}
                        className="px-3 py-2.5 rounded-xl text-sm border border-border text-foreground whitespace-nowrap hover:bg-surface-hover"
                      >
                        Apply prices
                      </button>
                    </div>
                    {form.pricedFrom && <p className="text-[11px] text-muted mt-1">Rates priced from {form.pricedFrom}. Edit a rate to override it.</p>}
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Contact Person</label>
                  <input
                    value={form.contactPerson}
                    onChange={e => setForm(prev => ({ ...prev, contactPerson: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Site / Dispatch Address</label>
                <textarea
                  rows={2}
                  value={form.dispatchAddress}
                  onChange={e => setForm(prev => ({ ...prev, dispatchAddress: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm resize-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={e => setForm(prev => ({ ...prev, date: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Valid Until</label>
                  <input
                    type="date"
                    value={form.validUntil}
                    onChange={e => setForm(prev => ({ ...prev, validUntil: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Road Permit</label>
                  <input
                    value={form.roadPermit}
                    onChange={e => setForm(prev => ({ ...prev, roadPermit: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">Bank Details</h3>
                  <p className="text-[11px] text-muted">These details are printed on the quotation and can be updated per quote.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Account Name</label>
                    <input
                      value={form.bankDetails?.accountName || ''}
                      onChange={e => updateBankDetails({ accountName: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Bank Name</label>
                    <input
                      value={form.bankDetails?.bankName || ''}
                      onChange={e => updateBankDetails({ bankName: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Account Number</label>
                    <input
                      value={form.bankDetails?.accountNumber || ''}
                      onChange={e => updateBankDetails({ accountNumber: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">IFSC Code</label>
                    <input
                      value={form.bankDetails?.ifscCode || ''}
                      onChange={e => updateBankDetails({ ifscCode: e.target.value.toUpperCase() })}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">Branch Name</label>
                    <input
                      value={form.bankDetails?.branchName || ''}
                      onChange={e => updateBankDetails({ branchName: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1.5">UPI ID</label>
                    <input
                      value={form.bankDetails?.upiId || ''}
                      onChange={e => updateBankDetails({ upiId: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-xl text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                      <QrCode className="w-4 h-4 text-accent" /> Payment QR
                    </h3>
                    <p className="text-[11px] text-muted">Set once for all quotations. You can replace it anytime.</p>
                  </div>
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-muted hover:text-accent hover:border-accent/40 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    {uploadingPaymentQr ? 'Uploading...' : storeSettings?.paymentQr ? 'Change QR' : 'Upload QR'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={uploadingPaymentQr}
                      onChange={e => {
                        handlePaymentQrUpload(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  {storeSettings?.paymentQr && (
                    <button
                      type="button"
                      onClick={handleDeletePaymentQr}
                      disabled={uploadingPaymentQr}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-danger/20 text-xs text-danger hover:bg-danger/10 transition-colors"
                    >
                      Remove QR
                    </button>
                  )}
                </div>

                {storeSettings?.paymentQr ? (
                  <div className="flex items-center gap-3">
                    <Image
                      src={storeSettings.paymentQr}
                      alt="Payment QR"
                      width={96}
                      height={96}
                      unoptimized
                      className="w-24 h-24 rounded-lg border border-border bg-white p-1 object-contain"
                    />
                    <p className="text-[11px] text-muted">This QR appears in the quotation preview and print sheet.</p>
                  </div>
                ) : (
                  <div className="w-24 h-24 rounded-lg border border-dashed border-border flex items-center justify-center text-[10px] text-muted text-center px-2">
                    Payment QR not added
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Quotation Items</h3>
                  <button
                    type="button"
                    onClick={addItem}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted hover:text-accent hover:border-accent/40"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Item
                  </button>
                </div>

                {form.items.map((item, index) => {
                  const lineProduct = item.productId ? products.find(p => p.id === item.productId) : undefined
                  const line = computeLineAmount(item, lineProduct)
                  const amount = line.amount
                  const lineUnit = String(lineProduct?.unitOfMeasure || item.unitOfMeasure || 'PCS').toUpperCase()
                  const isAreaUnit = lineUnit === 'SQFT' || lineUnit === 'SQM' || lineUnit === 'BOX' || lineUnit === 'SLAB'
                  const hasConversion = line.boxes !== undefined && line.area !== undefined
                  const selectedImage = getItemDisplayImage(item)

                  return (
                    <div key={index} className="bg-surface border border-border rounded-xl p-3 space-y-2">
                      <div className="grid grid-cols-12 gap-2">
                        <div className="col-span-12 md:col-span-6">
                          <label className="block text-[11px] text-muted mb-1">Inventory Product (optional)</label>
                          <select
                            value={item.isCustom ? 'custom' : item.productId}
                            onChange={e => handleProductSelect(index, e.target.value)}
                            className="w-full px-3 py-2.5 md:py-2 rounded-lg text-sm md:text-xs"
                          >
                            <option value="">Select from inventory</option>
                            <option value="custom">Custom item (manual)</option>
                            {products.map(product => (
                              <option key={product.id} value={product.id}>
                                {product.name} ({product.sku}) - Stock: {product.stock}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-12 md:col-span-6">
                          <label className="block text-[11px] text-muted mb-1">Item Name *</label>
                          <input
                            value={item.name}
                            onChange={e => updateItem(index, { name: e.target.value })}
                            className="w-full px-3 py-2.5 md:py-2 rounded-lg text-sm md:text-xs"
                            required
                          />
                        </div>
                        <div className="col-span-12">
                          <label className="block text-[11px] text-muted mb-1">Description</label>
                          <textarea
                            rows={2}
                            value={item.description}
                            onChange={e => updateItem(index, { description: e.target.value })}
                            className="w-full px-3 py-2 rounded-lg text-xs resize-none"
                          />
                        </div>
                        <div className="col-span-6 md:col-span-2">
                          <label className="block text-[11px] text-muted mb-1">Qty</label>
                          <input
                            type="number"
                            min="1"
                            value={item.quantity}
                            onChange={e => updateItem(index, { quantity: parseInt(e.target.value || '1') })}
                            className="w-full px-3 py-2.5 md:px-2 md:py-2 rounded-lg text-sm md:text-xs"
                          />
                        </div>
                        <div className="col-span-6 md:col-span-2">
                          <label className="block text-[11px] text-muted mb-1">UOM</label>
                          <select value={lineUnit} onChange={e => updateItem(index, { unitOfMeasure: e.target.value })} className="w-full px-2 py-2.5 rounded-lg text-xs">
                            <option value="PCS">PCS</option><option value="BOX">BOX</option><option value="SQFT">SQFT</option><option value="SQM">SQM</option><option value="SLAB">SLAB</option><option value="RFT">RFT</option>
                          </select>
                        </div>
                        {isAreaUnit && (
                          <div className="col-span-6 md:col-span-2">
                            <label className="block text-[11px] text-muted mb-1">Area (sq.ft)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.area ?? 0}
                              onChange={e => updateItem(index, { area: parseFloat(e.target.value || '0') })}
                              className="w-full px-3 py-2.5 md:px-2 md:py-2 rounded-lg text-sm md:text-xs"
                            />
                          </div>
                        )}
                        <div className="col-span-6 md:col-span-3">
                          <label className="block text-[11px] text-muted mb-1">{lineUnit === 'SQFT' ? 'Rate / sq.ft' : 'Rate'}</label>
                          <input
                            type="number"
                            min="0"
                            value={item.rate}
                            onChange={e => updateItem(index, { rate: parseInt(e.target.value || '0') })}
                            className="w-full px-3 py-2.5 md:px-2 md:py-2 rounded-lg text-sm md:text-xs"
                          />
                        </div>
                        <div className="col-span-6 md:col-span-3">
                          <label className="block text-[11px] text-muted mb-1">Amount</label>
                          <div className="w-full px-3 py-2.5 md:px-2 md:py-2 rounded-lg text-sm md:text-xs bg-surface-hover border border-border text-right font-medium">
                            {formatCurrency(amount)}
                          </div>
                        </div>
                        {hasConversion && (
                          <div className="col-span-12">
                            <p className="text-[11px] text-accent">
                              Entered area: <span className="font-semibold">{line.area} sq.ft</span>
                              {' → '}
                              <span className="font-semibold">{line.boxes} box{line.boxes === 1 ? '' : 'es'}</span>
                              {' '}(rounded up to whole boxes)
                            </p>
                          </div>
                        )}
                        <div className="col-span-12 md:col-span-4">
                          <label className="block text-[11px] text-muted mb-1">Reference Image</label>
                          <div className="flex items-center gap-2">
                            <label className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-border text-xs text-muted hover:text-accent hover:border-accent/40 cursor-pointer">
                              <Upload className="w-3.5 h-3.5" />
                              {uploadingIndex === index ? 'Uploading...' : 'Upload'}
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={e => handleReferenceImageUpload(index, e.target.files)}
                                disabled={uploadingIndex === index}
                              />
                            </label>
                            {item.referenceImage && (
                              <Image
                                src={item.referenceImage}
                                alt="reference"
                                width={48}
                                height={40}
                                unoptimized
                                className="w-12 h-10 rounded border border-border object-cover"
                              />
                            )}
                          </div>

                          <label className="block text-[11px] text-muted mt-2 mb-1">Image Used In Quotation</label>
                          <select
                            value={item.imageSource || 'REFERENCE'}
                            onChange={e => updateItem(index, { imageSource: e.target.value })}
                            className="w-full px-2 py-2 rounded-lg text-xs"
                          >
                            <option value="PRODUCT" disabled={!item.productImage}>Product Image</option>
                            <option value="REFERENCE">Reference Upload</option>
                          </select>

                          <div className="mt-2">
                            {selectedImage ? (
                              <Image
                                src={selectedImage}
                                alt="selected item"
                                width={120}
                                height={80}
                                unoptimized
                                className="w-[120px] h-20 rounded border border-border object-cover"
                              />
                            ) : (
                              <p className="text-[11px] text-muted">No image selected</p>
                            )}
                          </div>
                        </div>
                      </div>

                      {form.items.length > 1 && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
                          >
                            <X className="w-3.5 h-3.5" /> Remove
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="space-y-3 rounded-xl border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">Charges & Tax</h3>
                  <p className="text-[11px] text-muted">Installation charge is calculated automatically from subtotal.</p>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-5 gap-3">
                  <div className="xl:col-span-2 min-w-0 rounded-xl border border-border/70 bg-background/40 p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="block text-xs font-medium text-muted">Installation %</label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setForm(prev => ({ ...prev, installationPercent: 5 }))}
                          className="px-2 py-1 rounded-lg border border-border text-[11px] font-medium text-muted hover:text-accent hover:border-accent/40 whitespace-nowrap"
                        >
                          Set 5%
                        </button>
                        <button
                          type="button"
                          onClick={() => setForm(prev => ({ ...prev, installationPercent: 0 }))}
                          className="px-2 py-1 rounded-lg border border-border text-[11px] font-medium text-muted hover:text-red-600 hover:border-red-300 whitespace-nowrap"
                        >
                          Set 0%
                        </button>
                      </div>
                    </div>

                    <div className="relative max-w-[180px]">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={form.installationPercent}
                        onChange={e => setForm(prev => ({ ...prev, installationPercent: parseFloat(e.target.value || '0') }))}
                        className="w-full px-3 pr-8 py-2.5 rounded-xl text-sm"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
                    </div>

                    <div className="pt-2 border-t border-border/60 space-y-2">
                      <label className="block text-xs font-medium text-muted">Discount</label>
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={form.discountType}
                          onChange={e => setForm(prev => ({ ...prev, discountType: e.target.value }))}
                          className="w-full px-2 py-2 rounded-lg text-xs"
                        >
                          <option value="PERCENT">Percent (%)</option>
                          <option value="FLAT">Amount (Rs.)</option>
                        </select>
                        <div className="relative">
                          <input
                            type="number"
                            min="0"
                            max={form.discountType === 'PERCENT' ? '100' : undefined}
                            step="0.01"
                            value={form.discountValue}
                            onChange={e => setForm(prev => ({ ...prev, discountValue: parseFloat(e.target.value || '0') }))}
                            className="w-full px-2 pr-8 py-2 rounded-lg text-xs"
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted">
                            {form.discountType === 'PERCENT' ? '%' : 'Rs'}
                          </span>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted">
                        Discount applied: <span className="font-semibold text-foreground">{formatCurrency(computed.discountAmount)}</span>
                      </p>
                    </div>

                    <p className="text-[11px] text-muted">
                      Current charge: <span className="font-semibold text-foreground">{formatCurrency(computed.installationCharge)}</span>
                    </p>
                  </div>

                  <div className="xl:col-span-3 min-w-0 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="min-w-0">
                      <label className="block text-xs font-medium text-muted mb-1.5">Freight</label>
                      <input
                        type="number"
                        min="0"
                        value={form.freightCharge}
                        onChange={e => setForm(prev => ({ ...prev, freightCharge: parseInt(e.target.value || '0') }))}
                        className="w-full px-3 py-2.5 rounded-xl text-sm"
                      />
                    </div>

                    <div className="min-w-0">
                      <label className="block text-xs font-medium text-muted mb-1.5">Loading</label>
                      <input
                        type="number"
                        min="0"
                        value={form.loadingCharge}
                        onChange={e => setForm(prev => ({ ...prev, loadingCharge: parseInt(e.target.value || '0') }))}
                        className="w-full px-3 py-2.5 rounded-xl text-sm"
                      />
                    </div>

                    <div className="min-w-0">
                      <label className="block text-xs font-medium text-muted mb-1.5">GST %</label>
                      <div className="relative">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={form.gstPercent}
                          onChange={e => setForm(prev => ({ ...prev, gstPercent: parseFloat(e.target.value || '0') }))}
                          className="w-full px-3 pr-8 py-2.5 rounded-xl text-sm"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Terms & Conditions (one per line)</label>
                <textarea
                  rows={6}
                  value={form.termsText}
                  onChange={e => setForm(prev => ({ ...prev, termsText: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl text-xs"
                />
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Live Preview (sample-matching format)</h3>
              <div className="border border-border rounded-xl p-2 bg-surface max-h-[72vh] overflow-auto">
                <QuotationSheetPreview quotation={previewQuotation} storeSettings={storeSettings} />
              </div>
            </div>
          </div>

          <div className="sticky bottom-0 z-10 -mx-5 md:mx-0 px-5 md:px-0 -mb-4 md:mb-0 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-0 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80 md:bg-transparent md:backdrop-blur-0 border-t border-border pt-3 md:pt-4">
            {/* Mobile totals breakdown */}
            <div className="md:hidden mb-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted">Subtotal</span>
                <span className="text-foreground font-medium">{formatCurrency(computed.subtotal)}</span>
              </div>
              {computed.discountAmount > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted">Discount</span>
                  <span className="text-danger font-medium">-{formatCurrency(computed.discountAmount)}</span>
                </div>
              )}
              {computed.installationCharge > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted">Installation</span>
                  <span className="text-foreground font-medium">{formatCurrency(computed.installationCharge)}</span>
                </div>
              )}
              {computed.freight > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted">Freight</span>
                  <span className="text-foreground font-medium">{formatCurrency(computed.freight)}</span>
                </div>
              )}
              {computed.loading > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted">Loading</span>
                  <span className="text-foreground font-medium">{formatCurrency(computed.loading)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted">GST ({Number(form.gstPercent) || 0}%)</span>
                <span className="text-foreground font-medium">{formatCurrency(computed.gstAmount)}</span>
              </div>
              <div className="flex items-center justify-between pt-1.5 border-t border-border">
                <span className="text-foreground font-semibold">Grand Total</span>
                <span className="text-accent font-bold text-base">{formatCurrency(previewQuotation.grandTotal)}</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <div className="hidden md:block text-sm text-muted">
                Final Amount: <span className="font-semibold text-foreground">{formatCurrency(previewQuotation.grandTotal)}</span>
              </div>
              <div className="flex items-center gap-2 w-full md:w-auto">
                <button
                  type="button"
                  onClick={() => setShowGenerator(false)}
                  className="touch-target px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="touch-target flex-1 md:flex-none px-5 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                >
                  {saving ? 'Saving...' : isEditMode ? 'Update Quotation' : 'Save Quotation'}
                </button>
              </div>
            </div>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!selectedQuotation} onClose={() => setSelectedQuotation(null)} title="Quotation Preview" size="xl">
        {selectedQuotation && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <p className="text-sm text-muted">Quotation</p>
                <p className="font-mono text-accent font-semibold">{selectedQuotation.id}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 rounded-full text-xs border ${statusColors[selectedQuotation.statusKey]}`}>
                  {selectedQuotation.status}
                </span>
                <button
                  onClick={() => handleShareQuotationWhatsApp(selectedQuotation)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-500/20 text-xs text-emerald-700 hover:bg-emerald-500/10"
                >
                  <MessageSquare className="w-3.5 h-3.5" /> WhatsApp
                </button>
                <button
                  onClick={() => handleShareQuotationEmail(selectedQuotation)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-500/20 text-xs text-blue-700 hover:bg-blue-500/10"
                >
                  <Mail className="w-3.5 h-3.5" /> Email
                </button>
                <button
                  onClick={() => openEditQuotationModal(selectedQuotation)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs text-muted hover:text-accent hover:border-accent/40"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
                <button
                  onClick={() => handlePrint(selectedQuotation)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs text-muted hover:text-accent hover:border-accent/40"
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button
                  onClick={() => handleDownload(selectedQuotation)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-xs text-muted hover:text-accent hover:border-accent/40"
                >
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
                <button
                  onClick={() => handleMoveToDraft(selectedQuotation)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-500/20 text-xs text-red-700 hover:bg-red-500/10"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Move to Draft
                </button>
                {selectedQuotation.statusKey !== 'REJECTED' && (
                  <button
                    onClick={() => handleConfirmSalesOrder(selectedQuotation)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-xs hover:bg-accent-hover"
                  >
                    <ClipboardList className="w-3.5 h-3.5" /> {selectedQuotation.salesOrder ? `Open ${selectedQuotation.salesOrder.displayId}` : 'Confirm → Sales Order'}
                  </button>
                )}
                {(selectedQuotation.statusKey === 'SENT' || selectedQuotation.statusKey === 'APPROVED') && !selectedQuotation.salesOrder && (
                  <button
                    onClick={() => handleConvertToInvoice(selectedQuotation)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent text-white text-xs hover:bg-accent-hover"
                  >
                    <FileText className="w-3.5 h-3.5" /> Create Invoice
                  </button>
                )}
              </div>
            </div>
            <QuotationSheetPreview quotation={selectedQuotation} storeSettings={storeSettings} />
          </div>
        )}
      </Modal>
    </div>
  )
}
