'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Plus, Factory, Layers, PlayCircle, CheckCircle, Package,
  Eye, AlertTriangle, Pause, XCircle, Wrench,
  TrendingUp, BarChart3, Search, Trash2,
  ChevronDown, ChevronUp, RefreshCw,
  ShieldCheck, FlameKindling, Star, Cpu, Activity,
  Download, Edit2, Save, X, FileText, BookTemplate,
  Clock, DollarSign, Zap, Copy, Upload, Check,
} from 'lucide-react'
import {
  getBOMs, createBOM, toggleBOMStatus, deleteBOM,
  addBOMItem, updateBOMItem, removeBOMItem,
  addBOMStep, updateBOMStep, removeBOMStep,
  exportBOM,
  getBomTemplates, createBomTemplate, deleteBomTemplate,
  getWorkCenters, createWorkCenter, updateWorkCenterStatus, deleteWorkCenter,
  getProductionOrders, getAssignableStaff, createProductionOrder, startProduction,
  holdProduction, cancelProductionOrder, deleteProductionOrder,
  completeProduction, recordQualityCheck,
  getMRPAnalysis, getManufacturingStats, updateProductionStep, orderMrpShortages,
  getManufacturingCustomOrders, getScrapInventory, updateScrapInventoryStatus, getCustomOrderInventory,
} from '@/app/actions/manufacturing'
import { getStoneLots, createStoneOffcut } from '@/app/actions/stone-inventory'
import { getProducts, createProduct, deleteRawMaterial, updateProduct, updateStock, bulkImportRawMaterials } from '@/app/actions/products'
import Modal from '@/components/Modal'
import * as XLSX from 'xlsx'
import { getActiveVertical } from '@/lib/brand'

// ─── Constants ────────────────────────────────────────
const PRIORITY_COLORS = {
  LOW: 'bg-gray-500/10 text-gray-400 border border-gray-500/20',
  MEDIUM: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
  HIGH: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  URGENT: 'bg-red-500/10 text-red-400 border border-red-500/20',
}

const STATUS_COLORS = {
  PLANNED: 'bg-gray-500/10 text-gray-400',
  IN_PROGRESS: 'bg-blue-500/10 text-blue-400',
  COMPLETED: 'bg-emerald-500/10 text-emerald-400',
  CANCELLED: 'bg-red-500/10 text-red-400',
  ON_HOLD: 'bg-amber-500/10 text-amber-400',
}

const QUALITY_COLORS = {
  PENDING: 'bg-gray-500/10 text-gray-400',
  PASSED: 'bg-emerald-500/10 text-emerald-400',
  FAILED: 'bg-red-500/10 text-red-400',
  PARTIAL: 'bg-amber-500/10 text-amber-400',
}

const IS_TGM = getActiveVertical() === 'tiles'
const WC_TYPES = IS_TGM
  ? ['Gangsaw / Block-Cutting', 'CNC / Waterjet Cutting', 'Edge Profiling', 'Polishing', 'Resin & Epoxy Filling', 'Line Polishing / Calibration', 'Template & Site Measurement', 'QC / Grading', 'Packing & Crating', 'General']
  : ['Carpentry', 'Polishing', 'Upholstery', 'Finishing', 'Assembly', 'QC', 'Packaging', 'General']
const INP = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50'
const SEL = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none'

const RM_COLUMN_ALIASES = {
  name: ['name', 'product name', 'material name', 'raw material', 'raw material name'],
  brand: ['brand', 'product brand', 'material brand'],
  sku: ['sku', 'sku code', 'material code'],
  costPrice: ['cost price', 'cost', 'cost price per unit', 'purchase price'],
  instock: ['in stock', 'instock', 'stock quantity', 'current stock quantity', 'opening stock quantity', 'quantity', 'stock'],
  size: ['size', 'measure per quantity', 'unit size', 'uom conversion', 'conversion factor', 'size per qty'],
  unitOfMeasure: ['unit of measure', 'uom', 'unit'],
  reorderLevel: ['min stock alert', 'reorder level', 'minimum stock', 'min stock'],
  description: ['description', 'notes', 'remarks'],
  image: ['image', 'image url', 'photo', 'image link'],
}

function mapImportColumns(headers) {
  const map = {}
  headers.forEach((header, index) => {
    const normalized = String(header || '').toLowerCase().trim()
    Object.entries(RM_COLUMN_ALIASES).forEach(([field, aliases]) => {
      if (!(field in map) && aliases.includes(normalized)) {
        map[field] = index
      }
    })
  })
  return map
}

// ─── CSV Export Helper ────────────────────────────────
import { downloadBOMCSV, downloadBOMPDF } from '@/lib/manufacturing/downloads'
import { confirmDialog } from '@/components/AlertToastProvider';
// ─── Main Page ────────────────────────────────────────
export default function ManufacturingPage() {
  const [tab, setTab] = useState('production')
  const [loading, setLoading] = useState(true)

  // Data
  const [boms, setBoms] = useState([])
  const [orders, setOrders] = useState([])
  const [products, setProducts] = useState([])
  const [workCenters, setWorkCenters] = useState([])
  const [staffOptions, setStaffOptions] = useState([])
  const [stats, setStats] = useState(null)
  const [templates, setTemplates] = useState([])
  const [customOrders, setCustomOrders] = useState([])
  const [scrapInventory, setScrapInventory] = useState([])
  const [customInventory, setCustomInventory] = useState([])

  // Modals
  const [showBOMModal, setShowBOMModal] = useState(false)
  const [showProdModal, setShowProdModal] = useState(false)
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [showDetailModal, setShowDetailModal] = useState(false)
  const [showWCModal, setShowWCModal] = useState(false)
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [showQCModal, setShowQCModal] = useState(false)
  const [showDeleteProdModal, setShowDeleteProdModal] = useState(false)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [showOffcutModal, setShowOffcutModal] = useState(false)
  const [offcutLots, setOffcutLots] = useState([])
  const [offcutForm, setOffcutForm] = useState({ sourceSlabId: '', lengthInches: '', widthInches: '', shadeCode: '', salePrice: '', notes: '' })
  const [offcutSaving, setOffcutSaving] = useState(false)

  // Selected items
  const [selectedOrder, setSelectedOrder] = useState(null)
  const [cancelTarget, setCancelTarget] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [qcTarget, setQcTarget] = useState(null)
  const [deleteProdTarget, setDeleteProdTarget] = useState(null)

  // MRP
  const [mrpBomId, setMrpBomId] = useState('')
  const [mrpQty, setMrpQty] = useState(1)
  const [mrpResult, setMrpResult] = useState(null)
  const [mrpLoading, setMrpLoading] = useState(false)

  // Search/filter
  const [orderSearch, setOrderSearch] = useState('')
  const [orderStatusFilter, setOrderStatusFilter] = useState('ALL')
  const [orderPriorityFilter, setOrderPriorityFilter] = useState('ALL')

  const [submitting, setSubmitting] = useState(false)

  // Raw material form
  const [rmForm, setRmForm] = useState({ name: '', size: '', brand: '', sku: '', instock: '', costPrice: '', stockQuantity: 0, unitSize: 1, unitOfMeasure: 'PCS', reorderLevel: 5, description: '' })
  const [rmImages, setRmImages] = useState([])
  const [rmSearch, setRmSearch] = useState('')
  const [editingRmId, setEditingRmId] = useState(null)
  const [rmEditForm, setRmEditForm] = useState({})
  const [rmEditImages, setRmEditImages] = useState([])
  const [showRmImportModal, setShowRmImportModal] = useState(false)
  const [rmImportRows, setRmImportRows] = useState([])
  const [rmImportHeaders, setRmImportHeaders] = useState([])
  const [rmImportColMap, setRmImportColMap] = useState({})
  const [rmImportLoading, setRmImportLoading] = useState(false)
  const [rmImportError, setRmImportError] = useState('')
  const [rmImportResult, setRmImportResult] = useState(null)
  const [selectedRmIds, setSelectedRmIds] = useState(new Set())
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  // BOM form
  const [bomForm, setBomForm] = useState({
    name: '', finishedProductId: '', version: '1.0', estimatedDays: '', notes: '',
    items: [{ rawMaterialId: '', quantity: 1, unitOfMeasure: 'PCS', wastagePercent: 0, unitCost: 0, notes: '' }],
    steps: [],
    templateId: '',
  })
  const [bomItemSearch, setBomItemSearch] = useState({})
  const [activeBomItemPicker, setActiveBomItemPicker] = useState(null)
  const [finishedProductSearch, setFinishedProductSearch] = useState('')
  const [showFinishedProductPicker, setShowFinishedProductPicker] = useState(false)

  // Production form
  const [prodForm, setProdForm] = useState({
    bomId: '', plannedQty: 1, priority: 'MEDIUM', dueDate: '', startDate: '',
    workCenterId: '', assignedStaffId: '', customOrderId: '', notes: '',
  })

  // Complete form
  const [completeForm, setCompleteForm] = useState({
    productionOrderId: 0, actualQty: 0, totalLabourCost: 0, overheadCost: 0, machineCost: 0,
    scrapQty: 0, scrapReason: '', qualityStatus: 'PASSED', qualityNotes: '', notes: '',
    consumptions: [],
    stepActuals: [],
    stoneOffcuts: [],
  })

  // Work center form
  const [wcForm, setWcForm] = useState({ name: '', type: 'General', description: '', capacity: 1, notes: '' })

  // QC form
  const [qcForm, setQcForm] = useState({ qualityStatus: 'PASSED', qualityNotes: '', scrapQty: 0, scrapReason: '' })

  // Template form
  const [templateForm, setTemplateForm] = useState({ name: '', description: '', steps: [] })

  const finishedProducts = useMemo(() => {
    return products.filter(p => p.category !== 'Raw Material')
  }, [products])

  const selectedFinishedProduct = useMemo(() => {
    return finishedProducts.find(p => String(p.id) === String(bomForm.finishedProductId)) || null
  }, [finishedProducts, bomForm.finishedProductId])

  const filteredFinishedProducts = useMemo(() => {
    const search = finishedProductSearch.toLowerCase().trim()
    if (!search) return finishedProducts.slice(0, 30)
    return finishedProducts
      .filter(p => p.name.toLowerCase().includes(search) || (p.sku || '').toLowerCase().includes(search))
      .slice(0, 30)
  }, [finishedProducts, finishedProductSearch])

  const rawMaterialOptions = useMemo(() => {
    return products.filter(p => p.category === 'Raw Material')
  }, [products])

  const getPrimaryImage = useCallback((image) => {
    if (!image) return null
    const first = String(image).split(',')[0]?.trim()
    return first && first.includes('/') ? first : null
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    const [bomRes, ordRes, prodRes, wcRes, statsRes, tmplRes, staffRes, customRes, scrapRes, customInvRes] = await Promise.all([
      getBOMs(), getProductionOrders(), getProducts(),
      getWorkCenters(), getManufacturingStats(), getBomTemplates(), getAssignableStaff(),
      getManufacturingCustomOrders(), getScrapInventory(), getCustomOrderInventory(),
    ])
    if (bomRes.success) setBoms(bomRes.data)
    if (ordRes.success) setOrders(ordRes.data)
    if (prodRes.success) setProducts(prodRes.data)
    if (wcRes.success) setWorkCenters(wcRes.data)
    if (statsRes.success) setStats(statsRes.data)
    if (tmplRes.success) setTemplates(tmplRes.data)
    if (staffRes.success) setStaffOptions(staffRes.data)
    if (customRes.success) setCustomOrders(customRes.data)
    if (scrapRes.success) setScrapInventory(scrapRes.data)
    if (customInvRes.success) setCustomInventory(customInvRes.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    // Initial manufacturing dashboard bootstrap fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData()
  }, [loadData])

  // Auto-refresh production data every 30s so admin sees staff progress updates
  useEffect(() => {
    const interval = setInterval(async () => {
      const ordRes = await getProductionOrders()
      if (ordRes.success) setOrders(ordRes.data)
      const statsRes = await getManufacturingStats()
      if (statsRes.success) setStats(statsRes.data)
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  // Filtered orders
  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      const matchSearch = !orderSearch ||
        o.displayId.toLowerCase().includes(orderSearch.toLowerCase()) ||
        o.finishedProduct?.name.toLowerCase().includes(orderSearch.toLowerCase()) ||
        o.bom?.name.toLowerCase().includes(orderSearch.toLowerCase())
      const matchStatus = orderStatusFilter === 'ALL' || o.status === orderStatusFilter
      const matchPriority = orderPriorityFilter === 'ALL' || o.priority === orderPriorityFilter
      return matchSearch && matchStatus && matchPriority
    })
  }, [orders, orderSearch, orderStatusFilter, orderPriorityFilter])

  // ─── Apply template to BOM steps ─────────────────────
  const applyTemplate = (templateId) => {
    const t = templates.find(t => t.id === Number(templateId))
    if (!t) return
    const steps = (t.steps || []).map((s, idx) => ({
      operationName: s.operationName || '',
      workCenterId: s.workCenterId || '',
      durationMins: s.durationMins || 60,
      labourRatePerHour: s.labourRatePerHour || 0,
      machineCostPerUnit: s.machineCostPerUnit || 0,
      notes: s.notes || '',
    }))
    setBomForm(f => ({ ...f, steps, templateId }))
  }

  // ─── Handlers ─────────────────────────────────────
  const handleCreateBOM = async () => {
    setSubmitting(true)
    const items = bomForm.items.filter(i => i.rawMaterialId).map(i => ({
      rawMaterialId: Number(i.rawMaterialId), quantity: Number(i.quantity),
      unitOfMeasure: i.unitOfMeasure, wastagePercent: Number(i.wastagePercent),
      unitCost: Number(i.unitCost) || 0,
      notes: i.notes || undefined,
    }))
    const steps = bomForm.steps.filter(s => s.operationName).map((s, idx) => ({
      stepNumber: idx + 1, operationName: s.operationName,
      workCenterId: s.workCenterId ? Number(s.workCenterId) : undefined,
      durationMins: Number(s.durationMins) || 60,
      labourRatePerHour: Number(s.labourRatePerHour) || 0,
      machineCostPerUnit: Number(s.machineCostPerUnit) || 0,
      notes: s.notes || undefined,
    }))
    const res = await createBOM({
      name: bomForm.name, finishedProductId: Number(bomForm.finishedProductId),
      version: bomForm.version, estimatedDays: bomForm.estimatedDays ? Number(bomForm.estimatedDays) : undefined,
      notes: bomForm.notes || undefined, items,
      steps: steps.length > 0 ? steps : undefined,
    })
    if (res.success) {
      setShowBOMModal(false)
      setBomForm({ name: '', finishedProductId: '', version: '1.0', estimatedDays: '', notes: '', items: [{ rawMaterialId: '', quantity: 1, unitOfMeasure: 'PCS', wastagePercent: 0, unitCost: 0, notes: '' }], steps: [], templateId: '' })
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  const handleCreateProd = async () => {
    setSubmitting(true)
    const res = await createProductionOrder({
      bomId: Number(prodForm.bomId), plannedQty: Number(prodForm.plannedQty),
      priority: prodForm.priority, dueDate: prodForm.dueDate || undefined,
      startDate: prodForm.startDate || undefined,
      workCenterId: prodForm.workCenterId ? Number(prodForm.workCenterId) : undefined,
      assignedStaffId: prodForm.assignedStaffId ? Number(prodForm.assignedStaffId) : undefined,
      customOrderId: prodForm.customOrderId ? Number(prodForm.customOrderId) : undefined,
      notes: prodForm.notes || undefined,
    })
    if (res.success) {
      setShowProdModal(false)
      setProdForm({ bomId: '', plannedQty: 1, priority: 'MEDIUM', dueDate: '', startDate: '', workCenterId: '', assignedStaffId: '', customOrderId: '', notes: '' })
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  const handleStartProd = async (id) => {
    const res = await startProduction(id)
    if (res.success) loadData()
    else alert(res.error)
  }

  const handleHoldProd = async (id) => {
    const res = await holdProduction(id)
    if (res.success) loadData()
    else alert(res.error)
  }

  const handleCancelProd = async () => {
    if (!cancelTarget || !cancelReason.trim()) return
    setSubmitting(true)
    const res = await cancelProductionOrder(cancelTarget.id, cancelReason)
    if (res.success) {
      setShowCancelModal(false)
      setCancelReason('')
      setCancelTarget(null)
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  const handleDeleteProd = async () => {
    if (!deleteProdTarget) return
    setSubmitting(true)
    const res = await deleteProductionOrder(deleteProdTarget.id)
    if (res.success) {
      setShowDeleteProdModal(false)
      setDeleteProdTarget(null)
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  const openCompleteModal = (order) => {
    const stepActuals = order.productionSteps?.map(s => ({
      stepId: s.id,
      stepNumber: s.stepNumber,
      operationName: s.operationName,
      plannedMins: s.plannedMins || 0,
      labourRatePerHour: s.labourRatePerHour || 0,
      actualMins: s.actualMins || s.plannedMins || 0,
    })) || []
    const suggestedLabourCost = stepActuals.reduce((sum, s) => sum + (Number(s.actualMins || 0) / 60) * Number(s.labourRatePerHour || 0), 0)
    setCompleteForm({
      productionOrderId: order.id,
      actualQty: order.plannedQty,
      totalLabourCost: Math.round(suggestedLabourCost),
      overheadCost: 0,
      machineCost: 0,
      scrapQty: order.scrapQty || 0, scrapReason: order.scrapReason || '',
      qualityStatus: order.qualityStatus && order.qualityStatus !== 'PENDING' ? order.qualityStatus : 'PASSED',
      qualityNotes: order.qualityNotes || '', notes: '',
      consumptions: order.consumptions?.map(c => ({ rawMaterialId: c.rawMaterialId, plannedQty: c.plannedQty, issuedQty: c.plannedQty, actualQty: c.plannedQty, scrapQty: 0, scrapReason: '' })) || [],
      stepActuals,
      stoneOffcuts: [],
    })
    setSelectedOrder(order)
    setShowCompleteModal(true)
  }

  const handleCompleteProd = async () => {
    const incompleteOffcut = completeForm.stoneOffcuts.some(offcut => !offcut.sourceSlabId || !offcut.lengthInches || !offcut.widthInches)
    if (incompleteOffcut) {
      alert('Complete the source slab and dimensions for every stone offcut, or remove the empty row.')
      return
    }
    setSubmitting(true)
    const res = await completeProduction({
      ...completeForm,
      actualQty: Number(completeForm.actualQty),
      totalLabourCost: Number(completeForm.totalLabourCost),
      overheadCost: Number(completeForm.overheadCost),
      machineCost: Number(completeForm.machineCost),
      scrapQty: Number(completeForm.scrapQty),
      consumptions: completeForm.consumptions.map(c => ({
        rawMaterialId: c.rawMaterialId,
        issuedQty: Number(c.issuedQty) || 0,
        actualQty: Number(c.actualQty),
        scrapQty: Number(c.scrapQty) || 0,
        scrapReason: c.scrapReason || undefined,
      })),
      stepActuals: completeForm.stepActuals.map(s => ({ stepId: s.stepId, actualMins: Number(s.actualMins) || 0 })),
      stoneOffcuts: completeForm.stoneOffcuts.map(offcut => ({
        sourceSlabId: Number(offcut.sourceSlabId),
        lengthInches: Number(offcut.lengthInches),
        widthInches: Number(offcut.widthInches),
        shadeCode: offcut.shadeCode || undefined,
        photo: offcut.photo || undefined,
        salePrice: offcut.salePrice === '' ? undefined : Number(offcut.salePrice),
        notes: offcut.notes || undefined,
      })),
    })
    if (res.success) { setShowCompleteModal(false); loadData() }
    else alert(res.error)
    setSubmitting(false)
  }

  const handleCreateWC = async () => {
    setSubmitting(true)
    const res = await createWorkCenter({ ...wcForm, capacity: Number(wcForm.capacity) })
    if (res.success) {
      setShowWCModal(false)
      setWcForm({ name: '', type: 'General', description: '', capacity: 1, notes: '' })
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  const handleRunMRP = async () => {
    if (!mrpBomId) return
    setMrpLoading(true)
    const res = await getMRPAnalysis(Number(mrpBomId), Number(mrpQty))
    if (res.success) setMrpResult(res.data)
    else alert(res.error)
    setMrpLoading(false)
  }

  // Draft POs for components still short after incoming purchases.
  const handleOrderShortages = async () => {
    setMrpLoading(true)
    const res = await orderMrpShortages(Number(mrpBomId), Number(mrpQty))
    setMrpLoading(false)
    if (!res.success) return alert(res.error)
    const pos = res.data.pos.map(po => po.displayId).join(', ')
    alert(`Draft PO ${pos} ready for approval in Purchases.${res.data.noVendor.length ? ` No vendor price for: ${res.data.noVendor.join(', ')}.` : ''}`)
    handleRunMRP()
  }

  const handleQCSubmit = async () => {
    if (!qcTarget) return
    setSubmitting(true)
    const res = await recordQualityCheck({ productionOrderId: qcTarget.id, ...qcForm, scrapQty: Number(qcForm.scrapQty) })
    if (res.success) { setShowQCModal(false); setQcTarget(null); loadData() }
    else alert(res.error)
    setSubmitting(false)
  }

  const handleScrapStatus = async (id, status) => {
    const label = status === 'DISPOSED' ? 'dispose' : 'mark as used'
    if (!await confirmDialog(`Are you sure you want to ${label} this reusable offcut?`)) return
    const res = await updateScrapInventoryStatus({ id, status })
    if (res.success) loadData()
    else alert(res.error)
  }

  const openOffcutModal = async () => {
    const res = await getStoneLots()
    if (res.success) setOffcutLots(res.data)
    setShowOffcutModal(true)
  }

  const handleCreateOffcut = async () => {
    if (!offcutForm.sourceSlabId || !offcutForm.lengthInches || !offcutForm.widthInches) return
    setOffcutSaving(true)
    const res = await createStoneOffcut({
      sourceSlabId: Number(offcutForm.sourceSlabId),
      lengthInches: Number(offcutForm.lengthInches),
      widthInches: Number(offcutForm.widthInches),
      shadeCode: offcutForm.shadeCode || undefined,
      salePrice: offcutForm.salePrice ? Number(offcutForm.salePrice) : undefined,
      notes: offcutForm.notes || undefined,
    })
    if (res.success) {
      setShowOffcutModal(false)
      setOffcutForm({ sourceSlabId: '', lengthInches: '', widthInches: '', shadeCode: '', salePrice: '', notes: '' })
      loadData()
    } else alert(res.error)
    setOffcutSaving(false)
  }

  const handleCreateTemplate = async () => {
    setSubmitting(true)
    const steps = templateForm.steps.filter(s => s.operationName).map((s, idx) => ({
      stepNumber: idx + 1,
      operationName: s.operationName,
      workCenterId: s.workCenterId ? Number(s.workCenterId) : undefined,
      durationMins: Number(s.durationMins) || 60,
      labourRatePerHour: Number(s.labourRatePerHour) || 0,
      machineCostPerUnit: Number(s.machineCostPerUnit) || 0,
      notes: s.notes || undefined,
    }))
    const res = await createBomTemplate({ name: templateForm.name, description: templateForm.description || undefined, steps })
    if (res.success) {
      setShowTemplateModal(false)
      setTemplateForm({ name: '', description: '', steps: [] })
      loadData()
    } else alert(res.error)
    setSubmitting(false)
  }

  // ─── Raw Material Handlers ──────────────────
  const generateRMSku = () => {
    const existing = products.filter(p => p.category === 'Raw Material')
    const nextNum = existing.length + 1
    return `RM-${String(nextNum).padStart(3, '0')}`
  }

  const compressImage = async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          const max_size = 800; // Small size

          if (width > height) {
            if (width > max_size) {
              height *= max_size / width;
              width = max_size;
            }
          } else {
            if (height > max_size) {
              width *= max_size / height;
              height = max_size;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob((blob) => {
            const compressedFile = new File([blob], file.name, {
              type: 'image/jpeg',
              lastModified: Date.now(),
            });
            resolve(compressedFile);
          }, 'image/jpeg', 0.8);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  };

  const uploadProductImages = async (files) => {
    if (!files || files.length === 0) return ''
    const formData = new FormData()
    formData.set('folder', 'products')

    // Compress each file before upload
    const compressedFiles = await Promise.all(
      Array.from(files).map(file => compressImage(file))
    );

    compressedFiles.forEach(file => formData.append('files', file))
    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData })
    const uploadData = await uploadRes.json()
    if (!uploadRes.ok || !uploadData?.success) {
      throw new Error(uploadData?.error || 'Image upload failed')
    }
    return Array.isArray(uploadData.urls) ? uploadData.urls.join(',') : ''
  }

  const downloadRawMaterialTemplate = () => {
    const headers = ['PRODUCT NAME', 'SIZE', 'brand', 'SKU', 'Instock', 'Cost price']
    const example = ['OTTER', '1 inch (square)', '', 'RM-001', '1', '']
    const csv = [headers.join(','), example.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'raw_materials_import_template.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleRmImportFileUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setRmImportError('')
    setRmImportResult(null)
    setRmImportRows([])
    setRmImportHeaders([])

    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const workbook = XLSX.read(data, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

      if (rawData.length < 2) {
        setRmImportError('File is empty or has no data rows')
        return
      }

      const headers = rawData[0].map(h => String(h))
      const rows = rawData.slice(1).filter(row => row.some(cell => String(cell).trim()))
      const colMap = mapImportColumns(headers)

      if (colMap.name === undefined) {
        setRmImportError('Could not find product name column. Expected a header like "Product Name".')
        return
      }

      if (colMap.brand === undefined) {
        // Brand is optional in the new template.
      }

      if (colMap.instock === undefined) {
        setRmImportError('Could not find in stock column. Expected a header like "In Stock".')
        return
      }

      setRmImportHeaders(headers)
      setRmImportRows(rows)
      setRmImportColMap(colMap)
    } catch (err) {
      console.error('Import error:', err)
      setRmImportError(`Failed to parse file: ${err.message || 'Unknown error'}. Please use .xlsx, .xls, or .csv format.`)
    }

    event.target.value = ''
  }

  const handleRmImportSubmit = async () => {
    if (rmImportRows.length === 0) return
    setRmImportLoading(true)
    setRmImportError('')

    try {
      const parseRequiredNumber = (value) => {
        const text = String(value ?? '').trim()
        if (!text) return Number.NaN
        const parsed = Number(text)
        return Number.isFinite(parsed) ? parsed : Number.NaN
      }

      const parseNumberWithDefault = (value, defaultValue = 1) => {
        const text = String(value ?? '').trim()
        if (!text) return defaultValue
        const parsed = Number(text)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
      }

      const parsed = rmImportRows
        .map(row => ({
          name: String(row[rmImportColMap.name] ?? '').trim(),
          brand: rmImportColMap.brand !== undefined ? String(row[rmImportColMap.brand] ?? '').trim() : '',
          sku: rmImportColMap.sku !== undefined ? String(row[rmImportColMap.sku] ?? '').trim() : '',
          costPrice: rmImportColMap.costPrice !== undefined ? Number(row[rmImportColMap.costPrice] ?? 0) : 0,
          instock: rmImportColMap.instock !== undefined ? parseRequiredNumber(row[rmImportColMap.instock]) : Number.NaN,
          size: rmImportColMap.size !== undefined ? String(row[rmImportColMap.size] ?? '').trim() : '',
          unitSize: rmImportColMap.size !== undefined ? parseNumberWithDefault(row[rmImportColMap.size], 1) : 1,
          unitOfMeasure: rmImportColMap.unitOfMeasure !== undefined ? String(row[rmImportColMap.unitOfMeasure] ?? '').trim().toUpperCase() : 'PCS',
          reorderLevel: rmImportColMap.reorderLevel !== undefined ? Number(row[rmImportColMap.reorderLevel] ?? 5) : 5,
          description: rmImportColMap.description !== undefined ? String(row[rmImportColMap.description] ?? '').trim() : '',
          image: rmImportColMap.image !== undefined ? String(row[rmImportColMap.image] ?? '').trim() : '',
        }))

      // Debug: check which rows fail and why
      const failures = []
      parsed.forEach((row, idx) => {
        const reasons = []
        if (!row.name) reasons.push('missing name')
        if (!Number.isFinite(row.instock)) reasons.push(`invalid instock: "${rmImportRows[idx][rmImportColMap.instock]}"`)
        if (reasons.length > 0) {
          failures.push(`Row ${idx + 1} (${row.name || 'unnamed'}): ${reasons.join(', ')}`)
        }
      })

      if (failures.length > 0) {
        console.warn('Skipped rows:', failures)
      }

      const payload = parsed
        .filter(row => row.name && Number.isFinite(row.instock))

      if (payload.length === 0) {
        setRmImportError(`All rows were invalid. Issues:\n${failures.join('\n')}`)
        setRmImportLoading(false)
        return
      }

      const res = await bulkImportRawMaterials(payload)
      if (res.success) {
        setRmImportResult(res.data)
        setRmImportRows([])
        setRmImportHeaders([])
        loadData()
      } else {
        setRmImportError(res.error || 'Import failed')
      }
    } catch (err) {
      setRmImportError(`Import failed: ${err.message}`)
    }

    setRmImportLoading(false)
  }

  const handleCreateRawMaterial = async () => {
    if (!rmForm.name) return alert('Name is required')
    setSubmitting(true)

    let imageUrl = ''
    if (rmImages.length > 0) {
      try {
        imageUrl = await uploadProductImages(rmImages)
      } catch (err) {
        alert(err?.message || 'Image upload failed')
        setSubmitting(false)
        return
      }
    }

    // Allow manual SKU, otherwise auto-generate a unique one.
    let sku = String(rmForm.sku || '').trim() || generateRMSku()
    // If it already exists, keep incrementing
    const existingSkus = new Set(products.map(p => p.sku))
    let counter = products.filter(p => p.category === 'Raw Material').length + 1
    while (existingSkus.has(sku)) {
      counter++
      sku = `RM-${String(counter).padStart(3, '0')}`
    }

    const res = await createProduct({
      name: rmForm.name,
      brand: rmForm.brand || undefined,
      sku,
      category: 'Raw Material',
      price: 0,
      costPrice: Number(rmForm.costPrice) || 0,
      stock: Number(rmForm.instock) || 0,
      unitSize: 1,
      unitOfMeasure: rmForm.unitOfMeasure || 'PCS',
      reorderLevel: 5,
      description: rmForm.size ? String(rmForm.size).trim() : undefined,
      image: imageUrl || undefined,
    })
    if (res.success) {
      setRmForm({ name: '', size: '', brand: '', sku: '', instock: '', costPrice: '', stockQuantity: 0, unitSize: 1, unitOfMeasure: 'PCS', reorderLevel: 5, description: '' })
      setRmImages([])
      loadData()
    } else {
      alert(res.error)
    }
    setSubmitting(false)
  }

  const handleDeleteRawMaterial = async (id, name) => {
    if (!await confirmDialog(`Delete raw material "${name}"? This cannot be undone.`)) return
    setSubmitting(true)
    const res = await deleteRawMaterial(id)
    if (res.success) loadData()
    else alert(res.error)
    setSubmitting(false)
  }

  const handleUpdateRawMaterial = async (id) => {
    let imageUrl = rmEditForm.image || ''
    if (rmEditImages.length > 0) {
      try {
        imageUrl = await uploadProductImages(rmEditImages)
      } catch (err) {
        alert(err?.message || 'Image upload failed')
        return
      }
    }

    setSubmitting(true)
    const res = await updateProduct(id, {
      name: rmEditForm.name,
      brand: rmEditForm.brand || undefined,
      unitOfMeasure: rmEditForm.unitOfMeasure || 'PCS',
      unitSize: Number(rmEditForm.unitSize) || 1,
      reorderLevel: Number(rmEditForm.reorderLevel ?? 5),
      description: rmEditForm.description || undefined,
      image: imageUrl || undefined,
    })
    if (!res.success) {
      alert(res.error)
      setSubmitting(false)
      return
    }

    const unitSize = Number(rmEditForm.unitSize) > 0 ? Number(rmEditForm.unitSize) : 1
    const currentQty = Number(rmEditForm.currentStockQuantity ?? 0)
    const enteredQty = Math.max(0, Number(rmEditForm.stockQuantity) || 0)
    const newQty = rmEditForm.stockAction === 'ADD' ? currentQty + enteredQty : enteredQty
    const stockRes = await updateStock(rmEditForm.stockAction === 'ADD' ? { id, operation: 'ADD', quantity: enteredQty * unitSize } : { id, stock: newQty * unitSize })
    if (!stockRes.success) {
      alert(stockRes.error)
      setSubmitting(false)
      return
    }

    setEditingRmId(null)
    setRmEditImages([])
    loadData()
    setSubmitting(false)
  }

  const handleBulkDelete = async () => {
    setBulkDeleting(true)
    let deleted = 0
    let failed = 0
    const errors = []

    for (const id of selectedRmIds) {
      const res = await deleteRawMaterial(id)
      if (res.success) {
        deleted++
      } else {
        failed++
        const material = rawMaterials.find(rm => rm.id === id)
        errors.push(`${material?.name}: ${res.error}`)
      }
    }

    setShowBulkDeleteModal(false)
    setSelectedRmIds(new Set())
    loadData()

    let message = `Deleted ${deleted} raw material${deleted !== 1 ? 's' : ''}.`
    if (failed > 0) {
      message += `\n\nFailed to delete ${failed} item${failed !== 1 ? 's' : ''}:`
      message += '\n' + errors.slice(0, 5).join('\n')
      if (errors.length > 5) message += `\n... and ${errors.length - 5} more`
    }

    alert(message)
    setBulkDeleting(false)
  }

  // Filter raw materials (products with category "Raw Material")
  const rawMaterials = products.filter(p =>
    p.category === 'Raw Material' &&
    (!rmSearch || p.name.toLowerCase().includes(rmSearch.toLowerCase()) || p.sku.toLowerCase().includes(rmSearch.toLowerCase()))
  )

  const TABS = [
    { id: 'production', label: 'Production Orders', icon: Factory },
    { id: 'bom', label: 'Bill of Materials', icon: Layers },
    { id: 'materials', label: 'Raw Materials', icon: Package },
    { id: 'workcenters', label: 'Work Centers', icon: Wrench },
    { id: 'mrp', label: 'MRP Planner', icon: Cpu },
    { id: 'quality', label: 'Quality & Scrap', icon: ShieldCheck },
    { id: 'scrap', label: 'Scrap Inventory', icon: FlameKindling },
    { id: 'customInventory', label: 'Custom Inventory', icon: Package },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'costing', label: 'Job Costing', icon: Activity },
  ]

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
    </div>
  )

  const completedOrders = orders.filter(o => o.status === 'COMPLETED')
  const overdueOrders = orders.filter(o => o.dueDate && new Date(o.dueDate) < new Date() && !['COMPLETED', 'CANCELLED'].includes(o.status))

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Manufacturing</h1>
          <p className="text-muted text-sm mt-0.5">BOM · Production Orders · Work Centers · MRP · Quality · Costing</p>
        </div>
        <div className="flex w-full sm:w-auto gap-2 flex-wrap">
          {tab === 'bom' && (
            <>
              <button onClick={() => setShowTemplateModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-surface border border-border text-foreground rounded-lg text-sm font-medium hover:bg-surface-hover flex items-center gap-2">
                <FileText className="w-4 h-4" /> Templates
              </button>
              <button onClick={() => setShowBOMModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
                <Plus className="w-4 h-4" /> New BOM
              </button>
            </>
          )}
          {tab === 'production' && (
            <button onClick={() => setShowProdModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Production Order
            </button>
          )}
          {tab === 'workcenters' && (
            <button onClick={() => setShowWCModal(true)} className="flex-1 sm:flex-none justify-center px-3 sm:px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Work Center
            </button>
          )}
          <button onClick={loadData} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-muted hover:text-foreground flex items-center gap-1.5" aria-label="Refresh manufacturing data">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Orders', value: orders.length, icon: Factory, color: 'text-purple-400' },
          { label: 'In Progress', value: orders.filter(o => o.status === 'IN_PROGRESS').length, icon: PlayCircle, color: 'text-blue-400' },
          { label: 'Completed', value: completedOrders.length, icon: CheckCircle, color: 'text-emerald-400' },
          { label: 'Overdue', value: overdueOrders.length, icon: AlertTriangle, color: overdueOrders.length > 0 ? 'text-red-400' : 'text-muted' },
          { label: 'Active BOMs', value: boms.filter(b => b.isActive).length, icon: Layers, color: 'text-cyan-400' },
          { label: 'Work Centers', value: workCenters.filter(w => w.status === 'Active').length, icon: Wrench, color: 'text-amber-400' },
        ].map((s, i) => (
          <div key={i} className="glass-card p-3.5">
            <div className="flex items-center gap-2.5">
              <s.icon className={`w-4 h-4 ${s.color} flex-shrink-0`} />
              <div>
                <p className="text-[10px] text-muted uppercase tracking-wide">{s.label}</p>
                <p className="text-xl font-bold text-foreground">{s.value}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs — horizontally scrollable chips on mobile, wrap on desktop */}
      <div className="flex gap-1 bg-surface border border-border rounded-lg p-1 overflow-x-auto hide-scrollbar md:flex-wrap -mx-1 px-1 md:mx-0">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2.5 md:py-2 rounded-md text-xs font-medium transition-all whitespace-nowrap flex-shrink-0 ${tab === t.id ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {/* ── TAB: Production Orders ── */}
      {tab === 'production' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-center">
            <div className="relative w-full sm:flex-1 sm:min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input value={orderSearch} onChange={e => setOrderSearch(e.target.value)} placeholder="Search orders..." className="w-full pl-9 pr-3 py-2.5 sm:py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:flex sm:gap-3">
              <select value={orderStatusFilter} onChange={e => setOrderStatusFilter(e.target.value)} className="px-3 py-2.5 sm:py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                <option value="ALL">All Status</option>
                {['PLANNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <select value={orderPriorityFilter} onChange={e => setOrderPriorityFilter(e.target.value)} className="px-3 py-2.5 sm:py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                <option value="ALL">All Priority</option>
                {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          <div className="glass-card overflow-hidden">
            {/* Mobile stacked cards */}
            <div className="md:hidden divide-y divide-border">
              {filteredOrders.map(o => {
                const isOverdue = o.dueDate && new Date(o.dueDate) < new Date() && !['COMPLETED', 'CANCELLED'].includes(o.status)
                const pct = o.plannedQty > 0 ? Math.min(100, Math.round((o.actualQty / o.plannedQty) * 100)) : 0
                return (
                  <div key={o.id} className={`p-4 space-y-3 ${isOverdue ? 'bg-red-500/5' : ''}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-xs font-semibold text-foreground">{o.displayId}</span>
                          {isOverdue && <span className="text-[9px] px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded-full">OVERDUE</span>}
                        </div>
                        <p className="text-foreground font-medium text-sm mt-1 truncate">{o.finishedProduct?.name}</p>
                        <p className="text-muted text-[11px] truncate">{o.bom?.name} v{o.bom?.version}</p>
                        {o.customOrder && <p className="text-accent text-[11px] truncate">{o.customOrder.displayId} · {o.customOrder.contact?.name}</p>}
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${STATUS_COLORS[o.status] || ''}`}>{o.status?.replace(/_/g, ' ')}</span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${PRIORITY_COLORS[o.priority] || ''}`}>{o.priority}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${QUALITY_COLORS[o.qualityStatus] || ''}`}>{o.qualityStatus}</span>
                      <span className="text-[11px] text-muted">Qty: <span className="text-foreground font-medium">{o.actualQty}</span> / {o.plannedQty}</span>
                    </div>

                    {o.status === 'IN_PROGRESS' && o.plannedQty > 0 && (
                      <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${o.actualQty >= o.plannedQty ? 'bg-emerald-500' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                      </div>
                    )}

                    <div className="flex items-center justify-between text-[11px] text-muted">
                      <span>Due: {o.dueDate ? new Date(o.dueDate).toLocaleDateString('en-IN') : '—'}</span>
                      <span className="truncate ml-2">{o.assignedStaff?.name || o.assignedTo || '—'}</span>
                    </div>

                    <div className="flex items-center gap-1.5 flex-wrap pt-1">
                      <button onClick={() => { setSelectedOrder(o); setShowDetailModal(true) }} className="touch-target px-3 rounded-lg bg-surface-hover text-muted hover:text-foreground flex items-center gap-1.5 text-xs"><Eye className="w-4 h-4" /> View</button>
                      {o.status === 'PLANNED' && (
                        <button onClick={() => handleStartProd(o.id)} className="touch-target px-3 rounded-lg bg-blue-500/10 text-blue-400 flex items-center gap-1.5 text-xs"><PlayCircle className="w-4 h-4" /> Start</button>
                      )}
                      {o.status === 'IN_PROGRESS' && (
                        <>
                          <button onClick={() => openCompleteModal(o)} className="touch-target px-3 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 text-xs"><CheckCircle className="w-4 h-4" /> Complete</button>
                          <button onClick={() => handleHoldProd(o.id)} className="touch-target px-3 rounded-lg bg-amber-500/10 text-amber-400 flex items-center gap-1.5 text-xs"><Pause className="w-4 h-4" /> Hold</button>
                        </>
                      )}
                      {o.status === 'ON_HOLD' && (
                        <>
                          <button onClick={() => handleStartProd(o.id)} className="touch-target px-3 rounded-lg bg-blue-500/10 text-blue-400 flex items-center gap-1.5 text-xs"><PlayCircle className="w-4 h-4" /> Resume</button>
                          <button onClick={() => openCompleteModal(o)} className="touch-target px-3 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5 text-xs"><CheckCircle className="w-4 h-4" /> Complete</button>
                        </>
                      )}
                      {(o.status === 'IN_PROGRESS' || o.status === 'ON_HOLD') && (
                        <button onClick={() => { setQcTarget(o); setQcForm({ qualityStatus: 'PASSED', qualityNotes: '', scrapQty: 0, scrapReason: '' }); setShowQCModal(true) }} className="touch-target px-3 rounded-lg bg-purple-500/10 text-purple-400 flex items-center gap-1.5 text-xs"><ShieldCheck className="w-4 h-4" /> QC</button>
                      )}
                      {!['COMPLETED', 'CANCELLED'].includes(o.status) && (
                        <button onClick={() => { setCancelTarget(o); setShowCancelModal(true) }} className="touch-target px-3 rounded-lg bg-red-500/10 text-red-400 flex items-center gap-1.5 text-xs"><XCircle className="w-4 h-4" /> Cancel</button>
                      )}
                      {['PLANNED', 'CANCELLED'].includes(o.status) && (
                        <button onClick={() => { setDeleteProdTarget(o); setShowDeleteProdModal(true) }} className="touch-target px-3 rounded-lg bg-red-500/10 text-red-400 flex items-center gap-1.5 text-xs"><Trash2 className="w-4 h-4" /> Delete</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="overflow-x-auto hidden md:block">
              <table className="w-full text-sm min-w-[980px]">
                <thead>
                  <tr className="border-b border-border bg-surface-hover">
                    {['Order #', 'BOM / Product', 'Priority', 'Qty', 'Status', 'Quality', 'Due Date', 'Assigned To', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map(o => {
                    const isOverdue = o.dueDate && new Date(o.dueDate) < new Date() && !['COMPLETED', 'CANCELLED'].includes(o.status)
                    return (
                      <tr key={o.id} className={`border-b border-border/50 hover:bg-surface-hover transition-colors ${isOverdue ? 'bg-red-500/5' : ''}`}>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs font-semibold text-foreground">{o.displayId}</span>
                          {isOverdue && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded-full">OVERDUE</span>}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-foreground font-medium text-xs">{o.finishedProduct?.name}</p>
                          <p className="text-muted text-[10px]">{o.bom?.name} v{o.bom?.version}</p>
                          {o.customOrder && <p className="text-accent text-[10px]">{o.customOrder.displayId} · {o.customOrder.contact?.name}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${PRIORITY_COLORS[o.priority] || ''}`}>{o.priority}</span>
                        </td>
                        <td className="px-4 py-3 text-foreground">
                          <div className="flex items-center gap-1.5">
                            <span>{o.actualQty}</span>
                            <span className="text-muted text-[10px]">/ {o.plannedQty}</span>
                          </div>
                          {o.status === 'IN_PROGRESS' && o.plannedQty > 0 && (
                            <div className="h-1.5 bg-surface rounded-full overflow-hidden mt-1 w-20">
                              <div className={`h-full rounded-full ${o.actualQty >= o.plannedQty ? 'bg-emerald-500' : 'bg-accent'}`}
                                style={{ width: `${Math.min(100, Math.round((o.actualQty / o.plannedQty) * 100))}%` }} />
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLORS[o.status] || ''}`}>{o.status?.replace(/_/g, ' ')}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${QUALITY_COLORS[o.qualityStatus] || ''}`}>{o.qualityStatus}</span>
                        </td>
                        <td className="px-4 py-3 text-muted text-xs">
                          {o.dueDate ? new Date(o.dueDate).toLocaleDateString('en-IN') : '—'}
                        </td>
                        <td className="px-4 py-3 text-muted text-xs">{o.assignedStaff?.name || o.assignedTo || '—'}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => { setSelectedOrder(o); setShowDetailModal(true) }} className="p-1.5 rounded hover:bg-surface-hover text-muted hover:text-foreground" title="View Details"><Eye className="w-3.5 h-3.5" /></button>
                            {o.status === 'PLANNED' && (
                              <button onClick={() => handleStartProd(o.id)} className="p-1.5 rounded hover:bg-blue-500/10 text-muted hover:text-blue-400" title="Start Production"><PlayCircle className="w-3.5 h-3.5" /></button>
                            )}
                            {o.status === 'IN_PROGRESS' && (
                              <>
                                <button onClick={() => openCompleteModal(o)} className="p-1.5 rounded hover:bg-emerald-500/10 text-muted hover:text-emerald-400" title="Complete"><CheckCircle className="w-3.5 h-3.5" /></button>
                                <button onClick={() => handleHoldProd(o.id)} className="p-1.5 rounded hover:bg-amber-500/10 text-muted hover:text-amber-400" title="Hold"><Pause className="w-3.5 h-3.5" /></button>
                              </>
                            )}
                            {o.status === 'ON_HOLD' && (
                              <>
                                <button onClick={() => handleStartProd(o.id)} className="p-1.5 rounded hover:bg-blue-500/10 text-muted hover:text-blue-400" title="Resume"><PlayCircle className="w-3.5 h-3.5" /></button>
                                <button onClick={() => openCompleteModal(o)} className="p-1.5 rounded hover:bg-emerald-500/10 text-muted hover:text-emerald-400" title="Complete"><CheckCircle className="w-3.5 h-3.5" /></button>
                              </>
                            )}
                            {(o.status === 'IN_PROGRESS' || o.status === 'ON_HOLD') && (
                              <button onClick={() => { setQcTarget(o); setQcForm({ qualityStatus: 'PASSED', qualityNotes: '', scrapQty: 0, scrapReason: '' }); setShowQCModal(true) }} className="p-1.5 rounded hover:bg-purple-500/10 text-muted hover:text-purple-400" title="Quality Check"><ShieldCheck className="w-3.5 h-3.5" /></button>
                            )}
                            {!['COMPLETED', 'CANCELLED'].includes(o.status) && (
                              <button onClick={() => { setCancelTarget(o); setShowCancelModal(true) }} className="p-1.5 rounded hover:bg-red-500/10 text-muted hover:text-red-400" title="Cancel"><XCircle className="w-3.5 h-3.5" /></button>
                            )}
                            {['PLANNED', 'CANCELLED'].includes(o.status) && (
                              <button onClick={() => { setDeleteProdTarget(o); setShowDeleteProdModal(true) }} className="p-1.5 rounded hover:bg-red-500/10 text-muted hover:text-red-400" title="Delete Order"><Trash2 className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {filteredOrders.length === 0 && (
              <div className="text-center py-12 text-muted">
                {orders.length === 0 ? 'No production orders yet' : 'No orders match your filters'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── TAB: Bill of Materials ── */}
      {tab === 'bom' && (
        <div className="space-y-4">
          {boms.map(bom => (
            <BOMCard
              key={bom.id} bom={bom} products={products} workCenters={workCenters}
              onToggle={async () => { const r = await toggleBOMStatus(bom.id); if (r.success) loadData(); else alert(r.error) }}
              onDelete={async () => { if (!await confirmDialog('Delete this BOM?')) return; const r = await deleteBOM(bom.id); if (r.success) loadData(); else alert(r.error) }}
              onExport={() => downloadBOMCSV(bom)}
              onSaveAsTemplate={async (steps) => {
                const name = prompt('Template name:')
                if (!name) return
                const res = await createBomTemplate({ name, steps: steps.map((s, idx) => ({ stepNumber: idx + 1, operationName: s.operationName, workCenterId: s.workCenterId || undefined, durationMins: s.durationMins, labourRatePerHour: s.labourRatePerHour, machineCostPerUnit: s.machineCostPerUnit, notes: s.notes })) })
                if (res.success) { loadData(); alert('Template saved!') }
                else alert(res.error)
              }}
              onRefresh={loadData}
            />
          ))}
          {boms.length === 0 && <div className="text-center py-16 text-muted">No Bill of Materials yet. Create one to start manufacturing.</div>}
        </div>
      )}

      {/* ── TAB: Work Centers ── */}
      {tab === 'workcenters' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {workCenters.map(wc => (
            <div key={wc.id} className="glass-card p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-foreground">{wc.name}</h3>
                  <p className="text-xs text-muted mt-0.5">{wc.type}</p>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${wc.status === 'Active' ? 'bg-emerald-500/10 text-emerald-400' : wc.status === 'Maintenance' ? 'bg-amber-500/10 text-amber-400' : 'bg-gray-500/10 text-gray-400'}`}>
                  {wc.status}
                </span>
              </div>
              {wc.description && <p className="text-xs text-muted mb-3">{wc.description}</p>}
              <div className="flex items-center justify-between text-xs text-muted mb-4">
                <span>Capacity: <span className="text-foreground font-medium">{wc.capacity} units/day</span></span>
                <span>Orders: <span className="text-foreground font-medium">{wc._count?.productionOrders || 0}</span></span>
              </div>
              <div className="flex gap-2">
                {wc.status !== 'Active' && (
                  <button onClick={async () => { await updateWorkCenterStatus(wc.id, 'Active'); loadData() }} className="flex-1 py-1.5 text-xs bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 rounded-lg">Set Active</button>
                )}
                {wc.status !== 'Maintenance' && (
                  <button onClick={async () => { await updateWorkCenterStatus(wc.id, 'Maintenance'); loadData() }} className="flex-1 py-1.5 text-xs bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 rounded-lg">Maintenance</button>
                )}
                {wc.status !== 'Inactive' && (
                  <button onClick={async () => { await updateWorkCenterStatus(wc.id, 'Inactive'); loadData() }} className="flex-1 py-1.5 text-xs bg-gray-500/10 text-gray-400 hover:bg-gray-500/20 rounded-lg">Inactive</button>
                )}
                <button onClick={async () => { if (!await confirmDialog('Delete work center?')) return; const r = await deleteWorkCenter(wc.id); if (!r.success) alert(r.error); else loadData() }} className="p-1.5 text-red-400/50 hover:text-red-400 hover:bg-red-500/10 rounded-lg"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
          {workCenters.length === 0 && (
            <div className="col-span-3 text-center py-16 text-muted">No work centers yet. Add machines and stations used in your factory.</div>
          )}
        </div>
      )}

      {/* ── TAB: MRP Planner ── */}
      {tab === 'mrp' && (
        <div className="space-y-5">
          <div className="glass-card p-5">
            <h3 className="font-semibold text-foreground mb-4 flex items-center gap-2"><Cpu className="w-4 h-4 text-accent" /> Material Requirements Planning</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="text-xs text-muted mb-1 block">Select BOM</label>
                <select value={mrpBomId} onChange={e => { setMrpBomId(e.target.value); setMrpResult(null) }} className={SEL}>
                  <option value="">Choose a Bill of Materials</option>
                  {boms.filter(b => b.isActive).map(b => <option key={b.id} value={b.id}>{b.name} — {b.finishedProduct?.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Production Quantity</label>
                <input type="number" min="1" value={mrpQty} onChange={e => { setMrpQty(e.target.value); setMrpResult(null) }} className={INP} />
              </div>
              <div className="flex items-end">
                <button onClick={handleRunMRP} disabled={!mrpBomId || mrpLoading} className="w-full py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 flex items-center justify-center gap-2">
                  {mrpLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Cpu className="w-4 h-4" />}
                  {mrpLoading ? 'Calculating...' : 'Run MRP Analysis'}
                </button>
              </div>
            </div>

            {mrpResult && (
              <div className="space-y-5 mt-4 border-t border-border pt-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h4 className="text-sm font-medium text-foreground">Results: {mrpResult.bomName} × {mrpResult.qty} units</h4>
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold ${mrpResult.canProduceAll ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                    {mrpResult.canProduceAll ? '✓ Can Produce' : `✗ ${mrpResult.shortages.length} Shortage(s)`}
                  </span>
                </div>

                {/* Full Cost Breakdown */}
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                  {[
                    { label: 'Std Time', value: `${mrpResult.totalStandardMins} min`, color: 'text-cyan-400', icon: Clock },
                    { label: 'Material Cost', value: `₹${mrpResult.totalMaterialCost.toLocaleString('en-IN')}`, color: 'text-foreground', icon: Package },
                    { label: 'Labour Cost', value: `₹${mrpResult.totalLabourCost.toLocaleString('en-IN')}`, color: 'text-blue-400', icon: Clock },
                    { label: 'Machine Cost', value: `₹${mrpResult.totalMachineCost.toLocaleString('en-IN')}`, color: 'text-amber-400', icon: Zap },
                    { label: 'Total Mfg Cost', value: `₹${mrpResult.totalManufacturingCost.toLocaleString('en-IN')}`, color: 'text-purple-400', icon: DollarSign },
                    { label: 'Selling Price', value: `₹${mrpResult.sellingPrice.toLocaleString('en-IN')}`, color: 'text-foreground', icon: TrendingUp },
                  ].map((m, i) => (
                    <div key={i} className="bg-surface-hover p-3 rounded-lg">
                      <div className="flex items-center gap-1.5 mb-1">
                        <m.icon className={`w-3.5 h-3.5 ${m.color}`} />
                        <p className="text-[10px] text-muted uppercase">{m.label}</p>
                      </div>
                      <p className={`text-lg font-bold ${m.color}`}>{m.value}</p>
                    </div>
                  ))}
                </div>

                {/* Profit & Margin */}
                <div className="grid grid-cols-2 gap-3">
                  <div className={`p-4 rounded-xl border ${mrpResult.estimatedProfit >= 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                    <p className="text-xs text-muted mb-1">Estimated Profit</p>
                    <p className={`text-2xl font-bold ${mrpResult.estimatedProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {mrpResult.estimatedProfit >= 0 ? '+' : ''}₹{mrpResult.estimatedProfit.toLocaleString('en-IN')}
                    </p>
                    <p className="text-xs text-muted mt-1">Selling Price − Total Mfg Cost</p>
                  </div>
                  <div className={`p-4 rounded-xl border ${mrpResult.estimatedMargin >= 20 ? 'bg-emerald-500/5 border-emerald-500/20' : mrpResult.estimatedMargin >= 0 ? 'bg-amber-500/5 border-amber-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                    <p className="text-xs text-muted mb-1">Profit Margin</p>
                    <p className={`text-2xl font-bold ${mrpResult.estimatedMargin >= 20 ? 'text-emerald-400' : mrpResult.estimatedMargin >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                      {mrpResult.estimatedMargin}%
                    </p>
                    <p className="text-xs text-muted mt-1">{mrpResult.estimatedMargin >= 20 ? '✓ Healthy margin' : mrpResult.estimatedMargin >= 0 ? '⚠ Low margin' : '✗ Loss-making'}</p>
                  </div>
                </div>

                {/* Material requirements table */}
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <h5 className="text-xs font-medium text-muted uppercase tracking-wide flex items-center gap-1.5"><Package className="w-3.5 h-3.5" /> Material Requirements <span className="normal-case tracking-normal">(available = on hand − reserved by deliveries &amp; other production orders)</span></h5>
                    {mrpResult.requirements.some(r => r.shortageAfterIncoming > 0) && (
                      <button onClick={handleOrderShortages} disabled={mrpLoading} className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-50">Order shortages</button>
                    )}
                  </div>
                  {/* Mobile cards */}
                  <div className="md:hidden space-y-2">
                    {mrpResult.requirements.map((r, i) => (
                      <div key={i} className={`rounded-lg border border-border p-3 ${!r.canProduce ? 'bg-red-500/5' : 'bg-surface-hover'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-foreground font-medium text-sm truncate">{r.materialName}</p>
                            <p className="text-muted font-mono text-[11px]">{r.sku}</p>
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${r.canProduce ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>{r.canProduce ? 'OK' : 'Short'}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
                          <span className="text-muted">Required: <span className="text-foreground">{r.required} {r.unitOfMeasure}</span></span>
                          <span className="text-muted">Available: <span className="text-foreground">{r.available} {r.unitOfMeasure}</span></span>
                          <span className="text-muted">Shortage: {r.shortage > 0 ? <span className="text-red-400 font-semibold">{r.shortage} {r.unitOfMeasure}</span> : <span className="text-emerald-400">—</span>}</span>
                          <span className="text-muted">Unit Cost: <span className="text-foreground">₹{r.unitCost}</span></span>
                          <span className="text-muted col-span-2">Est. Cost: <span className="text-foreground">₹{r.estimatedCost.toLocaleString('en-IN')}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          {['Material', 'SKU', 'Required', 'On hand', 'Reserved', 'Available', 'Incoming', 'Shortage', 'Unit Cost', 'Est. Cost', 'Status'].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {mrpResult.requirements.map((r, i) => (
                          <tr key={i} className={`border-b border-border/50 ${!r.canProduce ? 'bg-red-500/5' : ''}`}>
                            <td className="px-3 py-2 text-foreground font-medium">{r.materialName}</td>
                            <td className="px-3 py-2 text-muted font-mono text-xs">{r.sku}</td>
                            <td className="px-3 py-2 text-foreground">{r.required} {r.unitOfMeasure}</td>
                            <td className="px-3 py-2 text-muted">{r.onHand ?? '—'}</td>
                            <td className="px-3 py-2 text-muted">{r.reserved ?? 0}</td>
                            <td className="px-3 py-2 text-foreground">{r.available} {r.unitOfMeasure}</td>
                            <td className="px-3 py-2 text-blue-400">{r.incoming ?? 0}</td>
                            <td className="px-3 py-2">
                              {r.shortage > 0 ? <span className="text-red-400 font-semibold">{r.shortage} {r.unitOfMeasure}{r.incoming > 0 && <span className="block text-[10px] text-muted font-normal">{r.shortageAfterIncoming > 0 ? `${r.shortageAfterIncoming} after incoming` : 'covered by incoming'}</span>}</span> : <span className="text-emerald-400">—</span>}
                            </td>
                            <td className="px-3 py-2 text-muted text-xs">₹{r.unitCost}/unit</td>
                            <td className="px-3 py-2 text-foreground">₹{r.estimatedCost.toLocaleString('en-IN')}</td>
                            <td className="px-3 py-2">
                              <span className={`text-xs px-2 py-0.5 rounded-full ${r.canProduce ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                {r.canProduce ? 'OK' : 'Short'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Step-wise labour/machine cost */}
                {mrpResult.stepCostings?.length > 0 && (
                  <div>
                    <h5 className="text-xs font-medium text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> Job Costing by Operation</h5>
                    {/* Mobile cards */}
                    <div className="md:hidden space-y-2">
                      {mrpResult.stepCostings.map((s, i) => (
                        <div key={i} className="rounded-lg border border-border bg-surface-hover p-3">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-foreground font-medium text-sm">{s.stepNumber}. {s.operationName}</p>
                            <span className="text-foreground font-semibold text-sm flex-shrink-0">₹{(s.totalLabourCost + s.totalMachineCost).toLocaleString('en-IN')}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
                            <span className="text-muted col-span-2">Work Center: <span className="text-foreground">{s.workCenter}</span></span>
                            <span className="text-muted">Duration: <span className="text-foreground">{s.durationMins}min</span></span>
                            <span className="text-muted">Rate: <span className="text-foreground">₹{s.labourRatePerHour}/hr</span></span>
                            <span className="text-muted">Labour: <span className="text-blue-400">₹{s.totalLabourCost.toLocaleString('en-IN')}</span></span>
                            <span className="text-muted">Machine: <span className="text-amber-400">₹{s.totalMachineCost.toLocaleString('en-IN')}</span></span>
                          </div>
                        </div>
                      ))}
                      <div className="rounded-lg bg-surface-hover p-3 flex items-center justify-between text-sm">
                        <span className="font-semibold text-muted">TOTAL</span>
                        <span className="font-bold text-foreground">₹{(mrpResult.totalLabourCost + mrpResult.totalMachineCost).toLocaleString('en-IN')}</span>
                      </div>
                    </div>
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            {['Step', 'Operation', 'Work Center', 'Duration', 'Labour Rate', 'Labour Cost', 'Machine Cost', 'Total'].map(h => (
                              <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {mrpResult.stepCostings.map((s, i) => (
                            <tr key={i} className="border-b border-border/50">
                              <td className="px-3 py-2 text-muted text-xs">{s.stepNumber}</td>
                              <td className="px-3 py-2 text-foreground font-medium">{s.operationName}</td>
                              <td className="px-3 py-2 text-muted text-xs">{s.workCenter}</td>
                              <td className="px-3 py-2 text-muted text-xs">{s.durationMins}min</td>
                              <td className="px-3 py-2 text-muted text-xs">₹{s.labourRatePerHour}/hr</td>
                              <td className="px-3 py-2 text-blue-400">₹{s.totalLabourCost.toLocaleString('en-IN')}</td>
                              <td className="px-3 py-2 text-amber-400">₹{s.totalMachineCost.toLocaleString('en-IN')}</td>
                              <td className="px-3 py-2 text-foreground font-medium">₹{(s.totalLabourCost + s.totalMachineCost).toLocaleString('en-IN')}</td>
                            </tr>
                          ))}
                          <tr className="bg-surface-hover">
                            <td colSpan={5} className="px-3 py-2 text-xs font-semibold text-muted text-right">TOTAL</td>
                            <td className="px-3 py-2 text-blue-400 font-bold">₹{mrpResult.totalLabourCost.toLocaleString('en-IN')}</td>
                            <td className="px-3 py-2 text-amber-400 font-bold">₹{mrpResult.totalMachineCost.toLocaleString('en-IN')}</td>
                            <td className="px-3 py-2 text-foreground font-bold">₹{(mrpResult.totalLabourCost + mrpResult.totalMachineCost).toLocaleString('en-IN')}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── TAB: Quality & Scrap ── */}
      {tab === 'quality' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Quality Pass Rate', value: `${stats?.totals?.qualityRate ?? 0}%`, icon: ShieldCheck, color: 'text-emerald-400' },
              { label: 'Avg Yield Rate', value: `${stats?.totals?.avgYield ?? 0}%`, icon: TrendingUp, color: 'text-blue-400' },
              { label: 'Finished Scrap', value: `${stats?.totals?.totalScrap ?? 0} pcs`, icon: FlameKindling, color: 'text-red-400' },
              { label: 'Material Scrap', value: `${(stats?.totals?.totalMaterialScrapQty ?? 0).toLocaleString('en-IN')} qty`, icon: Package, color: 'text-orange-400' },
            ].map((s, i) => (
              <div key={i} className="glass-card p-4 flex items-center gap-3">
                <s.icon className={`w-5 h-5 ${s.color}`} />
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="text-lg font-bold text-foreground">{s.value}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="glass-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-medium text-foreground">Quality Records — All Production Orders</h3>
            </div>
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border">
              {completedOrders.map(o => (
                <div key={o.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-xs font-semibold text-foreground">{o.displayId}</span>
                      <p className="text-foreground text-sm truncate">{o.finishedProduct?.name}</p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${QUALITY_COLORS[o.qualityStatus] || ''}`}>{o.qualityStatus}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <span className="text-muted">Planned: <span className="text-foreground">{o.plannedQty}</span></span>
                    <span className="text-muted">Actual: <span className="text-foreground">{o.actualQty}</span></span>
                    <span className="text-muted">Scrap: <span className="text-red-400">{o.scrapQty || 0}</span></span>
                    <span className="text-muted">Yield: <span className={`font-semibold ${(o.yieldRate || 0) >= 90 ? 'text-emerald-400' : (o.yieldRate || 0) >= 75 ? 'text-amber-400' : 'text-red-400'}`}>{o.yieldRate?.toFixed(1) || 0}%</span></span>
                  </div>
                  {(o.qualityNotes || o.scrapReason) && <p className="text-[11px] text-muted">{o.qualityNotes || o.scrapReason}</p>}
                </div>
              ))}
            </div>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-hover">
                    {['Order #', 'Product', 'Planned', 'Actual', 'Scrap', 'Yield', 'Quality', 'Notes'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {completedOrders.map(o => (
                    <tr key={o.id} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">{o.displayId}</td>
                      <td className="px-4 py-3 text-foreground">{o.finishedProduct?.name}</td>
                      <td className="px-4 py-3 text-muted">{o.plannedQty}</td>
                      <td className="px-4 py-3 text-foreground">{o.actualQty}</td>
                      <td className="px-4 py-3 text-red-400">{o.scrapQty || 0}</td>
                      <td className="px-4 py-3">
                        <span className={`font-semibold ${(o.yieldRate || 0) >= 90 ? 'text-emerald-400' : (o.yieldRate || 0) >= 75 ? 'text-amber-400' : 'text-red-400'}`}>
                          {o.yieldRate?.toFixed(1) || 0}%
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${QUALITY_COLORS[o.qualityStatus] || ''}`}>{o.qualityStatus}</span>
                      </td>
                      <td className="px-4 py-3 text-muted text-xs">{o.qualityNotes || o.scrapReason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {completedOrders.length === 0 && <div className="text-center py-10 text-muted">No completed orders yet</div>}
          </div>

          {orders.filter(o => o.status === 'IN_PROGRESS').length > 0 && (
            <div className="glass-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-sm font-medium text-foreground">Pending Quality Checks</h3>
              </div>
              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-border">
                {orders.filter(o => o.status === 'IN_PROGRESS').map(o => (
                  <div key={o.id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-mono text-xs font-semibold text-foreground">{o.displayId}</span>
                        <p className="text-foreground text-sm truncate">{o.finishedProduct?.name}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted">
                      <span>Planned: <span className="text-foreground">{o.plannedQty}</span></span>
                      <span>WC: <span className="text-foreground">{o.workCenter?.name || '—'}</span></span>
                    </div>
                    <button onClick={() => { setQcTarget(o); setQcForm({ qualityStatus: 'PASSED', qualityNotes: '', scrapQty: 0, scrapReason: '' }); setShowQCModal(true) }} className="touch-target w-full justify-center px-3 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 rounded-lg text-xs font-medium flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4" /> Record QC
                    </button>
                  </div>
                ))}
              </div>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-hover">
                      {['Order #', 'Product', 'Planned Qty', 'Work Center', 'Action'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orders.filter(o => o.status === 'IN_PROGRESS').map(o => (
                      <tr key={o.id} className="border-b border-border/50">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">{o.displayId}</td>
                        <td className="px-4 py-3 text-foreground">{o.finishedProduct?.name}</td>
                        <td className="px-4 py-3 text-muted">{o.plannedQty}</td>
                        <td className="px-4 py-3 text-muted">{o.workCenter?.name || '—'}</td>
                        <td className="px-4 py-3">
                          <button onClick={() => { setQcTarget(o); setQcForm({ qualityStatus: 'PASSED', qualityNotes: '', scrapQty: 0, scrapReason: '' }); setShowQCModal(true) }} className="px-3 py-1.5 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 rounded-lg text-xs font-medium flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5" /> Record QC
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Analytics ── */}
      {/* -- TAB: Scrap Inventory -- */}
      {tab === 'scrap' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Scrap Lots', value: scrapInventory.length, icon: FlameKindling, color: 'text-red-400' },
              { label: 'Reusable Qty', value: scrapInventory.filter(s => s.status === 'IN_STOCK').reduce((sum, s) => sum + (s.quantity || 0), 0).toLocaleString('en-IN'), icon: Package, color: 'text-emerald-400' },
              { label: 'Scrap Value', value: `₹${scrapInventory.reduce((sum, s) => sum + (s.estimatedValue || 0), 0).toLocaleString('en-IN')}`, icon: DollarSign, color: 'text-amber-400' },
              { label: 'Used/Disposed', value: scrapInventory.filter(s => s.status !== 'IN_STOCK').length, icon: CheckCircle, color: 'text-blue-400' },
            ].map((s, i) => (
              <div key={i} className="glass-card p-4 flex items-center gap-3">
                <s.icon className={`w-5 h-5 ${s.color}`} />
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="text-lg font-bold text-foreground">{s.value}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="glass-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
              <div><h3 className="text-sm font-medium text-foreground">Material Scrap & Offcuts</h3><p className="text-xs text-muted mt-1">Record reusable stone remnants from fabrication for resale or future jobs.</p></div>
              {IS_TGM && <button onClick={openOffcutModal} className="px-3 py-2 bg-accent text-white rounded-lg text-xs font-medium flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Record Stone Offcut</button>}
            </div>
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border">
              {scrapInventory.map(s => (
                <div key={s.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-foreground font-medium text-sm truncate">{s.rawMaterial?.name}</p>
                      <p className="text-[11px] text-muted font-mono">{s.rawMaterial?.sku}</p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${s.status === 'IN_STOCK' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400'}`}>{s.status.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <span className="text-muted">Qty: <span className="text-foreground font-semibold">{s.quantity} {s.unitOfMeasure}</span></span>
                    <span className="text-muted">Value: <span className="text-foreground">₹{(s.estimatedValue || 0).toLocaleString('en-IN')}</span></span>
                    <span className="text-muted">Source: <span className="text-foreground">{s.sourceSlab ? `Lot ${s.sourceSlab.lot?.lotNumber} · Slab ${s.sourceSlab.slabNumber}` : s.productionOrder?.displayId || '—'}</span></span>
                    <span className="text-muted">Disposition: <span className="text-foreground">{s.disposition}</span></span>
                    <span className="text-muted col-span-2">Date: <span className="text-foreground">{s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN') : '—'}</span></span>
                  </div>
                  {(s.reason || s.notes) && <p className="text-[11px] text-muted">{s.reason || s.notes}</p>}
                  {s.status === 'IN_STOCK' && <div className="flex gap-2 pt-1"><button onClick={() => handleScrapStatus(s.id, 'USED')} className="text-xs text-accent hover:underline">Mark used</button><button onClick={() => handleScrapStatus(s.id, 'DISPOSED')} className="text-xs text-red-400 hover:underline">Dispose</button></div>}
                </div>
              ))}
            </div>
            <div className="overflow-x-auto hidden md:block">
              <table className="w-full text-sm min-w-[860px]">
                <thead>
                  <tr className="border-b border-border bg-surface-hover">
                    {['Material', 'Source Order', 'Qty', 'Value', 'Disposition', 'Status', 'Reason', 'Date', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scrapInventory.map(s => (
                    <tr key={s.id} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-4 py-3">
                        <p className="text-foreground font-medium">{s.rawMaterial?.name}</p>
                        <p className="text-[10px] text-muted font-mono">{s.rawMaterial?.sku}</p>
                      </td>
                      <td className="px-4 py-3 text-muted text-xs">{s.sourceSlab ? `Lot ${s.sourceSlab.lot?.lotNumber} · Slab ${s.sourceSlab.slabNumber}` : s.productionOrder?.displayId || '—'}</td>
                      <td className="px-4 py-3 text-foreground font-semibold">{s.quantity} {s.unitOfMeasure}</td>
                      <td className="px-4 py-3 text-foreground">₹{(s.estimatedValue || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-muted text-xs">{s.disposition}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${s.status === 'IN_STOCK' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400'}`}>{s.status.replace(/_/g, ' ')}</span>
                      </td>
                      <td className="px-4 py-3 text-muted text-xs">{s.reason || s.notes || '—'}</td>
                      <td className="px-4 py-3 text-muted text-xs">{s.createdAt ? new Date(s.createdAt).toLocaleDateString('en-IN') : '—'}</td>
                      <td className="px-4 py-3">{s.status === 'IN_STOCK' && <div className="flex gap-2"><button onClick={() => handleScrapStatus(s.id, 'USED')} className="text-xs text-accent hover:underline">Use</button><button onClick={() => handleScrapStatus(s.id, 'DISPOSED')} className="text-xs text-red-400 hover:underline">Dispose</button></div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {scrapInventory.length === 0 && <div className="text-center py-10 text-muted">No material scrap recorded yet</div>}
          </div>
        </div>
      )}

      {/* -- TAB: Custom Inventory -- */}
      {tab === 'customInventory' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Custom Lots', value: customInventory.length, icon: Package, color: 'text-cyan-400' },
              { label: 'Ready Qty', value: customInventory.filter(i => i.status === 'READY').reduce((sum, i) => sum + (i.quantity || 0), 0), icon: CheckCircle, color: 'text-emerald-400' },
              { label: 'Inventory Value', value: `₹${customInventory.reduce((sum, i) => sum + (i.totalCost || 0), 0).toLocaleString('en-IN')}`, icon: DollarSign, color: 'text-amber-400' },
              { label: 'Linked Orders', value: new Set(customInventory.map(i => i.customOrderId)).size, icon: Factory, color: 'text-purple-400' },
            ].map((s, i) => (
              <div key={i} className="glass-card p-4 flex items-center gap-3">
                <s.icon className={`w-5 h-5 ${s.color}`} />
                <div>
                  <p className="text-xs text-muted">{s.label}</p>
                  <p className="text-lg font-bold text-foreground">{s.value}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="glass-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-sm font-medium text-foreground">Finished Goods for Custom Orders</h3>
            </div>
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-border">
              {customInventory.map(i => (
                <div key={i.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono text-xs font-semibold text-foreground">{i.customOrder?.displayId}</span>
                      <p className="text-foreground font-medium text-sm truncate">{i.product?.name}</p>
                      <p className="text-[11px] text-muted font-mono">{i.product?.sku}</p>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${i.status === 'READY' ? 'bg-emerald-500/10 text-emerald-400' : i.status === 'WIP' ? 'bg-blue-500/10 text-blue-400' : 'bg-gray-500/10 text-gray-400'}`}>{i.status}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <span className="text-muted">Customer: <span className="text-foreground">{i.customOrder?.contact?.name || '—'}</span></span>
                    <span className="text-muted">Production: <span className="text-foreground">{i.productionOrder?.displayId || '—'}</span></span>
                    <span className="text-muted">Qty: <span className="text-foreground font-semibold">{i.quantity}</span></span>
                    <span className="text-muted">Unit Cost: <span className="text-foreground">₹{(i.unitCost || 0).toLocaleString('en-IN')}</span></span>
                    <span className="text-muted col-span-2">Total: <span className="text-foreground">₹{(i.totalCost || 0).toLocaleString('en-IN')}</span></span>
                  </div>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto hidden md:block">
              <table className="w-full text-sm min-w-[860px]">
                <thead>
                  <tr className="border-b border-border bg-surface-hover">
                    {['Custom Order', 'Customer', 'Product', 'Production', 'Qty', 'Unit Cost', 'Total Cost', 'Status'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customInventory.map(i => (
                    <tr key={i.id} className="border-b border-border/50 hover:bg-surface-hover">
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-foreground">{i.customOrder?.displayId}</p>
                        <p className="text-[10px] text-muted">{i.customOrder?.type}</p>
                      </td>
                      <td className="px-4 py-3 text-foreground">{i.customOrder?.contact?.name || '—'}</td>
                      <td className="px-4 py-3">
                        <p className="text-foreground font-medium">{i.product?.name}</p>
                        <p className="text-[10px] text-muted font-mono">{i.product?.sku}</p>
                      </td>
                      <td className="px-4 py-3 text-muted text-xs">{i.productionOrder?.displayId || '—'}</td>
                      <td className="px-4 py-3 text-foreground font-semibold">{i.quantity}</td>
                      <td className="px-4 py-3 text-foreground">₹{(i.unitCost || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-foreground">₹{(i.totalCost || 0).toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${i.status === 'READY' ? 'bg-emerald-500/10 text-emerald-400' : i.status === 'WIP' ? 'bg-blue-500/10 text-blue-400' : 'bg-gray-500/10 text-gray-400'}`}>{i.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {customInventory.length === 0 && <div className="text-center py-10 text-muted">No custom order inventory yet</div>}
          </div>
        </div>
      )}

      {tab === 'analytics' && !stats && (
        <div className="text-center py-16 text-muted">Loading analytics data...</div>
      )}
      {tab === 'analytics' && stats && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Total Produced', value: stats.totals.totalProduced.toLocaleString('en-IN'), sub: 'units', icon: Package, color: 'text-blue-400' },
              { label: 'Total Cost', value: `₹${(stats.totals.totalCost / 100000).toFixed(1)}L`, sub: 'incl. overhead', icon: Activity, color: 'text-amber-400' },
              { label: 'Quality Pass Rate', value: `${stats.totals.qualityRate}%`, sub: 'of completed', icon: ShieldCheck, color: 'text-emerald-400' },
              { label: 'Extra Time Cost', value: `₹${(stats.totals.totalTimeVarianceCost || 0).toLocaleString('en-IN')}`, sub: `${stats.totals.totalTimeVarianceMins || 0} extra min`, icon: Clock, color: 'text-red-400' },
            ].map((s, i) => (
              <div key={i} className="glass-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <s.icon className={`w-4 h-4 ${s.color}`} />
                  <p className="text-xs text-muted">{s.label}</p>
                </div>
                <p className="text-2xl font-bold text-foreground">{s.value}</p>
                <p className="text-[10px] text-muted mt-0.5">{s.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2"><Star className="w-4 h-4 text-amber-400" /> Top Produced Products</h3>
              {stats.topProducts.length === 0 ? (
                <p className="text-muted text-sm">No data yet</p>
              ) : stats.topProducts.map((p, i) => {
                const maxQty = stats.topProducts[0].qty
                return (
                  <div key={i} className="mb-3">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-foreground">{p.name}</span>
                      <span className="text-muted">{p.qty} units · {p.orders} orders</span>
                    </div>
                    <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
                      <div className="h-full bg-accent rounded-full" style={{ width: `${(p.qty / maxQty) * 100}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2"><Wrench className="w-4 h-4 text-cyan-400" /> Work Center Utilization</h3>
              {stats.workCenterUtilization.length === 0 ? (
                <p className="text-muted text-sm">No work centers defined</p>
              ) : stats.workCenterUtilization.map((wc, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <div>
                    <p className="text-sm text-foreground">{wc.name}</p>
                    <p className="text-[10px] text-muted">{wc.type}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted">{wc.ordersCount} orders</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${wc.status === 'Active' ? 'bg-emerald-500/10 text-emerald-400' : wc.status === 'Maintenance' ? 'bg-amber-500/10 text-amber-400' : 'bg-gray-500/10 text-gray-400'}`}>{wc.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {stats.monthlyTrend.length > 0 && (
            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-foreground mb-4 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-purple-400" /> Monthly Production Trend (Last 6 Months)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {['Month', 'Orders', 'Units Produced', 'Total Cost'].map(h => (
                        <th key={h} className="px-4 py-2 text-left text-xs font-medium text-muted">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.monthlyTrend.map((m, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="px-4 py-3 text-foreground font-medium">{m.month}</td>
                        <td className="px-4 py-3 text-muted">{m.orders}</td>
                        <td className="px-4 py-3 text-foreground">{m.qty.toLocaleString('en-IN')}</td>
                        <td className="px-4 py-3 text-foreground">₹{m.cost.toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {stats.overdueOrders.length > 0 && (
            <div className="glass-card p-5 border border-red-500/20">
              <h3 className="text-sm font-medium text-red-400 mb-3 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Overdue Orders ({stats.overdueOrders.length})</h3>
              <div className="space-y-2">
                {stats.overdueOrders.map((o, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-red-500/5 rounded-lg text-sm">
                    <span className="font-mono font-semibold text-foreground">{o.displayId}</span>
                    <span className="text-foreground">{o.product}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${PRIORITY_COLORS[o.priority] || ''}`}>{o.priority}</span>
                    <span className="text-red-400 text-xs">Due: {o.dueDate}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLORS[o.status] || ''}`}>{o.status?.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Job Costing ── */}
      {tab === 'costing' && (
        <div className="space-y-4">
          {completedOrders.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Total Material Cost', value: completedOrders.reduce((s, o) => s + (o.totalMaterialCost || 0), 0) },
                { label: 'Total Labour Cost', value: completedOrders.reduce((s, o) => s + (o.totalLabourCost || 0), 0) },
                { label: 'Total Machine Cost', value: completedOrders.reduce((s, o) => s + (o.machineCost || 0), 0) },
                { label: 'Total Other Expenses', value: completedOrders.reduce((s, o) => s + (o.overheadCost || 0), 0) },
                { label: 'Total Manufacturing Cost', value: completedOrders.reduce((s, o) => s + (o.totalCost || 0), 0) },
              ].map((s, i) => (
                <div key={i} className="glass-card p-4">
                  <p className="text-xs text-muted mb-1">{s.label}</p>
                  <p className="text-xl font-bold text-foreground">₹{s.value.toLocaleString('en-IN')}</p>
                </div>
              ))}
            </div>
          )}

          {completedOrders.length === 0 && <div className="text-center py-16 text-muted">No completed production orders for costing analysis</div>}
          {completedOrders.map(o => (
            <div key={o.id} className="glass-card p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-foreground">{o.displayId} — {o.finishedProduct?.name}</h3>
                  <p className="text-xs text-muted mt-0.5">Planned: {o.plannedQty} · Produced: {o.actualQty} · Scrap: {o.scrapQty || 0}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${QUALITY_COLORS[o.qualityStatus]}`}>{o.qualityStatus}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${(o.yieldRate || 0) >= 90 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                    Yield: {o.yieldRate?.toFixed(1) || 0}%
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                {[
                  { label: 'Material Cost', value: o.totalMaterialCost || 0 },
                  { label: 'Labour Cost', value: o.totalLabourCost || 0 },
                  { label: 'Machine Cost', value: o.machineCost || 0 },
                  { label: 'Other Expenses', value: o.overheadCost || 0 },
                  { label: 'Total Cost', value: o.totalCost || 0 },
                  { label: 'Cost/Unit', value: o.costPerUnit || 0 },
                  { label: 'Extra Time Cost', value: o.labourVarianceCost || 0 },
                ].map((c, i) => (
                  <div key={i} className="bg-surface-hover p-3 rounded-lg">
                    <p className="text-[10px] text-muted">{c.label}</p>
                    <p className={`text-base font-bold ${i === 4 ? 'text-accent' : 'text-foreground'}`}>₹{c.value.toLocaleString('en-IN')}</p>
                  </div>
                ))}
              </div>
              {o.consumptions?.length > 0 && (
                <>
                  {/* Mobile cards */}
                  <div className="md:hidden space-y-2">
                    {o.consumptions.map((c, i) => {
                      const varianceBase = (c.actualQty || 0) + (c.scrapQty || 0)
                      const variance = c.plannedQty > 0 ? ((varianceBase - c.plannedQty) / c.plannedQty * 100).toFixed(1) : '0.0'
                      return (
                        <div key={i} className="rounded-lg border border-border bg-surface-hover p-3">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-foreground font-medium text-sm truncate">{c.rawMaterial?.name}</p>
                            <span className={`text-xs font-semibold flex-shrink-0 ${Number(variance) > 10 ? 'text-red-400' : Number(variance) > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{Number(variance) > 0 ? '+' : ''}{variance}%</span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
                            <span className="text-muted">Planned: <span className="text-foreground">{c.plannedQty?.toFixed(2)} {c.rawMaterial?.unitOfMeasure}</span></span>
                            <span className="text-muted">Used: <span className="text-foreground">{c.actualQty?.toFixed(2)}</span></span>
                            <span className="text-muted">Scrap: <span className="text-red-400">{(c.scrapQty || 0).toFixed(2)}</span></span>
                            <span className="text-muted">Returned: <span className="text-emerald-400">{(c.returnedQty || 0).toFixed(2)}</span></span>
                            <span className="text-muted">Unit Cost: <span className="text-foreground">₹{c.unitCost?.toLocaleString('en-IN')}</span></span>
                            <span className="text-muted">Total: <span className="text-foreground">₹{c.totalCost?.toLocaleString('en-IN')}</span></span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          {['Material', 'Planned Qty', 'Used', 'Scrap', 'Returned', 'Unit Cost', 'Total Cost', 'Variance'].map(h => (
                            <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {o.consumptions.map((c, i) => {
                          const varianceBase = (c.actualQty || 0) + (c.scrapQty || 0)
                          const variance = c.plannedQty > 0 ? ((varianceBase - c.plannedQty) / c.plannedQty * 100).toFixed(1) : '0.0'
                          return (
                            <tr key={i} className="border-b border-border/50">
                              <td className="px-3 py-2 text-foreground">{c.rawMaterial?.name}</td>
                              <td className="px-3 py-2 text-muted">{c.plannedQty?.toFixed(2)} {c.rawMaterial?.unitOfMeasure}</td>
                              <td className="px-3 py-2 text-foreground">{c.actualQty?.toFixed(2)}</td>
                              <td className="px-3 py-2 text-red-400">{(c.scrapQty || 0).toFixed(2)}</td>
                              <td className="px-3 py-2 text-emerald-400">{(c.returnedQty || 0).toFixed(2)}</td>
                              <td className="px-3 py-2 text-foreground">₹{c.unitCost?.toLocaleString('en-IN')}</td>
                              <td className="px-3 py-2 text-foreground">₹{c.totalCost?.toLocaleString('en-IN')}</td>
                              <td className="px-3 py-2">
                                <span className={Number(variance) > 10 ? 'text-red-400' : Number(variance) > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                                  {Number(variance) > 0 ? '+' : ''}{variance}%
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── TAB: Raw Materials ── */}
      {tab === 'materials' && (
        <div className="space-y-4">
          {/* Add Raw Material Form */}
          <div className="glass-card p-5">
            <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Plus className="w-4 h-4 text-accent" /> Add New Raw Material
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadRawMaterialTemplate}
                  className="px-3 py-2 bg-surface border border-border rounded-lg text-xs text-muted hover:text-foreground flex items-center gap-1.5">
                  <Download className="w-3.5 h-3.5" /> Template
                </button>
                <button
                  onClick={() => {
                    setShowRmImportModal(true)
                    setRmImportRows([])
                    setRmImportHeaders([])
                    setRmImportResult(null)
                    setRmImportError('')
                  }}
                  className="px-3 py-2 bg-surface border border-border rounded-lg text-xs text-muted hover:text-foreground flex items-center gap-1.5">
                  <Upload className="w-3.5 h-3.5" /> Import Excel/Sheet
                </button>
              </div>
            </div>
            <p className="text-xs text-muted mb-4">Use the same columns as the import sheet. SKU is optional and will auto-generate if left blank.</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">PRODUCT NAME *</label>
                <input
                  value={rmForm.name}
                  onChange={e => setRmForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. OTTER"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">SIZE *</label>
                <input
                  value={rmForm.size}
                  onChange={e => setRmForm(f => ({ ...f, size: e.target.value }))}
                  placeholder="e.g. 1 inch (square)"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">brand</label>
                <input
                  value={rmForm.brand}
                  onChange={e => setRmForm(f => ({ ...f, brand: e.target.value }))}
                  placeholder="optional"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">SKU</label>
                <input
                  value={rmForm.sku}
                  onChange={e => setRmForm(f => ({ ...f, sku: e.target.value }))}
                  placeholder="optional"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">UOM</label>
                <select
                  value={rmForm.unitOfMeasure}
                  onChange={e => setRmForm(f => ({ ...f, unitOfMeasure: e.target.value }))}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50">
                  <option value="PCS">PCS</option>
                  <option value="BOX">BOX</option>
                  <option value="KG">KG</option>
                  <option value="G">G</option>
                  <option value="MTR">MTR</option>
                  <option value="FT">FT</option>
                  <option value="INCH">INCH</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">Instock *</label>
                <input
                  type="number" min="0"
                  value={rmForm.instock}
                  onChange={e => setRmForm(f => ({ ...f, instock: e.target.value }))}
                  placeholder="1"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">Cost price</label>
                <input
                  type="number" min="0"
                  value={rmForm.costPrice}
                  onChange={e => setRmForm(f => ({ ...f, costPrice: e.target.value }))}
                  placeholder="optional"
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <div>
                <label className="text-[10px] text-muted block mb-1 uppercase tracking-wide">Image</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) setRmImages([file])
                    e.target.value = ''
                  }}
                  className="w-full px-3 py-[7px] bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
                {rmImages.length > 0 && <p className="text-[10px] text-muted mt-1 truncate">{rmImages[0].name}</p>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCreateRawMaterial}
                disabled={submitting || !rmForm.name}
                className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-semibold hover:bg-accent/90 disabled:opacity-50 flex items-center gap-2 transition-colors">
                <Plus className="w-4 h-4" />
                {submitting ? 'Adding...' : 'Add Raw Material'}
              </button>
              <button
                onClick={() => {
                  setRmForm({ name: '', size: '', brand: '', sku: '', instock: '', costPrice: '', stockQuantity: 0, unitSize: 1, unitOfMeasure: 'PCS', reorderLevel: 5, description: '' })
                }}
                className="px-4 py-2.5 text-sm text-muted hover:text-foreground transition-colors">
                Clear Form
              </button>
            </div>
          </div>

          {/* Raw Materials Search & Bulk Delete Button */}
          <div className="flex items-center gap-3 flex-wrap justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                <input
                  value={rmSearch}
                  onChange={e => setRmSearch(e.target.value)}
                  placeholder="Search raw materials by name or SKU..."
                  className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <span className="text-xs text-muted">{rawMaterials.length} material{rawMaterials.length !== 1 ? 's' : ''}</span>
            </div>
            {selectedRmIds.size > 0 && (
              <button
                onClick={() => setShowBulkDeleteModal(true)}
                disabled={bulkDeleting}
                className="px-4 py-2 bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 text-sm font-medium rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50">
                <Trash2 className="w-4 h-4" />
                Delete {selectedRmIds.size} Item{selectedRmIds.size !== 1 ? 's' : ''}
              </button>
            )}
          </div>

          {/* Raw Materials Table */}
          <div className="glass-card overflow-hidden">
            {/* Mobile stacked cards */}
            <div className="md:hidden divide-y divide-border">
              {rawMaterials.length === 0 && (
                <div className="text-center py-12 text-muted text-sm">
                  {rmSearch ? 'No materials match your search' : 'No raw materials yet. Add one above to get started.'}
                </div>
              )}
              {rawMaterials.map(rm => {
                const unitSize = Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1
                const stockQty = (Number(rm.stock) || 0) / unitSize
                const isLow = stockQty <= (Number(rm.reorderLevel) || 0)
                const stockQtyLabel = Number.isInteger(stockQty) ? String(stockQty) : stockQty.toFixed(2)
                const stockMeasureLabel = Number.isInteger(Number(rm.stock) || 0) ? String(Number(rm.stock) || 0) : Number(rm.stock || 0).toFixed(2)
                const isEditing = editingRmId === rm.id
                if (isEditing) {
                  return (
                    <div key={rm.id} className="p-4 space-y-3 bg-accent/5">
                      <div className="grid grid-cols-1 gap-2">
                        <div>
                          <label className="text-[10px] text-muted uppercase tracking-wide">Name</label>
                          <input value={rmEditForm.name} onChange={e => setRmEditForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground" />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-muted uppercase tracking-wide">Brand</label>
                            <input value={rmEditForm.brand || ''} onChange={e => setRmEditForm(f => ({ ...f, brand: e.target.value }))} placeholder="Brand" className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground" />
                          </div>
                          <div>
                            <label className="text-[10px] text-muted uppercase tracking-wide">Size</label>
                            <input value={rmEditForm.description || ''} onChange={e => setRmEditForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. 1 inch" className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground" />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-muted uppercase tracking-wide">UoM</label>
                            <select value={rmEditForm.unitOfMeasure || rm.unitOfMeasure || 'PCS'} onChange={e => setRmEditForm(f => ({ ...f, unitOfMeasure: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground">
                              <option value="PCS">PCS</option><option value="BOX">BOX</option><option value="KG">KG</option><option value="G">G</option><option value="MTR">MTR</option><option value="FT">FT</option><option value="INCH">INCH</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] text-muted uppercase tracking-wide">Min. Alert</label>
                            <input type="number" min="0" value={rmEditForm.reorderLevel} onChange={e => setRmEditForm(f => ({ ...f, reorderLevel: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground" />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-muted uppercase tracking-wide">Stock Action</label>
                            <select value={rmEditForm.stockAction || 'SET'} onChange={e => setRmEditForm(f => ({ ...f, stockAction: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground">
                              <option value="SET">Set Stock</option><option value="ADD">Add Stock</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-[10px] text-muted uppercase tracking-wide">Quantity</label>
                            <input type="number" min="0" value={rmEditForm.stockQuantity} onChange={e => setRmEditForm(f => ({ ...f, stockQuantity: e.target.value, currentStockQuantity: stockQty }))} className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground" placeholder={rmEditForm.stockAction === 'ADD' ? 'Add Qty' : 'Stock Qty'} />
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted uppercase tracking-wide">Measure/Qty</label>
                          <input type="number" min="0.0001" step="0.0001" value={rmEditForm.unitSize} onChange={e => setRmEditForm(f => ({ ...f, unitSize: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-accent rounded-lg text-sm text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted uppercase tracking-wide">Image</label>
                          <input type="file" accept="image/*" onChange={e => { const file = e.target.files?.[0]; if (file) setRmEditImages([file]); e.target.value = '' }} className="w-full text-xs text-muted" />
                          {rmEditImages.length > 0 && <p className="text-[10px] text-muted mt-1">{rmEditImages[0].name}</p>}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleUpdateRawMaterial(rm.id)} disabled={submitting} className="touch-target flex-1 justify-center rounded-lg bg-emerald-600 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1.5"><Save className="w-4 h-4" /> Save</button>
                        <button onClick={() => { setEditingRmId(null); setRmEditImages([]) }} className="touch-target px-4 rounded-lg bg-surface border border-border text-sm text-muted flex items-center justify-center">Cancel</button>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={rm.id} className={`p-4 ${selectedRmIds.has(rm.id) ? 'bg-accent/10' : ''}`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedRmIds.has(rm.id)}
                        onChange={e => {
                          const newSet = new Set(selectedRmIds)
                          if (e.target.checked) newSet.add(rm.id); else newSet.delete(rm.id)
                          setSelectedRmIds(newSet)
                        }}
                        className="w-5 h-5 mt-0.5 rounded border-border bg-surface text-accent focus:ring-accent/50 cursor-pointer flex-shrink-0" />
                      {rm.image ? (
                        <img src={rm.image} alt={rm.name} className="w-12 h-12 rounded-lg object-cover border border-border flex-shrink-0" />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-surface-hover border border-border flex items-center justify-center flex-shrink-0"><Package className="w-5 h-5 text-muted" /></div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-foreground font-medium text-sm truncate">{rm.name}</p>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${isLow ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{isLow ? '⚠ Low' : '✓ In Stock'}</span>
                        </div>
                        <p className="text-accent font-mono text-[11px] font-semibold">{rm.sku}</p>
                        {rm.brand && <p className="text-[11px] text-muted">Brand: {rm.brand}</p>}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-3 text-[11px]">
                      <span className="text-muted">Size: <span className="text-foreground">{rm.description || '—'}</span></span>
                      <span className="text-muted">Cost: <span className="text-foreground">₹{rm.costPrice?.toLocaleString('en-IN') || 0}</span></span>
                      <span className="text-muted">Stock: <span className={isLow ? 'text-red-400 font-semibold' : 'text-emerald-400 font-semibold'}>{stockQtyLabel}</span> <span className="text-muted">({stockMeasureLabel} {rm.unitOfMeasure})</span></span>
                      <span className="text-muted">Min: <span className="text-foreground">{rm.reorderLevel}</span></span>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => {
                          setEditingRmId(rm.id)
                          setRmEditForm({
                            name: rm.name,
                            brand: rm.brand || '',
                            stockQuantity: ((Number(rm.stock) || 0) / (Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1)).toFixed(2),
                            currentStockQuantity: (Number(rm.stock) || 0) / (Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1),
                            stockAction: 'SET',
                            unitSize: Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1,
                            unitOfMeasure: rm.unitOfMeasure || 'PCS',
                            reorderLevel: rm.reorderLevel,
                            description: rm.description || '',
                            image: rm.image || '',
                          })
                          setRmEditImages([])
                        }}
                        className="touch-target flex-1 justify-center rounded-lg bg-surface border border-border text-sm text-muted hover:text-accent flex items-center gap-1.5"><Edit2 className="w-4 h-4" /> Edit</button>
                      <button onClick={() => handleDeleteRawMaterial(rm.id, rm.name)} disabled={submitting} className="touch-target px-4 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400 hover:bg-red-500/20 flex items-center justify-center gap-1.5 disabled:opacity-50"><Trash2 className="w-4 h-4" /> Delete</button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="overflow-x-auto hidden md:block">
              <table className="w-full text-sm min-w-[1000px]">
                <thead>
                  <tr className="border-b border-border bg-surface-hover">
                    <th className="px-4 py-3 text-left text-xs text-muted font-semibold uppercase tracking-wide">
                      <input
                        type="checkbox"
                        checked={selectedRmIds.size > 0 && selectedRmIds.size === rawMaterials.length}
                        onChange={e => {
                          if (e.target.checked) {
                            setSelectedRmIds(new Set(rawMaterials.map(rm => rm.id)))
                          } else {
                            setSelectedRmIds(new Set())
                          }
                        }}
                        className="w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent/50 cursor-pointer" />
                    </th>
                    {['Material Name', 'Image', 'Size', 'SKU Code', 'Cost Price (₹)', 'Stock Qty', 'UoM', 'Min. Alert', 'Measure/Qty', 'Status', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs text-muted font-semibold uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rawMaterials.length === 0 && (
                    <tr>
                      <td colSpan={13} className="text-center py-12 text-muted">
                        {rmSearch ? 'No materials match your search' : 'No raw materials yet. Add one above to get started.'}
                      </td>
                    </tr>
                  )}
                  {rawMaterials.map(rm => (
                    <tr key={rm.id} className={`border-b border-border/50 hover:bg-surface-hover/50 ${selectedRmIds.has(rm.id) ? 'bg-accent/10' : ''}`}>
                      {editingRmId === rm.id ? (
                        <>
                          <td className="px-4 py-3"></td>
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <input value={rmEditForm.name} onChange={e => setRmEditForm(f => ({ ...f, name: e.target.value }))}
                                className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                              <input value={rmEditForm.brand || ''} onChange={e => setRmEditForm(f => ({ ...f, brand: e.target.value }))}
                                className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" placeholder="Brand" />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <input
                              type="file"
                              accept="image/*"
                              onChange={e => {
                                const file = e.target.files?.[0]
                                if (file) setRmEditImages([file])
                                e.target.value = ''
                              }}
                              className="w-36 text-[10px] text-muted" />
                            {rmEditImages.length > 0 && (
                              <p className="text-[10px] text-muted mt-1">{rmEditImages[0].name}</p>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <input value={rmEditForm.description || ''} onChange={e => setRmEditForm(f => ({ ...f, description: e.target.value }))}
                              className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" placeholder="e.g. 1 inch (square)" />
                          </td>
                          <td className="px-4 py-3 text-muted font-mono text-xs">{rm.sku}</td>
                          <td className="px-4 py-3 text-muted text-xs">₹{rm.costPrice}</td>
                          <td className="px-4 py-3">
                            {(() => {
                              const unitSize = Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1
                              const currentQty = (Number(rm.stock) || 0) / unitSize
                              const currentQtyLabel = Number.isInteger(currentQty) ? String(currentQty) : currentQty.toFixed(2)
                              return (
                                <div className="space-y-1">
                                  <p className="text-[10px] text-muted">Current: {currentQtyLabel}</p>
                                  <select
                                    value={rmEditForm.stockAction || 'SET'}
                                    onChange={e => setRmEditForm(f => ({ ...f, stockAction: e.target.value }))}
                                    className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-[10px] text-foreground">
                                    <option value="SET">Set Stock</option>
                                    <option value="ADD">Add Stock</option>
                                  </select>
                                  <input
                                    type="number"
                                    min="0"
                                    value={rmEditForm.stockQuantity}
                                    onChange={e => setRmEditForm(f => ({ ...f, stockQuantity: e.target.value, currentStockQuantity: currentQty }))}
                                    className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground"
                                    placeholder={rmEditForm.stockAction === 'ADD' ? 'Add Qty' : 'Stock Qty'} />
                                </div>
                              )
                            })()}
                          </td>
                          <td className="px-4 py-3 text-muted text-xs">
                            <select
                              value={rmEditForm.unitOfMeasure || rm.unitOfMeasure || 'PCS'}
                              onChange={e => setRmEditForm(f => ({ ...f, unitOfMeasure: e.target.value }))}
                              className="w-20 px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground">
                              <option value="PCS">PCS</option>
                              <option value="BOX">BOX</option>
                              <option value="KG">KG</option>
                              <option value="G">G</option>
                              <option value="MTR">MTR</option>
                              <option value="FT">FT</option>
                              <option value="INCH">INCH</option>
                            </select>
                          </td>
                          <td className="px-4 py-3">
                            <input type="number" min="0" value={rmEditForm.reorderLevel} onChange={e => setRmEditForm(f => ({ ...f, reorderLevel: e.target.value }))}
                              className="w-16 px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                          </td>
                          <td className="px-4 py-3 text-muted text-xs">
                            <input type="number" min="0.0001" step="0.0001" value={rmEditForm.unitSize} onChange={e => setRmEditForm(f => ({ ...f, unitSize: e.target.value }))}
                              className="w-16 px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                          </td>
                          <td className="px-4 py-3"></td>
                          <td className="px-4 py-3">
                            <div className="flex gap-1.5">
                              <button onClick={() => handleUpdateRawMaterial(rm.id)} disabled={submitting}
                                className="px-2.5 py-1 rounded-md bg-emerald-600 text-white text-xs font-medium disabled:opacity-50 flex items-center gap-1">
                                <Save className="w-3 h-3" /> Save
                              </button>
                              <button onClick={() => { setEditingRmId(null); setRmEditImages([]) }}
                                className="px-2.5 py-1 rounded-md bg-surface border border-border text-xs text-muted">
                                Cancel
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedRmIds.has(rm.id)}
                              onChange={e => {
                                const newSet = new Set(selectedRmIds)
                                if (e.target.checked) {
                                  newSet.add(rm.id)
                                } else {
                                  newSet.delete(rm.id)
                                }
                                setSelectedRmIds(newSet)
                              }}
                              className="w-4 h-4 rounded border-border bg-surface text-accent focus:ring-accent/50 cursor-pointer" />
                          </td>
                          {(() => {
                            const unitSize = Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1
                            const stockQty = (Number(rm.stock) || 0) / unitSize
                            const isLow = stockQty <= (Number(rm.reorderLevel) || 0)
                            const stockQtyLabel = Number.isInteger(stockQty) ? String(stockQty) : stockQty.toFixed(2)
                            const stockMeasureLabel = Number.isInteger(Number(rm.stock) || 0) ? String(Number(rm.stock) || 0) : Number(rm.stock || 0).toFixed(2)
                            return (
                              <>
                                <td className="px-4 py-3 text-foreground font-medium">
                                  <div>{rm.name}</div>
                                  {rm.brand && <p className="text-[10px] text-muted mt-0.5">Brand: {rm.brand}</p>}
                                </td>
                                <td className="px-4 py-3">
                                  {rm.image ? (
                                    <img src={rm.image} alt={rm.name} className="w-8 h-8 rounded object-cover border border-border" />
                                  ) : (
                                    <span className="text-muted text-xs">None</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-muted text-xs">
                                  {rm.description || '—'}
                                </td>
                                <td className="px-4 py-3 text-accent font-mono text-xs font-semibold">{rm.sku}</td>
                                <td className="px-4 py-3 text-foreground">₹{rm.costPrice?.toLocaleString('en-IN') || 0}</td>
                                <td className="px-4 py-3">
                                  <span className={isLow ? 'text-red-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                                    {stockQtyLabel}
                                  </span>
                                  <p className="text-[10px] text-muted">{stockMeasureLabel} {rm.unitOfMeasure}</p>
                                </td>
                                <td className="px-4 py-3 text-muted">{rm.unitOfMeasure}</td>
                                <td className="px-4 py-3 text-muted">{rm.reorderLevel}</td>
                                <td className="px-4 py-3 text-muted text-xs">{unitSize}</td>
                                <td className="px-4 py-3">
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${isLow ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                                    {isLow ? '⚠ Low Stock' : '✓ In Stock'}
                                  </span>
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex gap-1.5">
                                    <button
                                      onClick={() => {
                                        setEditingRmId(rm.id)
                                        setRmEditForm({
                                          name: rm.name,
                                          brand: rm.brand || '',
                                          stockQuantity: ((Number(rm.stock) || 0) / (Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1)).toFixed(2),
                                          currentStockQuantity: (Number(rm.stock) || 0) / (Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1),
                                          stockAction: 'SET',
                                          unitSize: Number(rm.unitSize) > 0 ? Number(rm.unitSize) : 1,
                                          unitOfMeasure: rm.unitOfMeasure || 'PCS',
                                          reorderLevel: rm.reorderLevel,
                                          description: rm.description || '',
                                          image: rm.image || '',
                                        })
                                        setRmEditImages([])
                                      }}
                                      className="px-2.5 py-1 rounded-md bg-surface border border-border text-xs text-muted hover:text-accent hover:border-accent/50 transition-colors flex items-center gap-1">
                                      <Edit2 className="w-3 h-3" /> Edit
                                    </button>
                                    <button
                                      onClick={() => handleDeleteRawMaterial(rm.id, rm.name)}
                                      disabled={submitting}
                                      className="px-2.5 py-1 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400 hover:bg-red-500/20 transition-colors flex items-center gap-1 disabled:opacity-50">
                                      <Trash2 className="w-3 h-3" /> Delete
                                    </button>
                                  </div>
                                </td>
                              </>
                            )
                          })()}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <Modal isOpen={showOffcutModal} onClose={() => !offcutSaving && setShowOffcutModal(false)} title="Record Stone Offcut" size="sm">
        <div className="space-y-4">
          <p className="text-xs text-muted">Choose a fabrication or sold slab and enter the usable remnant dimensions. The offcut will be tracked in sq.ft with its source lot and slab.</p>
          <div><label className="text-xs text-muted mb-1 block">Source slab *</label><select value={offcutForm.sourceSlabId} onChange={e => setOffcutForm(f => ({ ...f, sourceSlabId: e.target.value }))} className={SEL}><option value="">Select source slab</option>{offcutLots.flatMap(lot => lot.slabs.filter(s => ['IN_PROCESSING', 'SOLD'].includes(s.status)).map(slab => <option key={slab.id} value={slab.id}>{lot.product.name} · Lot {lot.lotNumber} · Slab {slab.slabNumber} ({slab.status})</option>))}</select></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-muted mb-1 block">Length (inches) *</label><input type="number" min="0.1" step="0.01" value={offcutForm.lengthInches} onChange={e => setOffcutForm(f => ({ ...f, lengthInches: e.target.value }))} className={INP} placeholder="e.g. 36" /></div>
            <div><label className="text-xs text-muted mb-1 block">Width (inches) *</label><input type="number" min="0.1" step="0.01" value={offcutForm.widthInches} onChange={e => setOffcutForm(f => ({ ...f, widthInches: e.target.value }))} className={INP} placeholder="e.g. 18" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-muted mb-1 block">Shade code</label><input value={offcutForm.shadeCode} onChange={e => setOffcutForm(f => ({ ...f, shadeCode: e.target.value }))} className={INP} placeholder="Optional" /></div>
            <div><label className="text-xs text-muted mb-1 block">Resale price (₹)</label><input type="number" min="0" step="1" value={offcutForm.salePrice} onChange={e => setOffcutForm(f => ({ ...f, salePrice: e.target.value }))} className={INP} placeholder="Optional" /></div>
          </div>
          <div><label className="text-xs text-muted mb-1 block">Notes</label><textarea rows={2} value={offcutForm.notes} onChange={e => setOffcutForm(f => ({ ...f, notes: e.target.value }))} className={INP} placeholder="Finish, edge condition, or resale notes" /></div>
          <div className="flex justify-end gap-2 pt-2"><button onClick={() => setShowOffcutModal(false)} className="px-4 py-2 text-sm text-muted">Cancel</button><button onClick={handleCreateOffcut} disabled={offcutSaving || !offcutForm.sourceSlabId || !offcutForm.lengthInches || !offcutForm.widthInches} className="px-4 py-2 bg-accent text-white rounded-lg text-sm disabled:opacity-50">{offcutSaving ? 'Saving...' : 'Save Offcut'}</button></div>
        </div>
      </Modal>

      <Modal isOpen={showRmImportModal} onClose={() => setShowRmImportModal(false)} title="Import Raw Materials" size="lg" fullScreenMobile>
        <div className="space-y-4">
          <div className="p-3 rounded-lg border border-border bg-surface-hover text-xs text-muted space-y-1">
            <p>Supported files: .xlsx, .xls, .csv</p>
            <p>Required columns: PRODUCT NAME, Instock</p>
            <p>Optional columns: SIZE, brand, SKU, Cost price</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleRmImportFileUpload}
              className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
            <button
              onClick={downloadRawMaterialTemplate}
              className="px-3 py-2 bg-surface border border-border rounded-lg text-xs text-muted hover:text-foreground flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Download Template
            </button>
          </div>

          {rmImportError && (
            <p className="text-xs text-red-400">{rmImportError}</p>
          )}

          {rmImportHeaders.length > 0 && (
            <div className="text-xs text-muted">
              <p className="mb-2">Detected columns: {rmImportHeaders.join(', ')}</p>
              <p>Rows ready to import: <span className="text-foreground font-semibold">{rmImportRows.length}</span></p>
            </div>
          )}

          {rmImportResult && (
            <div className="p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-xs text-emerald-300">
              Imported {rmImportResult.created} of {rmImportResult.total} rows. Skipped: {rmImportResult.skipped}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setShowRmImportModal(false)}
              className="px-4 py-2 rounded-lg text-sm text-muted hover:text-foreground">
              Close
            </button>
            <button
              onClick={handleRmImportSubmit}
              disabled={rmImportLoading || rmImportRows.length === 0}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {rmImportLoading ? 'Importing...' : 'Import Now'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showBulkDeleteModal} onClose={() => !bulkDeleting && setShowBulkDeleteModal(false)} title="Delete Raw Materials" size="sm">
        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
            <p className="text-sm text-red-400">
              Are you sure you want to delete <span className="font-semibold">{selectedRmIds.size}</span> raw material{selectedRmIds.size !== 1 ? 's' : ''}?
            </p>
            <p className="text-xs text-red-400/70 mt-2">This action cannot be undone. Materials used in BOMs or production orders cannot be deleted.</p>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowBulkDeleteModal(false)}
              disabled={bulkDeleting}
              className="px-4 py-2 rounded-lg text-sm text-muted hover:text-foreground disabled:opacity-50">
              Cancel
            </button>
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2">
              <Trash2 className="w-4 h-4" />
              {bulkDeleting ? 'Deleting...' : 'Delete All'}
            </button>
          </div>
        </div>
      </Modal>

      {/* ─── MODALS ─────────────────────────────────── */}

      {/* Production Order Detail */}
      <Modal isOpen={showDetailModal} onClose={() => setShowDetailModal(false)} title={`${selectedOrder?.displayId} — Details`} size="lg" fullScreenMobile>
        {selectedOrder && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ['BOM', `${selectedOrder.bom?.name} v${selectedOrder.bom?.version}`],
                ['Product', selectedOrder.finishedProduct?.name],
                ['Priority', selectedOrder.priority],
                ['Status', selectedOrder.status?.replace(/_/g, ' ')],
                ['Planned Qty', selectedOrder.plannedQty],
                ['Actual Qty', selectedOrder.actualQty ?? 0],
                ['Std Time', `${selectedOrder.standardMins || 0} min`],
                ['Actual Time', `${selectedOrder.actualMins || 0} min`],
                ['Time Variance', `${selectedOrder.labourVarianceMins > 0 ? '+' : ''}${selectedOrder.labourVarianceMins || 0} min`],
                ['Extra Labour Cost', `₹${(selectedOrder.labourVarianceCost || 0).toLocaleString('en-IN')}`],
                ['Yield Rate', selectedOrder.yieldRate ? `${selectedOrder.yieldRate.toFixed(1)}%` : '0%'],
                ['Quality', selectedOrder.qualityStatus],
                ['Scrap Qty', selectedOrder.scrapQty || 0],
                ['Custom Order', selectedOrder.customOrder ? `${selectedOrder.customOrder.displayId} · ${selectedOrder.customOrder.contact?.name}` : '—'],
                ['Assigned To', selectedOrder.assignedStaff?.name || selectedOrder.assignedTo || '—'],
                ['Work Center', selectedOrder.workCenter?.name || '—'],
                ['Due Date', selectedOrder.dueDate ? new Date(selectedOrder.dueDate).toLocaleDateString('en-IN') : '—'],
              ].map(([l, v]) => (
                <div key={l} className="bg-surface-hover p-2.5 rounded-lg">
                  <p className="text-[10px] text-muted uppercase">{l}</p>
                  <p className="text-sm text-foreground font-medium mt-0.5">{v}</p>
                </div>
              ))}
            </div>

            {selectedOrder.productionSteps?.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-foreground mb-2">Routing Steps</h4>
                <div className="space-y-2">
                  {selectedOrder.productionSteps.map((s, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 bg-surface-hover rounded-lg text-sm flex-wrap">
                      <span className="w-6 h-6 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xs font-bold flex-shrink-0">{s.stepNumber}</span>
                      <span className="flex-1 text-foreground min-w-[100px]">{s.operationName}</span>
                      <span className="text-muted text-xs">{s.workCenter?.name || '—'}</span>
                      <span className="text-muted text-xs">{s.plannedMins}min</span>
                      {s.actualMins > 0 && <span className={`text-xs ${s.actualMins > s.plannedMins ? 'text-red-400' : 'text-emerald-400'}`}>Actual {s.actualMins}min</span>}
                      {['PLANNED', 'IN_PROGRESS', 'COMPLETED'].includes(selectedOrder.status) && s.status !== 'DONE' && (
                        <div className="flex gap-1">
                          {s.status === 'PENDING' && (
                            <button onClick={async () => { await updateProductionStep(s.id, 'IN_PROGRESS'); loadData(); setSelectedOrder(prev => ({ ...prev, productionSteps: prev.productionSteps.map(x => x.id === s.id ? { ...x, status: 'IN_PROGRESS' } : x) })) }} className="px-2 py-0.5 text-[10px] bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 rounded">Start</button>
                          )}
                          {s.status === 'IN_PROGRESS' && (
                            <button onClick={async () => { await updateProductionStep(s.id, 'DONE'); loadData(); setSelectedOrder(prev => ({ ...prev, productionSteps: prev.productionSteps.map(x => x.id === s.id ? { ...x, status: 'DONE' } : x) })) }} className="px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 rounded">Done</button>
                          )}
                        </div>
                      )}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${s.status === 'DONE' ? 'bg-emerald-500/10 text-emerald-400' : s.status === 'IN_PROGRESS' ? 'bg-blue-500/10 text-blue-400' : 'bg-gray-500/10 text-gray-400'}`}>{s.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedOrder.status === 'COMPLETED' && (
              <div className="grid grid-cols-4 gap-2">
                {[
                  ['Material', selectedOrder.totalMaterialCost],
                  ['Labour', selectedOrder.totalLabourCost],
                  ['Machine', selectedOrder.machineCost],
                  ['Other Expenses', selectedOrder.overheadCost],
                  ['Total', selectedOrder.totalCost],
                ].map(([l, v]) => (
                  <div key={l} className="bg-surface-hover p-2.5 rounded-lg">
                    <p className="text-[10px] text-muted">{l}</p>
                    <p className="text-sm font-bold text-foreground">₹{(v || 0).toLocaleString('en-IN')}</p>
                  </div>
                ))}
              </div>
            )}

            {selectedOrder.cancelReason && (
              <div className="p-3 bg-red-500/10 rounded-lg text-sm text-red-400">
                Cancel reason: {selectedOrder.cancelReason}
              </div>
            )}
            {selectedOrder.notes && <p className="text-xs text-muted">Notes: {selectedOrder.notes}</p>}
          </div>
        )}
      </Modal>

      {/* Delete Production Order */}
      <Modal isOpen={showDeleteProdModal} onClose={() => { setShowDeleteProdModal(false); setDeleteProdTarget(null) }} title="Delete Production Order">
        <div className="space-y-4">
          <div className="p-4 bg-red-500/10 rounded-lg border border-red-500/20">
            <p className="text-sm text-red-400 font-medium">⚠ This action cannot be undone</p>
            <p className="text-xs text-muted mt-1">Permanently delete order <span className="font-semibold text-foreground">{deleteProdTarget?.displayId}</span>?</p>
          </div>
          <div className="flex gap-3">
            <button onClick={() => { setShowDeleteProdModal(false); setDeleteProdTarget(null) }} className="flex-1 py-2 border border-border text-muted rounded-lg text-sm hover:text-foreground">Cancel</button>
            <button onClick={handleDeleteProd} disabled={submitting} className="flex-1 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-600/90 disabled:opacity-50">
              {submitting ? 'Deleting...' : 'Delete Order'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Create BOM Modal */}
      <Modal isOpen={showBOMModal} onClose={() => setShowBOMModal(false)} title="Create Bill of Materials" size="lg" fullScreenMobile>
        <div className="space-y-4">
          {/* Template Loader */}
          {templates.length > 0 && (
            <div className="p-3 bg-accent/5 border border-accent/20 rounded-lg">
              <label className="text-xs font-medium text-accent mb-1.5 block flex items-center gap-1"><FileText className="w-3.5 h-3.5" /> Load Steps from Template</label>
              <select value={bomForm.templateId} onChange={e => { setBomForm(f => ({ ...f, templateId: e.target.value })); applyTemplate(e.target.value) }} className={SEL}>
                <option value="">— Select a template to auto-fill steps —</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">BOM Name *</label>
              <input value={bomForm.name} onChange={e => setBomForm(p => ({ ...p, name: e.target.value }))} className={INP} placeholder={IS_TGM ? 'e.g. Kitchen Platform Fabrication BOM' : 'e.g. Sofa Set BOM'} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Finished Product *</label>
              <div className="relative">
                <input
                  type="text"
                  value={showFinishedProductPicker ? finishedProductSearch : (selectedFinishedProduct ? `${selectedFinishedProduct.name} (${selectedFinishedProduct.sku})` : '')}
                  onFocus={() => {
                    setShowFinishedProductPicker(true)
                    setFinishedProductSearch('')
                  }}
                  onChange={e => {
                    setShowFinishedProductPicker(true)
                    setFinishedProductSearch(e.target.value)
                  }}
                  onBlur={() => setTimeout(() => setShowFinishedProductPicker(false), 150)}
                  className={INP}
                  placeholder="Search finished products by name or SKU..."
                />
                {showFinishedProductPicker && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-50 max-h-56 overflow-y-auto">
                    {filteredFinishedProducts.length > 0 ? filteredFinishedProducts.map(p => (
                      <button
                        key={p.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setBomForm(prev => ({ ...prev, finishedProductId: String(p.id) }))
                          setShowFinishedProductPicker(false)
                          setFinishedProductSearch('')
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-accent/10 border-b border-border/30 last:border-0"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-md bg-surface-hover overflow-hidden flex items-center justify-center flex-shrink-0">
                            {getPrimaryImage(p.image) ? (
                              <img src={getPrimaryImage(p.image)} alt={p.name} className="w-full h-full object-cover" />
                            ) : (
                              <Package className="w-4 h-4 text-muted/40" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-foreground truncate">{p.name}</div>
                            <div className="text-[10px] text-muted">SKU: {p.sku}</div>
                          </div>
                        </div>
                      </button>
                    )) : (
                      <div className="px-3 py-2 text-xs text-muted">No finished products found</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Version</label>
              <input value={bomForm.version} onChange={e => setBomForm(p => ({ ...p, version: e.target.value }))} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Estimated Days</label>
              <input type="number" min="1" value={bomForm.estimatedDays} onChange={e => setBomForm(p => ({ ...p, estimatedDays: e.target.value }))} className={INP} placeholder="e.g. 5" />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted mb-1 block">Notes</label>
              <input value={bomForm.notes} onChange={e => setBomForm(p => ({ ...p, notes: e.target.value }))} className={INP} />
            </div>
          </div>

          {/* Raw Materials */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted uppercase tracking-wide">Raw Materials *</label>
              <button onClick={() => setBomForm(f => ({ ...f, items: [...f.items, { rawMaterialId: '', quantity: 1, unitOfMeasure: 'PCS', wastagePercent: 0, unitCost: 0, notes: '' }] }))} className="text-xs text-accent hover:underline">+ Add</button>
            </div>
            <div className="space-y-3">
              {bomForm.items.map((item, i) => (
                <div key={i} className="p-3 bg-surface-hover rounded-lg border border-border/60">
                  {/* Row 1: Material + delete */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex-1 relative">
                      <label className="text-[10px] text-muted block mb-0.5">Material (Search by name or SKU)</label>
                      <div className="relative">
                        <input
                          type="text"
                          placeholder="Type material name or SKU..."
                          value={bomItemSearch[i] || ''}
                          onFocus={() => setActiveBomItemPicker(i)}
                          onBlur={() => setTimeout(() => setActiveBomItemPicker(prev => (prev === i ? null : prev)), 150)}
                          onChange={e => {
                            setActiveBomItemPicker(i)
                            setBomItemSearch(s => ({ ...s, [i]: e.target.value }))
                          }}
                          className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                        />
                        {activeBomItemPicker === i && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                            {(() => {
                              const search = (bomItemSearch[i] || '').toLowerCase()
                              const filtered = rawMaterialOptions.filter(p =>
                                (p.name.toLowerCase().includes(search) || p.sku.toLowerCase().includes(search))
                              )
                              return filtered.length > 0 ? (
                                filtered.map(p => (
                                  <button
                                    key={p.id}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      const v = [...bomForm.items]
                                      v[i].rawMaterialId = p.id
                                      if (p.unitOfMeasure) v[i].unitOfMeasure = p.unitOfMeasure
                                      if (p.costPrice) v[i].unitCost = p.costPrice
                                      setBomForm(f => ({ ...f, items: v }))
                                      setBomItemSearch(s => ({ ...s, [i]: '' }))
                                      setActiveBomItemPicker(null)
                                    }}
                                    className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-accent/10 border-b border-border/30 last:border-0">
                                    <div className="flex items-center gap-2.5">
                                      <div className="w-8 h-8 rounded-md bg-surface-hover overflow-hidden flex items-center justify-center flex-shrink-0">
                                        {getPrimaryImage(p.image) ? (
                                          <img src={getPrimaryImage(p.image)} alt={p.name} className="w-full h-full object-cover" />
                                        ) : (
                                          <Package className="w-4 h-4 text-muted/40" />
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="font-medium truncate">{p.name}</div>
                                        <div className="text-muted text-[10px]">SKU: {p.sku} • UOM: {p.unitOfMeasure}</div>
                                      </div>
                                    </div>
                                  </button>
                                ))
                              ) : (
                                <div className="px-3 py-2 text-xs text-muted">No materials found</div>
                              )
                            })()}
                          </div>
                        )}
                        {item.rawMaterialId && !bomItemSearch[i] && (() => {
                          const selectedMaterial = rawMaterialOptions.find(p => String(p.id) === String(item.rawMaterialId))
                          return selectedMaterial ? (
                            <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                              <div className="w-6 h-6 rounded bg-surface-hover overflow-hidden flex items-center justify-center flex-shrink-0">
                                {getPrimaryImage(selectedMaterial.image) ? (
                                  <img src={getPrimaryImage(selectedMaterial.image)} alt={selectedMaterial.name} className="w-full h-full object-cover" />
                                ) : (
                                  <Package className="w-3.5 h-3.5 text-muted/40" />
                                )}
                              </div>
                              <span>Selected: {selectedMaterial.name} ({selectedMaterial.sku})</span>
                            </div>
                          ) : null
                        })()}
                      </div>
                    </div>
                    <button onClick={() => {
                      setBomForm(f => ({ ...f, items: f.items.filter((_, j) => j !== i) }))
                      setBomItemSearch(s => ({ ...s, [i]: '' }))
                    }}
                      className="mt-4 p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded">×</button>
                  </div>
                  {/* Row 2: Qty + UoM + Wastage */}
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5">Quantity</label>
                      <input type="number" min="0.001" step="0.001" value={item.quantity}
                        onChange={e => { const v = [...bomForm.items]; v[i].quantity = e.target.value; setBomForm(f => ({ ...f, items: v })) }}
                        className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground" />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5">Unit of Measure</label>
                      <select value={item.unitOfMeasure}
                        onChange={e => { const v = [...bomForm.items]; v[i].unitOfMeasure = e.target.value; setBomForm(f => ({ ...f, items: v })) }}
                        className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground">
                        <option value="PCS">PCS – Pieces</option>
                        <option value="KG">KG – Kilograms</option>
                        <option value="MTR">MTR – Meters</option>
                        <option value="SFT">SFT – Sq. Feet</option>
                        <option value="LTR">LTR – Litres</option>
                        <option value="SET">SET</option>
                        <option value="BOX">BOX</option>
                        <option value="NOS">NOS – Numbers</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5">Wastage %</label>
                      <input type="number" min="0" max="100" value={item.wastagePercent}
                        onChange={e => { const v = [...bomForm.items]; v[i].wastagePercent = e.target.value; setBomForm(f => ({ ...f, items: v })) }}
                        className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground" />
                      <p className="text-[9px] text-muted mt-0.5">Planning allowance</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Live Manufacturing Cost Summary ── */}
          {bomForm.items.some(i => i.rawMaterialId) && (() => {
            const allProducts = products
            const matCost = bomForm.items.reduce((sum, item) => {
              if (!item.rawMaterialId) return sum
              const prod = allProducts.find(p => String(p.id) === String(item.rawMaterialId))
              const uc = Number(item.unitCost) > 0 ? Number(item.unitCost) : (prod?.costPrice ?? prod?.price ?? 0)
              const qty = Number(item.quantity) * (1 + (Number(item.wastagePercent) || 0) / 100)
              return sum + uc * qty
            }, 0)
            const stepCost = bomForm.steps.reduce((sum, s) => {
              return sum + ((Number(s.durationMins) / 60) * Number(s.labourRatePerHour || 0)) + Number(s.machineCostPerUnit || 0)
            }, 0)
            const stdTime = bomForm.steps.reduce((sum, s) => sum + (Number(s.durationMins) || 0), 0)
            const totalMfg = matCost + stepCost
            const selProd = products.find(p => String(p.id) === String(bomForm.finishedProductId))
            const sellingPrice = selProd?.price ?? 0
            const margin = sellingPrice > 0 ? sellingPrice - totalMfg : null
            return (
              <div className="p-3 rounded-xl bg-surface-hover border border-border">
                <p className="text-[10px] text-muted uppercase tracking-wide font-semibold mb-2">Manufacturing Cost Estimate</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <div className="p-2 rounded-lg bg-surface text-center">
                    <p className="text-[10px] text-muted mb-0.5">Std Time</p>
                    <p className="text-sm font-bold text-cyan-400">{stdTime} min</p>
                  </div>
                  <div className="p-2 rounded-lg bg-surface text-center">
                    <p className="text-[10px] text-muted mb-0.5">Material Cost</p>
                    <p className="text-sm font-bold text-blue-400">₹{matCost.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-surface text-center">
                    <p className="text-[10px] text-muted mb-0.5">Labour + Machine</p>
                    <p className="text-sm font-bold text-orange-400">₹{stepCost.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-accent/10 text-center">
                    <p className="text-[10px] text-muted mb-0.5">Total Mfg Cost</p>
                    <p className="text-sm font-bold text-accent">₹{totalMfg.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                  </div>
                  <div className={`p-2 rounded-lg text-center ${margin === null ? 'bg-surface' : margin >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                    <p className="text-[10px] text-muted mb-0.5">{sellingPrice > 0 ? 'Est. Margin' : 'Selling Price'}</p>
                    {sellingPrice > 0 ? (
                      <p className={`text-sm font-bold ${margin >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        ₹{(margin ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        <span className="text-[10px] ml-1">({((margin / sellingPrice) * 100).toFixed(1)}%)</span>
                      </p>
                    ) : (
                      <p className="text-sm text-muted">—</p>
                    )}
                  </div>
                </div>
                {sellingPrice > 0 && <p className="text-[10px] text-muted mt-1.5">Selling Price: ₹{sellingPrice.toLocaleString('en-IN')} &nbsp;|&nbsp; Material: ₹{matCost.toFixed(0)} + Steps: ₹{stepCost.toFixed(0)}</p>}
              </div>
            )
          })()}

          {/* Routing Steps with Job Costing */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted uppercase tracking-wide">Manufacturing Steps & Job Costing</label>
              <button onClick={() => setBomForm(f => ({ ...f, steps: [...f.steps, { operationName: '', workCenterId: '', durationMins: 60, labourRatePerHour: 0, machineCostPerUnit: 0, notes: '' }] }))} className="text-xs text-accent hover:underline">+ Add Step</button>
            </div>
            {bomForm.steps.length === 0 && <p className="text-xs text-muted">Optional: define step-by-step operations with job costing (Cut → Polish → QC)</p>}
            <div className="space-y-2">
              {bomForm.steps.map((step, i) => (
                <div key={i} className="p-3 bg-surface-hover rounded-lg border border-border/50">
                  <div className="grid grid-cols-12 gap-2 items-center mb-2">
                    <span className="col-span-1 text-xs text-muted text-center font-bold">{i + 1}</span>
                    <input value={step.operationName} onChange={e => { const v = [...bomForm.steps]; v[i].operationName = e.target.value; setBomForm(f => ({ ...f, steps: v })) }} placeholder="Operation name" className="col-span-5 px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                    <select value={step.workCenterId} onChange={e => { const v = [...bomForm.steps]; v[i].workCenterId = e.target.value; setBomForm(f => ({ ...f, steps: v })) }} className="col-span-4 px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground">
                      <option value="">Work Center</option>
                      {workCenters.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                    <button onClick={() => setBomForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} className="col-span-1 text-red-400 hover:text-red-300 text-base text-center">×</button>
                    <div className="col-span-1" />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5">Duration (min)</label>
                      <input type="number" min="0" value={step.durationMins} onChange={e => { const v = [...bomForm.steps]; v[i].durationMins = e.target.value; setBomForm(f => ({ ...f, steps: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> Labour ₹/hr</label>
                      <input type="number" min="0" value={step.labourRatePerHour} onChange={e => { const v = [...bomForm.steps]; v[i].labourRatePerHour = e.target.value; setBomForm(f => ({ ...f, steps: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                      <p className="text-[9px] text-muted mt-0.5">= ₹{((Number(step.durationMins) / 60) * Number(step.labourRatePerHour)).toFixed(2)}/unit</p>
                    </div>
                    <div>
                      <label className="text-[10px] text-muted block mb-0.5 flex items-center gap-1"><Zap className="w-3 h-3" /> Machine ₹/unit</label>
                      <input type="number" min="0" value={step.machineCostPerUnit} onChange={e => { const v = [...bomForm.steps]; v[i].machineCostPerUnit = e.target.value; setBomForm(f => ({ ...f, steps: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* Step cost summary */}
            {bomForm.steps.some(s => s.operationName) && (
              <div className="mt-2 p-2 bg-accent/5 border border-accent/20 rounded-lg text-xs">
                <span className="text-muted">Estimated step cost/unit: </span>
                <span className="text-accent font-semibold">
                  ₹{bomForm.steps.reduce((sum, s) => sum + ((Number(s.durationMins) / 60) * Number(s.labourRatePerHour)) + Number(s.machineCostPerUnit), 0).toFixed(2)}
                </span>
                <span className="text-muted ml-2">(Labour: ₹{bomForm.steps.reduce((sum, s) => sum + (Number(s.durationMins) / 60) * Number(s.labourRatePerHour), 0).toFixed(2)} + Machine: ₹{bomForm.steps.reduce((sum, s) => sum + Number(s.machineCostPerUnit), 0).toFixed(2)})</span>
              </div>
            )}
          </div>

          <button onClick={handleCreateBOM} disabled={submitting || !bomForm.name || !bomForm.finishedProductId || !bomForm.items.some(i => i.rawMaterialId)} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Bill of Materials'}
          </button>
        </div>
      </Modal>

      {/* Create Production Order Modal */}
      <Modal isOpen={showProdModal} onClose={() => setShowProdModal(false)} title="Create Production Order" size="lg" fullScreenMobile>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted mb-1 block">Bill of Materials *</label>
            <select value={prodForm.bomId} onChange={e => setProdForm(p => ({ ...p, bomId: e.target.value }))} className={SEL}>
              <option value="">Select BOM</option>
              {boms.filter(b => b.isActive).map(b => <option key={b.id} value={b.id}>{b.name} — {b.finishedProduct?.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Custom Order Inventory</label>
            <select value={prodForm.customOrderId} onChange={e => setProdForm(p => ({ ...p, customOrderId: e.target.value }))} className={SEL}>
              <option value="">Standard finished goods inventory</option>
              {customOrders.map(o => <option key={o.id} value={o.id}>{o.displayId} — {o.customerName} ({o.type})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">Planned Quantity *</label>
              <input type="number" min="1" value={prodForm.plannedQty} onChange={e => setProdForm(p => ({ ...p, plannedQty: e.target.value }))} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Priority</label>
              <select value={prodForm.priority} onChange={e => setProdForm(p => ({ ...p, priority: e.target.value }))} className={SEL}>
                {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Start Date</label>
              <input type="date" value={prodForm.startDate} onChange={e => setProdForm(p => ({ ...p, startDate: e.target.value }))} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Due Date</label>
              <input type="date" value={prodForm.dueDate} onChange={e => setProdForm(p => ({ ...p, dueDate: e.target.value }))} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Work Center</label>
              <select value={prodForm.workCenterId} onChange={e => setProdForm(p => ({ ...p, workCenterId: e.target.value }))} className={SEL}>
                <option value="">Select Work Center</option>
                {workCenters.filter(w => w.status === 'Active').map(w => <option key={w.id} value={w.id}>{w.name} ({w.type})</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Assign Staff</label>
              <select value={prodForm.assignedStaffId} onChange={e => setProdForm(p => ({ ...p, assignedStaffId: e.target.value }))} className={SEL}>
                <option value="">Unassigned</option>
                {staffOptions.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
              </select>
              {staffOptions.length === 0 && <p className="text-[10px] text-muted mt-1">No active staff available to assign.</p>}
            </div>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Notes</label>
            <textarea value={prodForm.notes} onChange={e => setProdForm(p => ({ ...p, notes: e.target.value }))} rows={2} className={INP} />
          </div>
          <button onClick={handleCreateProd} disabled={submitting || !prodForm.bomId || !prodForm.plannedQty} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Create Production Order'}
          </button>
        </div>
      </Modal>

      {/* Complete Production Modal */}
      <Modal isOpen={showCompleteModal} onClose={() => setShowCompleteModal(false)} title="Complete Production Order" size="lg" fullScreenMobile>
        <div className="space-y-4 md:max-h-[75vh] md:overflow-y-auto md:pr-1">

          {/* Qty + Scrap Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted mb-1 block">Actual Quantity Produced *</label>
              <input type="number" min="0" value={completeForm.actualQty} onChange={e => setCompleteForm(p => ({ ...p, actualQty: e.target.value }))} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Scrap Quantity (Defective Units)</label>
              <input type="number" min="0" value={completeForm.scrapQty} onChange={e => setCompleteForm(p => ({ ...p, scrapQty: e.target.value }))} className={INP} />
            </div>
          </div>

          {/* Good items info */}
          <div className="bg-blue-500/10 p-2.5 rounded-lg text-blue-700 text-xs border border-blue-500/20 flex items-center justify-between flex-wrap gap-2">
            <span><strong>Good Items → Inventory:</strong> {Math.max(0, Number(completeForm.actualQty) - Number(completeForm.scrapQty))}</span>
            <span className="text-[10px] text-muted">Planned: {selectedOrder?.plannedQty || '—'}</span>
          </div>

          {/* ── Cost Breakdown Section ── */}
          <div className="space-y-3 p-3 bg-surface-hover rounded-xl border border-border">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Production Cost Breakdown</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[11px] text-muted mb-1 block flex items-center gap-1"><Clock className="w-3 h-3" /> Labour Cost (₹)</label>
                <input type="number" min="0" value={completeForm.totalLabourCost} onChange={e => setCompleteForm(p => ({ ...p, totalLabourCost: e.target.value }))} className={INP} placeholder="Auto from steps" />
              </div>
              <div>
                <label className="text-[11px] text-muted mb-1 block flex items-center gap-1"><Zap className="w-3 h-3" /> Machine Cost (₹)</label>
                <input type="number" min="0" value={completeForm.machineCost} onChange={e => setCompleteForm(p => ({ ...p, machineCost: e.target.value }))} className={INP} placeholder="CNC, lathe, tools..." />
              </div>
              <div>
                <label className="text-[11px] text-muted mb-1 block flex items-center gap-1">💰 Other Expenses (₹)</label>
                <input type="number" min="0" value={completeForm.overheadCost} onChange={e => setCompleteForm(p => ({ ...p, overheadCost: e.target.value }))} placeholder="Transport, packing, electricity..." className={INP} />
              </div>
            </div>

            {/* Cost summary row */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-border/50 text-center">
              {[
                { label: 'Labour', value: Number(completeForm.totalLabourCost) || 0 },
                { label: 'Machine', value: Number(completeForm.machineCost) || 0 },
                { label: 'Other', value: Number(completeForm.overheadCost) || 0 },
                { label: 'Material', value: null },
                { label: 'Total Est.', value: (Number(completeForm.totalLabourCost) || 0) + (Number(completeForm.machineCost) || 0) + (Number(completeForm.overheadCost) || 0), highlight: true },
              ].map((c, i) => (
                <div key={i} className={c.highlight ? 'bg-accent/10 p-2 rounded-lg' : 'p-2'}>
                  <p className="text-[10px] text-muted">{c.label}</p>
                  <p className={`text-sm font-bold ${c.highlight ? 'text-accent' : 'text-foreground'}`}>
                    {c.value === null ? '(auto)' : `₹${c.value.toLocaleString('en-IN')}`}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Quality */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted mb-1 block">Quality Status</label>
              <select value={completeForm.qualityStatus} onChange={e => setCompleteForm(p => ({ ...p, qualityStatus: e.target.value }))} className={SEL}>
                <option value="PASSED">PASSED</option>
                <option value="PARTIAL">PARTIAL</option>
                <option value="FAILED">FAILED</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Quality Notes</label>
              <input value={completeForm.qualityNotes} onChange={e => setCompleteForm(p => ({ ...p, qualityNotes: e.target.value }))} className={INP} placeholder="Inspection notes..." />
            </div>
          </div>

          {/* Scrap reason - only show when scrap > 0 */}
          {Number(completeForm.scrapQty) > 0 && (
            <div>
              <label className="text-xs text-muted mb-1 block">Scrap Reason</label>
              <input value={completeForm.scrapReason} onChange={e => setCompleteForm(p => ({ ...p, scrapReason: e.target.value }))} placeholder="Why were units scrapped?" className={INP} />
            </div>
          )}

          {IS_TGM && selectedOrder?.customOrder?.slabAllocations?.length > 0 && (
            <div className="space-y-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">Reusable stone offcuts</h4>
                  <p className="text-[11px] text-muted mt-0.5">Record remnants now; source lot, shade and slab photo will stay traceable.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setCompleteForm(form => ({
                    ...form,
                    stoneOffcuts: [...form.stoneOffcuts, {
                      sourceSlabId: '', lengthInches: '', widthInches: '', shadeCode: '', photo: '', salePrice: '', notes: '',
                    }],
                  }))}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-500/30 text-amber-700 hover:bg-amber-500/10"
                >+ Add offcut</button>
              </div>
              {completeForm.stoneOffcuts.length === 0 && <p className="text-xs text-muted">No offcut recorded for this job.</p>}
              {completeForm.stoneOffcuts.map((offcut, index) => (
                <div key={index} className="p-3 rounded-lg bg-surface border border-border space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">Offcut {index + 1}</span>
                    <button
                      type="button"
                      onClick={() => setCompleteForm(form => ({ ...form, stoneOffcuts: form.stoneOffcuts.filter((_, i) => i !== index) }))}
                      className="text-xs text-red-500 hover:underline"
                    >Remove</button>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted block mb-0.5">Source allocated slab *</label>
                    <select
                      value={offcut.sourceSlabId}
                      onChange={e => {
                        const next = [...completeForm.stoneOffcuts]
                        const source = selectedOrder.customOrder.slabAllocations.find(slab => String(slab.id) === e.target.value)
                        next[index] = { ...next[index], sourceSlabId: e.target.value, shadeCode: next[index].shadeCode || source?.lot?.shadeCode || '' }
                        setCompleteForm(form => ({ ...form, stoneOffcuts: next }))
                      }}
                      className={SEL}
                    >
                      <option value="">Select allocated slab</option>
                      {selectedOrder.customOrder.slabAllocations.map(slab => (
                        <option key={slab.id} value={slab.id}>{slab.lot?.product?.name || 'Stone'} · {slab.lot?.lotNumber || 'Lot'} · {slab.slabNumber} ({slab.status})</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="text-[10px] text-muted block mb-0.5">Length (in) *</label><input type="number" min="0.1" step="0.01" value={offcut.lengthInches} onChange={e => { const next = [...completeForm.stoneOffcuts]; next[index] = { ...next[index], lengthInches: e.target.value }; setCompleteForm(form => ({ ...form, stoneOffcuts: next })) }} className={INP} /></div>
                    <div><label className="text-[10px] text-muted block mb-0.5">Width (in) *</label><input type="number" min="0.1" step="0.01" value={offcut.widthInches} onChange={e => { const next = [...completeForm.stoneOffcuts]; next[index] = { ...next[index], widthInches: e.target.value }; setCompleteForm(form => ({ ...form, stoneOffcuts: next })) }} className={INP} /></div>
                    <div><label className="text-[10px] text-muted block mb-0.5">Shade code</label><input value={offcut.shadeCode} onChange={e => { const next = [...completeForm.stoneOffcuts]; next[index] = { ...next[index], shadeCode: e.target.value }; setCompleteForm(form => ({ ...form, stoneOffcuts: next })) }} className={INP} placeholder="Copied from lot" /></div>
                    <div><label className="text-[10px] text-muted block mb-0.5">Resale price (₹)</label><input type="number" min="0" step="1" value={offcut.salePrice} onChange={e => { const next = [...completeForm.stoneOffcuts]; next[index] = { ...next[index], salePrice: e.target.value }; setCompleteForm(form => ({ ...form, stoneOffcuts: next })) }} className={INP} /></div>
                  </div>
                  <div><label className="text-[10px] text-muted block mb-0.5">Photo URL (optional)</label><input value={offcut.photo} onChange={e => { const next = [...completeForm.stoneOffcuts]; next[index] = { ...next[index], photo: e.target.value }; setCompleteForm(form => ({ ...form, stoneOffcuts: next })) }} className={INP} placeholder="Paste uploaded photo URL; source slab photo is used otherwise" /></div>
                  <div><label className="text-[10px] text-muted block mb-0.5">Notes</label><input value={offcut.notes} onChange={e => { const next = [...completeForm.stoneOffcuts]; next[index] = { ...next[index], notes: e.target.value }; setCompleteForm(form => ({ ...form, stoneOffcuts: next })) }} className={INP} placeholder="Edge condition or resale notes" /></div>
                </div>
              ))}
            </div>
          )}

          {/* ── Step Time Variance ── */}
          {completeForm.stepActuals.length > 0 && (() => {
            const standardMins = completeForm.stepActuals.reduce((sum, s) => sum + Number(s.plannedMins || 0), 0)
            const actualMins = completeForm.stepActuals.reduce((sum, s) => sum + Number(s.actualMins || 0), 0)
            const extraMins = actualMins - standardMins
            const extraCost = completeForm.stepActuals.reduce((sum, s) => {
              const over = Math.max(0, Number(s.actualMins || 0) - Number(s.plannedMins || 0))
              return sum + (over / 60) * Number(s.labourRatePerHour || 0)
            }, 0)
            return (
              <div className="p-3 bg-surface-hover rounded-lg">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <label className="text-xs font-medium text-muted uppercase tracking-wide">Production Time Variance</label>
                  <span className={`text-xs font-semibold ${extraMins > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {actualMins} / {standardMins} min · {extraMins > 0 ? '+' : ''}{extraMins} min · ₹{Math.round(extraCost).toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="space-y-2">
                  {completeForm.stepActuals.map((s, i) => (
                    <div key={s.stepId} className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted w-5 text-center flex-shrink-0">{s.stepNumber}</span>
                      <span className="text-sm text-foreground flex-1 min-w-[80px] truncate">{s.operationName}</span>
                      <span className="text-xs text-muted flex-shrink-0">Std {s.plannedMins}m</span>
                      <input
                        type="number"
                        min="0"
                        value={s.actualMins}
                        onChange={e => {
                          const v = [...completeForm.stepActuals]
                          v[i].actualMins = e.target.value
                          const labour = Math.round(v.reduce((sum, step) => sum + (Number(step.actualMins || 0) / 60) * Number(step.labourRatePerHour || 0), 0))
                          setCompleteForm(f => ({ ...f, stepActuals: v, totalLabourCost: labour }))
                        }}
                        className="w-16 px-2 py-1.5 bg-surface border border-border rounded-lg text-sm text-foreground flex-shrink-0"
                      />
                      <span className={`text-xs flex-shrink-0 ${Number(s.actualMins || 0) > Number(s.plannedMins || 0) ? 'text-red-400' : 'text-emerald-400'}`}>
                        {Number(s.actualMins || 0) - Number(s.plannedMins || 0) > 0 ? '+' : ''}{Number(s.actualMins || 0) - Number(s.plannedMins || 0)}m
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* ── Material Consumption ── */}
          {completeForm.consumptions.length > 0 && (
            <div>
              <label className="text-xs font-medium text-muted uppercase tracking-wide mb-2 block">Material Consumption Tracking</label>
              <div className="space-y-3">
                {completeForm.consumptions.map((c, i) => {
                  const prod = products.find(p => p.id === c.rawMaterialId)
                  const issuedQty = Number(c.issuedQty || 0)
                  const actualQty = Number(c.actualQty || 0)
                  const scrapQty = Number(c.scrapQty || 0)
                  const totalConsumed = actualQty + scrapQty
                  const returnedQty = Math.max(0, issuedQty - totalConsumed)
                  const isOverConsumed = totalConsumed > issuedQty + 0.001
                  const overConsumption = isOverConsumed ? totalConsumed - issuedQty : 0

                  return (
                    <div key={i} className={`p-3 rounded-lg border transition-colors ${isOverConsumed ? 'bg-red-500/10 border-red-500/30' : 'bg-surface-hover border-border'
                      }`}>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <span className="text-sm font-medium text-foreground">{prod?.name || `Material #${c.rawMaterialId}`}</span>
                        {isOverConsumed && <span className="text-xs font-semibold text-red-400 bg-red-500/20 px-2 py-1 rounded">⚠ Over-consumed by {overConsumption.toFixed(2)}</span>}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Planned</label>
                          <div className="px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-muted">{Number(c.plannedQty || 0).toFixed(2)}</div>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Issued to Floor</label>
                          <input type="number" min="0" step="0.01" value={c.issuedQty} onChange={e => { const v = [...completeForm.consumptions]; v[i].issuedQty = e.target.value; setCompleteForm(f => ({ ...f, consumptions: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Consumed</label>
                          <input type="number" min="0" step="0.01" value={c.actualQty} onChange={e => { const v = [...completeForm.consumptions]; v[i].actualQty = e.target.value; setCompleteForm(f => ({ ...f, consumptions: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Scrap</label>
                          <input type="number" min="0" step="0.01" value={c.scrapQty} onChange={e => { const v = [...completeForm.consumptions]; v[i].scrapQty = e.target.value; setCompleteForm(f => ({ ...f, consumptions: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <div className={`text-center px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0 ${isOverConsumed ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
                          }`}>
                          {isOverConsumed ? `Over: ${overConsumption.toFixed(2)}` : `Return: ${returnedQty.toFixed(2)}`}
                        </div>
                        <input value={c.scrapReason || ''} onChange={e => { const v = [...completeForm.consumptions]; v[i].scrapReason = e.target.value; setCompleteForm(f => ({ ...f, consumptions: v })) }} placeholder="Scrap reason..." className="flex-1 min-w-[140px] px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="text-xs text-muted mb-1 block">Notes</label>
            <textarea value={completeForm.notes} onChange={e => setCompleteForm(p => ({ ...p, notes: e.target.value }))} rows={2} className={INP} placeholder="Any additional notes..." />
          </div>

          <button onClick={handleCompleteProd} disabled={submitting || !completeForm.actualQty} className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-600/90 disabled:opacity-50">
            {submitting ? 'Completing...' : 'Complete Production & Update Stock'}
          </button>
        </div>
      </Modal>

      {/* Work Center Modal */}
      <Modal isOpen={showWCModal} onClose={() => setShowWCModal(false)} title="Add Work Center">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">Name *</label>
              <input value={wcForm.name} onChange={e => setWcForm(p => ({ ...p, name: e.target.value }))} placeholder={IS_TGM ? 'e.g. CNC Cutting Bay 1' : 'e.g. Carpentry Station 1'} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Type</label>
              <select value={wcForm.type} onChange={e => setWcForm(p => ({ ...p, type: e.target.value }))} className={SEL}>
                {WC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Daily Capacity (units/day)</label>
              <input type="number" min="1" value={wcForm.capacity} onChange={e => setWcForm(p => ({ ...p, capacity: e.target.value }))} className={INP} />
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Description</label>
              <input value={wcForm.description} onChange={e => setWcForm(p => ({ ...p, description: e.target.value }))} className={INP} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted mb-1 block">Notes</label>
              <input value={wcForm.notes} onChange={e => setWcForm(p => ({ ...p, notes: e.target.value }))} className={INP} />
            </div>
          </div>
          <button onClick={handleCreateWC} disabled={submitting || !wcForm.name} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
            {submitting ? 'Creating...' : 'Add Work Center'}
          </button>
        </div>
      </Modal>

      {/* Cancel Modal */}
      <Modal isOpen={showCancelModal} onClose={() => { setShowCancelModal(false); setCancelReason('') }} title="Cancel Production Order">
        <div className="space-y-4">
          <p className="text-sm text-muted">Cancel order <span className="font-semibold text-foreground">{cancelTarget?.displayId}</span>?</p>
          <div>
            <label className="text-xs text-muted mb-1 block">Reason for cancellation *</label>
            <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} rows={3} placeholder="Explain why this order is being cancelled..." className={INP} />
          </div>
          <div className="flex gap-3">
            <button onClick={() => { setShowCancelModal(false); setCancelReason('') }} className="flex-1 py-2 border border-border text-muted rounded-lg text-sm hover:text-foreground">Go Back</button>
            <button onClick={handleCancelProd} disabled={submitting || !cancelReason.trim()} className="flex-1 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-600/90 disabled:opacity-50">
              {submitting ? 'Cancelling...' : 'Confirm Cancel'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Quality Check Modal */}
      <Modal isOpen={showQCModal} onClose={() => { setShowQCModal(false); setQcTarget(null) }} title="Record Quality Check">
        <div className="space-y-4">
          <p className="text-sm text-muted">Order: <span className="font-semibold text-foreground">{qcTarget?.displayId} — {qcTarget?.finishedProduct?.name}</span></p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted mb-1 block">Quality Status *</label>
              <select value={qcForm.qualityStatus} onChange={e => setQcForm(p => ({ ...p, qualityStatus: e.target.value }))} className={SEL}>
                <option value="PASSED">PASSED</option>
                <option value="PARTIAL">PARTIAL</option>
                <option value="FAILED">FAILED</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted mb-1 block">Scrap Quantity</label>
              <input type="number" min="0" value={qcForm.scrapQty} onChange={e => setQcForm(p => ({ ...p, scrapQty: e.target.value }))} className={INP} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Scrap Reason</label>
            <input value={qcForm.scrapReason} onChange={e => setQcForm(p => ({ ...p, scrapReason: e.target.value }))} placeholder="Defect, damage, etc." className={INP} />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Quality Notes</label>
            <textarea value={qcForm.qualityNotes} onChange={e => setQcForm(p => ({ ...p, qualityNotes: e.target.value }))} rows={2} placeholder="Inspection observations..." className={INP} />
          </div>
          <button onClick={handleQCSubmit} disabled={submitting} className="w-full py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-600/90 disabled:opacity-50">
            {submitting ? 'Saving...' : 'Record Quality Check'}
          </button>
        </div>
      </Modal>

      {/* BOM Templates Manager Modal */}
      <Modal isOpen={showTemplateModal} onClose={() => setShowTemplateModal(false)} title="BOM Process Templates" size="lg" fullScreenMobile>
        <div className="space-y-5">
          {/* Existing templates */}
          {templates.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted uppercase tracking-wide">Saved Templates</h4>
              {templates.map(t => (
                <div key={t.id} className="p-3 bg-surface-hover rounded-lg border border-border/50 flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t.name}</p>
                    {t.description && <p className="text-xs text-muted mt-0.5">{t.description}</p>}
                    <p className="text-[10px] text-muted mt-1">{Array.isArray(t.steps) ? t.steps.length : 0} steps</p>
                  </div>
                  <button onClick={async () => { if (!await confirmDialog('Delete this template?')) return; const r = await deleteBomTemplate(t.id); if (r.success) loadData(); else alert(r.error) }} className="p-1.5 text-red-400/50 hover:text-red-400 hover:bg-red-500/10 rounded">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Create new template */}
          <div className="border-t border-border pt-4">
            <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Create New Template</h4>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted mb-1 block">Template Name *</label>
                  <input value={templateForm.name} onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))} placeholder={IS_TGM ? 'e.g. Standard Granite Cutting Process' : 'e.g. Standard Sofa Process'} className={INP} />
                </div>
                <div>
                  <label className="text-xs text-muted mb-1 block">Description</label>
                  <input value={templateForm.description} onChange={e => setTemplateForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" className={INP} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-muted uppercase tracking-wide">Steps</label>
                  <button onClick={() => setTemplateForm(f => ({ ...f, steps: [...f.steps, { operationName: '', workCenterId: '', durationMins: 60, labourRatePerHour: 0, machineCostPerUnit: 0 }] }))} className="text-xs text-accent hover:underline">+ Add Step</button>
                </div>
                <div className="space-y-2">
                  {templateForm.steps.map((step, i) => (
                    <div key={i} className="p-3 bg-surface-hover rounded-lg border border-border/50">
                      <div className="grid grid-cols-12 gap-2 items-center mb-2">
                        <span className="col-span-1 text-xs text-muted text-center font-bold">{i + 1}</span>
                        <input value={step.operationName} onChange={e => { const v = [...templateForm.steps]; v[i].operationName = e.target.value; setTemplateForm(f => ({ ...f, steps: v })) }} placeholder="Operation name" className="col-span-5 px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        <select value={step.workCenterId} onChange={e => { const v = [...templateForm.steps]; v[i].workCenterId = e.target.value; setTemplateForm(f => ({ ...f, steps: v })) }} className="col-span-4 px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground">
                          <option value="">Work Center</option>
                          {workCenters.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                        <button onClick={() => setTemplateForm(f => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} className="col-span-1 text-red-400 hover:text-red-300 text-base text-center">×</button>
                        <div className="col-span-1" />
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Duration (min)</label>
                          <input type="number" min="0" value={step.durationMins} onChange={e => { const v = [...templateForm.steps]; v[i].durationMins = e.target.value; setTemplateForm(f => ({ ...f, steps: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Labour ₹/hr</label>
                          <input type="number" min="0" value={step.labourRatePerHour} onChange={e => { const v = [...templateForm.steps]; v[i].labourRatePerHour = e.target.value; setTemplateForm(f => ({ ...f, steps: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Machine ₹/unit</label>
                          <input type="number" min="0" value={step.machineCostPerUnit} onChange={e => { const v = [...templateForm.steps]; v[i].machineCostPerUnit = e.target.value; setTemplateForm(f => ({ ...f, steps: v })) }} className="w-full px-2 py-1.5 bg-surface border border-border rounded-lg text-xs text-foreground" />
                        </div>
                      </div>
                    </div>
                  ))}
                  {templateForm.steps.length === 0 && <p className="text-xs text-muted text-center py-4">Add steps to define this process template</p>}
                </div>
              </div>

              <button onClick={handleCreateTemplate} disabled={submitting || !templateForm.name || templateForm.steps.filter(s => s.operationName).length === 0} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">
                {submitting ? 'Saving...' : 'Save Template'}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ─── BOM Card Component ────────────────────────────────
function BOMCard({ bom, products, workCenters, onToggle, onDelete, onExport, onSaveAsTemplate, onRefresh }) {
  const [expanded, setExpanded] = useState(false)
  const [editingItemId, setEditingItemId] = useState(null)
  const [editingStepId, setEditingStepId] = useState(null)
  const [itemEdit, setItemEdit] = useState({})
  const [stepEdit, setStepEdit] = useState({})
  const [addItemMode, setAddItemMode] = useState(false)
  const [addStepMode, setAddStepMode] = useState(false)
  const [newItem, setNewItem] = useState({ rawMaterialId: '', quantity: 1, unitOfMeasure: 'PCS', wastagePercent: 0, unitCost: 0 })
  const [newStep, setNewStep] = useState({ operationName: '', workCenterId: '', durationMins: 60, labourRatePerHour: 0, machineCostPerUnit: 0 })
  const [saving, setSaving] = useState(false)

  const saveItemEdit = async (id) => {
    setSaving(true)
    const r = await updateBOMItem({
      id,
      quantity: Number(itemEdit.quantity),
      unitOfMeasure: itemEdit.unitOfMeasure,
      wastagePercent: Number(itemEdit.wastagePercent),
      unitCost: Number(itemEdit.unitCost),
    })
    if (r.success) { setEditingItemId(null); onRefresh() }
    else alert(r.error)
    setSaving(false)
  }

  const saveStepEdit = async (id) => {
    setSaving(true)
    const r = await updateBOMStep({
      id,
      operationName: stepEdit.operationName,
      workCenterId: stepEdit.workCenterId ? Number(stepEdit.workCenterId) : null,
      durationMins: Number(stepEdit.durationMins),
      labourRatePerHour: Number(stepEdit.labourRatePerHour),
      machineCostPerUnit: Number(stepEdit.machineCostPerUnit),
    })
    if (r.success) { setEditingStepId(null); onRefresh() }
    else alert(r.error)
    setSaving(false)
  }

  const handleAddItem = async () => {
    if (!newItem.rawMaterialId) return
    setSaving(true)
    const r = await addBOMItem({ bomId: bom.id, rawMaterialId: Number(newItem.rawMaterialId), quantity: Number(newItem.quantity), unitOfMeasure: newItem.unitOfMeasure, wastagePercent: Number(newItem.wastagePercent), unitCost: Number(newItem.unitCost) })
    if (r.success) { setAddItemMode(false); setNewItem({ rawMaterialId: '', quantity: 1, unitOfMeasure: 'PCS', wastagePercent: 0, unitCost: 0 }); onRefresh() }
    else alert(r.error)
    setSaving(false)
  }

  const handleAddStep = async () => {
    if (!newStep.operationName) return
    setSaving(true)
    const r = await addBOMStep({ bomId: bom.id, operationName: newStep.operationName, workCenterId: newStep.workCenterId ? Number(newStep.workCenterId) : undefined, durationMins: Number(newStep.durationMins), labourRatePerHour: Number(newStep.labourRatePerHour), machineCostPerUnit: Number(newStep.machineCostPerUnit) })
    if (r.success) { setAddStepMode(false); setNewStep({ operationName: '', workCenterId: '', durationMins: 60, labourRatePerHour: 0, machineCostPerUnit: 0 }); onRefresh() }
    else alert(r.error)
    setSaving(false)
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground">{bom.name}</h3>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${bom.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {bom.isActive ? 'Active' : 'Inactive'}
            </span>
            <span className="text-[10px] text-muted">v{bom.version}</span>
            {bom.estimatedDays && <span className="text-[10px] text-muted">{bom.estimatedDays} days</span>}
            <span className="text-[10px] text-muted">{bom._count?.productionOrders || 0} orders</span>
          </div>
          <p className="text-xs text-muted mt-1">
            Finished Product: <span className="text-foreground">{bom.finishedProduct?.name}</span>
            {bom.finishedProduct?.sku && <span className="ml-1">({bom.finishedProduct.sku})</span>}
          </p>
          {/* Cost summary row */}
          {(() => {
            const matCost = bom.items?.reduce((sum, item) => {
              const uc = item.unitCost > 0 ? item.unitCost : (item.rawMaterial?.costPrice ?? 0)
              const qty = item.quantity * (1 + (item.wastagePercent || 0) / 100)
              return sum + uc * qty
            }, 0) ?? 0
            const stepCost = bom.steps?.reduce((sum, s) => {
              return sum + ((Number(s.durationMins) / 60) * Number(s.labourRatePerHour || 0)) + Number(s.machineCostPerUnit || 0)
            }, 0) ?? 0
            const totalMfg = matCost + stepCost
            const stdTime = bom.standardMins ?? (bom.steps?.reduce((sum, s) => sum + (Number(s.durationMins) || 0), 0) ?? 0)
            const sellingPrice = bom.finishedProduct?.price ?? 0
            const margin = sellingPrice > 0 ? sellingPrice - totalMfg : null
            return (
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <span className="text-[11px] px-2 py-0.5 rounded-md bg-cyan-500/10 text-cyan-400 font-medium">
                  Std Time: {stdTime} min
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-400 font-medium">
                  Mfg Cost: ₹{totalMfg.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </span>
                {sellingPrice > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 font-medium">
                    Selling: ₹{sellingPrice.toLocaleString('en-IN')}
                  </span>
                )}
                {margin !== null && (
                  <span className={`text-[11px] px-2 py-0.5 rounded-md font-medium ${margin >= 0 ? 'bg-purple-500/10 text-purple-400' : 'bg-red-500/10 text-red-400'}`}>
                    Margin: ₹{margin.toLocaleString('en-IN', { maximumFractionDigits: 0 })} {sellingPrice > 0 ? `(${((margin / sellingPrice) * 100).toFixed(1)}%)` : ''}
                  </span>
                )}
              </div>
            )
          })()}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="relative group z-50">
            <button className="p-1.5 rounded hover:bg-surface-hover text-muted hover:text-emerald-400" title="Download Options"><Download className="w-4 h-4" /></button>
            <div className="absolute right-0 mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all flex flex-col overflow-hidden">
              <button onClick={() => downloadBOMCSV(bom, false)} className="px-4 py-2 text-left text-xs hover:bg-surface-light text-foreground border-b border-border">BOM (CSV)</button>
              <button onClick={() => downloadBOMPDF(bom, false)} className="px-4 py-2 text-left text-xs hover:bg-surface-light text-foreground border-b border-border">BOM (PDF)</button>
              <button onClick={() => downloadBOMCSV(bom, true)} className="px-4 py-2 text-left text-xs hover:bg-surface-light text-foreground border-b border-border">Work Sheet (CSV)</button>
              <button onClick={() => downloadBOMPDF(bom, true)} className="px-4 py-2 text-left text-xs hover:bg-surface-light text-foreground">Work Sheet (PDF)</button>
            </div>
          </div>
          <button onClick={() => setExpanded(!expanded)} className="p-1.5 rounded hover:bg-surface-hover text-muted hover:text-foreground">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          <button onClick={onToggle} className={`px-2.5 py-1 rounded-lg text-xs ${bom.isActive ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'}`}>
            {bom.isActive ? 'Deactivate' : 'Activate'}
          </button>
          <button onClick={onDelete} className="p-1.5 text-red-400/40 hover:text-red-400 hover:bg-red-500/10 rounded-lg"><Trash2 className="w-4 h-4" /></button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-5 mt-4 pt-4 border-t border-border">

          {/* ── RAW MATERIALS MANAGEMENT BLOCK ── */}
          <div className="rounded-xl border border-border overflow-hidden">
            {/* Section header */}
            <div className="flex items-center justify-between px-4 py-3 bg-surface-hover border-b border-border">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-accent" />
                <span className="text-sm font-semibold text-foreground">Raw Materials</span>
                <span className="text-[10px] px-2 py-0.5 bg-accent/10 text-accent rounded-full">{bom.items?.length || 0} items</span>
              </div>
            </div>

            {/* Material rows */}
            <div className="divide-y divide-border">
              {bom.items?.length === 0 && (
                <p className="text-center text-xs text-muted py-6">No raw materials added yet</p>
              )}
              {bom.items?.map((item) => (
                <div key={item.id}>
                  {editingItemId === item.id ? (
                    /* ── Edit row ── */
                    <div className="p-3 bg-accent/5">
                      <p className="text-xs font-medium text-accent mb-2">Editing: {item.rawMaterial?.name}</p>
                      <div className="grid grid-cols-3 gap-2 mb-2">
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Quantity</label>
                          <input type="number" min="0.001" step="0.001" value={itemEdit.quantity}
                            onChange={e => setItemEdit(p => ({ ...p, quantity: e.target.value }))}
                            className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Unit of Measure</label>
                          <input value={itemEdit.unitOfMeasure}
                            onChange={e => setItemEdit(p => ({ ...p, unitOfMeasure: e.target.value }))}
                            className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted block mb-0.5">Wastage %</label>
                          <input type="number" min="0" max="100" value={itemEdit.wastagePercent}
                            onChange={e => setItemEdit(p => ({ ...p, wastagePercent: e.target.value }))}
                            className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => saveItemEdit(item.id)} disabled={saving}
                          className="px-3 py-1.5 bg-emerald-600 text-white rounded text-xs font-medium disabled:opacity-50 flex items-center gap-1">
                          <Save className="w-3 h-3" /> {saving ? 'Saving...' : 'Save'}
                        </button>
                        <button onClick={() => setEditingItemId(null)}
                          className="px-3 py-1.5 bg-surface border border-border text-muted rounded text-xs">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    /* ── Display row ── */
                    <div className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover/50 group">
                      {/* Name & SKU */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{item.rawMaterial?.name}</p>
                        <p className="text-[10px] text-muted font-mono">{item.rawMaterial?.sku}</p>
                      </div>
                      {/* Qty */}
                      <div className="text-center w-20">
                        <p className="text-sm text-foreground font-semibold">{item.quantity}</p>
                        <p className="text-[10px] text-muted">{item.unitOfMeasure}</p>
                      </div>
                      {/* Wastage */}
                      <div className="text-center w-16">
                        <p className="text-sm text-foreground">{item.wastagePercent}%</p>
                        <p className="text-[10px] text-muted">Waste</p>
                      </div>
                      {/* Unit cost — auto from Raw Materials */}
                      <div className="text-center w-24">
                        <p className="text-sm text-foreground font-semibold">₹{item.rawMaterial?.costPrice || 0}</p>
                        <p className="text-[10px] text-muted">cost/unit</p>
                      </div>
                      {/* Stock */}
                      <div className="text-center w-20">
                        <p className={`text-sm font-semibold ${(item.rawMaterial?.stock || 0) < item.quantity * (1 + (item.wastagePercent || 0) / 100) ? 'text-red-400' : 'text-emerald-400'}`}>
                          {item.rawMaterial?.stock}
                        </p>
                        <p className="text-[10px] text-muted">in stock</p>
                      </div>
                      {/* Status badge */}
                      <span className={`hidden sm:inline text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${(item.rawMaterial?.stock || 0) < item.quantity * (1 + (item.wastagePercent || 0) / 100) ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                        {(item.rawMaterial?.stock || 0) < item.quantity * (1 + (item.wastagePercent || 0) / 100) ? '⚠ Short' : '✓ OK'}
                      </span>
                      {/* Action buttons — always visible */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => { setEditingItemId(item.id); setItemEdit({ quantity: item.quantity, unitOfMeasure: item.unitOfMeasure, wastagePercent: item.wastagePercent, unitCost: item.unitCost }) }}
                          className="px-2.5 py-1 rounded-md bg-surface border border-border text-xs text-muted hover:text-accent hover:border-accent/50 transition-colors flex items-center gap-1">
                          <Edit2 className="w-3 h-3" /> Edit
                        </button>
                        <button
                          onClick={async () => { if (!await confirmDialog(`Remove "${item.rawMaterial?.name}" from this BOM?`)) return; setSaving(true); const r = await removeBOMItem(item.id); if (r.success) onRefresh(); else alert(r.error); setSaving(false) }}
                          disabled={saving}
                          className="px-2.5 py-1 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400 hover:bg-red-500/20 transition-colors flex items-center gap-1 disabled:opacity-50">
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* ── Add New Material Form — always shown at bottom ── */}
            <div className="border-t border-dashed border-border/70 bg-surface-hover/30 p-4">
              <p className="text-xs font-semibold text-foreground mb-3 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-accent" /> Add Raw Material
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <div className="col-span-2 sm:col-span-1">
                  <label className="text-[10px] text-muted block mb-0.5">Material *</label>
                  <select
                    value={newItem.rawMaterialId}
                    onChange={e => {
                      const selected = products.find(p => String(p.id) === String(e.target.value))
                      setNewItem(p => ({
                        ...p,
                        rawMaterialId: e.target.value,
                        unitOfMeasure: selected?.unitOfMeasure || p.unitOfMeasure,
                        unitCost: selected?.costPrice || p.unitCost,
                      }))
                    }}
                    className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/50">
                    <option value="">— Select material —</option>
                    {products.filter(p => p.category === 'Raw Material').map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-muted block mb-0.5">Quantity *</label>
                  <input type="number" min="0.001" step="0.001" value={newItem.quantity}
                    onChange={e => setNewItem(p => ({ ...p, quantity: e.target.value }))}
                    className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/50" />
                </div>
                <div>
                  <label className="text-[10px] text-muted block mb-0.5">Unit of Measure</label>
                  <select value={newItem.unitOfMeasure}
                    onChange={e => setNewItem(p => ({ ...p, unitOfMeasure: e.target.value }))}
                    className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/50">
                    <option value="PCS">PCS – Pieces</option>
                    <option value="KG">KG – Kilograms</option>
                    <option value="MTR">MTR – Meters</option>
                    <option value="SFT">SFT – Sq. Feet</option>
                    <option value="LTR">LTR – Litres</option>
                    <option value="SET">SET</option>
                    <option value="BOX">BOX</option>
                    <option value="NOS">NOS – Numbers</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-muted block mb-0.5">Wastage %</label>
                  <input type="number" min="0" max="100" value={newItem.wastagePercent}
                    onChange={e => setNewItem(p => ({ ...p, wastagePercent: e.target.value }))}
                    className="w-full px-2 py-2 bg-surface border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent/50" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleAddItem}
                  disabled={saving || !newItem.rawMaterialId}
                  className="px-4 py-2 bg-accent text-white rounded-lg text-xs font-semibold hover:bg-accent/90 disabled:opacity-50 flex items-center gap-1.5 transition-colors">
                  <Plus className="w-3.5 h-3.5" />
                  {saving ? 'Adding...' : 'Add Material'}
                </button>
                <button
                  onClick={() => setNewItem({ rawMaterialId: '', quantity: 1, unitOfMeasure: 'PCS', wastagePercent: 0, unitCost: 0 })}
                  className="px-3 py-2 text-xs text-muted hover:text-foreground transition-colors">
                  Clear
                </button>
                <p className="text-[10px] text-muted ml-auto">Cost is auto-picked from Raw Materials tab</p>
              </div>
            </div>
          </div>

          {/* Steps Section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted uppercase tracking-wide">Manufacturing Routing & Job Costing</p>
              <div className="flex gap-2">
                {bom.steps?.length > 0 && (
                  <button onClick={() => onSaveAsTemplate(bom.steps)} className="text-xs text-muted hover:text-accent flex items-center gap-1"><Copy className="w-3 h-3" /> Save as Template</button>
                )}
                <button onClick={() => setAddStepMode(!addStepMode)} className="text-xs text-accent hover:underline flex items-center gap-1"><Plus className="w-3 h-3" /> Add Step</button>
              </div>
            </div>

            {bom.steps?.length > 0 ? (
              <div className="space-y-2">
                {bom.steps.map((s) => (
                  <div key={s.id} className="group">
                    {editingStepId === s.id ? (
                      <div className="p-3 bg-accent/5 border border-accent/20 rounded-lg">
                        <div className="grid grid-cols-12 gap-2 items-center mb-2">
                          <span className="col-span-1 text-xs text-muted text-center font-bold">{s.stepNumber}</span>
                          <input value={stepEdit.operationName} onChange={e => setStepEdit(p => ({ ...p, operationName: e.target.value }))} className="col-span-5 px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                          <select value={stepEdit.workCenterId || ''} onChange={e => setStepEdit(p => ({ ...p, workCenterId: e.target.value }))} className="col-span-4 px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground">
                            <option value="">Work Center</option>
                            {workCenters.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                          </select>
                          <div className="col-span-2 flex gap-1 justify-end">
                            <button onClick={() => saveStepEdit(s.id)} disabled={saving} className="p-1 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 rounded"><Save className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setEditingStepId(null)} className="p-1 bg-gray-500/10 text-gray-400 rounded"><X className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="text-[10px] text-muted block mb-0.5">Duration (min)</label>
                            <input type="number" min="0" value={stepEdit.durationMins} onChange={e => setStepEdit(p => ({ ...p, durationMins: e.target.value }))} className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                          </div>
                          <div>
                            <label className="text-[10px] text-muted block mb-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> Labour ₹/hr</label>
                            <input type="number" min="0" value={stepEdit.labourRatePerHour} onChange={e => setStepEdit(p => ({ ...p, labourRatePerHour: e.target.value }))} className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                            <p className="text-[9px] text-muted mt-0.5">= ₹{((Number(stepEdit.durationMins) / 60) * Number(stepEdit.labourRatePerHour)).toFixed(2)}/unit</p>
                          </div>
                          <div>
                            <label className="text-[10px] text-muted block mb-0.5 flex items-center gap-1"><Zap className="w-3 h-3" /> Machine ₹/unit</label>
                            <input type="number" min="0" value={stepEdit.machineCostPerUnit} onChange={e => setStepEdit(p => ({ ...p, machineCostPerUnit: e.target.value }))} className="w-full px-2 py-1.5 bg-surface border border-accent rounded text-xs text-foreground" />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-3 bg-surface-hover rounded-lg text-sm flex-wrap">
                        <span className="w-6 h-6 rounded-full bg-accent/20 text-accent flex items-center justify-center text-[10px] font-bold flex-shrink-0">{s.stepNumber}</span>
                        <span className="flex-1 text-foreground font-medium min-w-[100px]">{s.operationName}</span>
                        {s.workCenter && <span className="text-muted text-xs">@ {s.workCenter.name}</span>}
                        <span className="text-muted text-xs flex items-center gap-1"><Clock className="w-3 h-3" />{s.durationMins}min</span>
                        {s.labourRatePerHour > 0 && (
                          <span className="text-blue-400 text-xs">Labour: ₹{((s.durationMins / 60) * s.labourRatePerHour).toFixed(2)}/unit</span>
                        )}
                        {s.machineCostPerUnit > 0 && (
                          <span className="text-amber-400 text-xs">Machine: ₹{s.machineCostPerUnit}/unit</span>
                        )}
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 ml-auto">
                          <button onClick={() => { setEditingStepId(s.id); setStepEdit({ operationName: s.operationName, workCenterId: s.workCenterId || '', durationMins: s.durationMins, labourRatePerHour: s.labourRatePerHour, machineCostPerUnit: s.machineCostPerUnit }) }} className="p-1 text-muted hover:text-accent"><Edit2 className="w-3 h-3" /></button>
                          <button onClick={async () => { if (!await confirmDialog('Remove this step?')) return; setSaving(true); const r = await removeBOMStep(s.id); if (r.success) onRefresh(); else alert(r.error); setSaving(false) }} className="p-1 text-muted hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Step cost summary */}
                {bom.steps.some(s => s.labourRatePerHour > 0 || s.machineCostPerUnit > 0) && (
                  <div className="p-2.5 bg-surface-hover rounded-lg border border-border/50 flex items-center justify-between text-xs">
                    <span className="text-muted">Total job cost per unit:</span>
                    <div className="flex gap-4">
                      <span className="text-blue-400">Labour: ₹{bom.steps.reduce((s, step) => s + (step.durationMins / 60) * step.labourRatePerHour, 0).toFixed(2)}</span>
                      <span className="text-amber-400">Machine: ₹{bom.steps.reduce((s, step) => s + step.machineCostPerUnit, 0).toFixed(2)}</span>
                      <span className="text-foreground font-semibold">Total: ₹{bom.steps.reduce((s, step) => s + (step.durationMins / 60) * step.labourRatePerHour + step.machineCostPerUnit, 0).toFixed(2)}</span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">No routing steps defined. Add steps to enable job costing.</p>
            )}

            {addStepMode && (
              <div className="mt-2 p-3 bg-accent/5 border border-accent/20 rounded-lg">
                <p className="text-xs font-medium text-accent mb-2">Add Manufacturing Step</p>
                <div className="grid grid-cols-12 gap-2 items-center mb-2">
                  <input value={newStep.operationName} onChange={e => setNewStep(p => ({ ...p, operationName: e.target.value }))} placeholder="Operation name" className="col-span-6 px-2 py-1.5 bg-surface border border-border rounded text-xs text-foreground" />
                  <select value={newStep.workCenterId} onChange={e => setNewStep(p => ({ ...p, workCenterId: e.target.value }))} className="col-span-5 px-2 py-1.5 bg-surface border border-border rounded text-xs text-foreground">
                    <option value="">Work Center (optional)</option>
                    {workCenters.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                  <div className="col-span-1" />
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <div>
                    <label className="text-[10px] text-muted block mb-0.5">Duration (min)</label>
                    <input type="number" min="0" value={newStep.durationMins} onChange={e => setNewStep(p => ({ ...p, durationMins: e.target.value }))} className="w-full px-2 py-1.5 bg-surface border border-border rounded text-xs text-foreground" />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted block mb-0.5 flex items-center gap-1"><Clock className="w-3 h-3" /> Labour ₹/hr</label>
                    <input type="number" min="0" value={newStep.labourRatePerHour} onChange={e => setNewStep(p => ({ ...p, labourRatePerHour: e.target.value }))} className="w-full px-2 py-1.5 bg-surface border border-border rounded text-xs text-foreground" />
                    <p className="text-[9px] text-muted mt-0.5">= ₹{((Number(newStep.durationMins) / 60) * Number(newStep.labourRatePerHour)).toFixed(2)}/unit</p>
                  </div>
                  <div>
                    <label className="text-[10px] text-muted block mb-0.5 flex items-center gap-1"><Zap className="w-3 h-3" /> Machine ₹/unit</label>
                    <input type="number" min="0" value={newStep.machineCostPerUnit} onChange={e => setNewStep(p => ({ ...p, machineCostPerUnit: e.target.value }))} className="w-full px-2 py-1.5 bg-surface border border-border rounded text-xs text-foreground" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={handleAddStep} disabled={saving || !newStep.operationName} className="px-3 py-1.5 bg-accent text-white rounded text-xs disabled:opacity-50">{saving ? '...' : 'Add Step'}</button>
                  <button onClick={() => setAddStepMode(false)} className="px-3 py-1.5 bg-surface border border-border text-muted rounded text-xs">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {bom.notes && <p className="text-xs text-muted">Notes: {bom.notes}</p>}
        </div>
      )}
    </div>
  )
}
