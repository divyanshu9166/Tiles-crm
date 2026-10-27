/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search, Plus, Package, AlertTriangle, TrendingUp, Grid3x3, List,
  Warehouse, QrCode, RefreshCw, ArrowDown, ArrowUp, Bell,
  CheckCircle2, XCircle, Clock, Layers, Boxes, Timer, MapPin, FileText, Trash2,
  Upload, Download, X, CheckCircle, Pencil, Image as ImageIcon, Save
} from 'lucide-react';
import { getProducts, getCategories, getWarehouses, createProduct, updateStock, bulkImportProducts } from '@/app/actions/products';
import { moveProductToDraft } from '@/app/actions/drafts';
import { getStockGroups, createStockGroup } from '@/app/actions/stock-groups';
import { getBatches, createBatch, getAgingAnalysis } from '@/app/actions/batches';
import { getGodownStock, getGodowns, getStockLedger } from '@/app/actions/godowns';
import { getStoneLots, createStoneLot, updateSlab, pairSlabs, getSampleLoans, createSampleLoan, updateSampleLoanStatus } from '@/app/actions/stone-inventory';
import { getScrapInventory, updateScrapInventoryStatus } from '@/app/actions/manufacturing';
import Modal from '@/components/Modal';
import { useAlertToast } from '@/components/AlertToastProvider';
import { getActiveVertical } from '@/lib/brand';
import { getTerm } from '@/lib/terminology';
import { FINISH_VALUES, APPLICATION_AREA_VALUES, TILES_UNIT_VALUES } from '@/lib/validations/product';
import * as XLSX from 'xlsx';

// Resolved once per module load from NEXT_PUBLIC_BUSINESS_TYPE (client) — tiles inputs
// are shown only for the tiles vertical so furniture renders unchanged (Requirement 6.7).
const IS_TILES = getActiveVertical() === 'tiles';

const inventoryUnitLabel = (product) => {
  if (!IS_TILES) return product?.unitOfMeasure || 'PCS';
  if (product?.isSlabTracked) return 'SLABS';
  const unit = String(product?.unitOfMeasure || '').toUpperCase();
  return unit || 'PCS';
};

// Product.stock is deliberately zero for serialized granite/marble. Their
// source of truth is the available physical slab balance returned by getProducts.
const inventoryQuantity = (product) => product?.isSlabTracked
  ? Number(product.availableStoneSlabs || 0)
  : Number(product?.stock || 0);

// Stock is valued at cost (what it cost us), not at the selling price.
const inventoryValue = (product) => product?.isSlabTracked
  ? Number(product.availableStoneCost || 0)
  : Number(product?.costPrice || 0) * inventoryQuantity(product);

const inventoryStockText = (product) => product?.isSlabTracked
  ? `${inventoryQuantity(product)} slabs · ${Number(product.availableStoneSqft || 0).toFixed(2)} sq.ft`
  : inventoryUnitLabel(product) === 'BOX' && Number(product?.coveragePerBox) > 0
    ? `${inventoryQuantity(product)} boxes · ${(inventoryQuantity(product) * Number(product.coveragePerBox)).toLocaleString('en-IN', { maximumFractionDigits: 2 })} sq.ft`
    : `${inventoryQuantity(product)} ${inventoryUnitLabel(product)}`;

const stockBadge = (stock, reorderLevel) => {
  if (stock === 0) return { text: 'Out of Stock', cls: 'bg-danger-light text-danger' };
  if (stock <= reorderLevel) return { text: 'Low Stock', cls: 'bg-warning-light text-warning' };
  return { text: 'In Stock', cls: 'bg-success-light text-success' };
};

export default function InventoryPage() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState(['All']);
  const [warehouses, setWarehouses] = useState(['All']);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [warehouseFilter, setWarehouseFilter] = useState('All');
  const [view, setView] = useState('grid');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showStockModal, setShowStockModal] = useState(null);
  const [stockSaving, setStockSaving] = useState(false);
  const [stockError, setStockError] = useState('');
  const [pageError, setPageError] = useState('');
  const [batchSaving, setBatchSaving] = useState(false);
  const [tab, setTab] = useState('products');
  const [productType, setProductType] = useState('finished'); // 'finished' | 'rawMaterial'
  const [productImages, setProductImages] = useState([]);
  const [addingProduct, setAddingProduct] = useState(false);

  // Deep inventory state
  const [stockGroups, setStockGroups] = useState([]);
  const [batches, setBatches] = useState([]);
  const [agingData, setAgingData] = useState([]);
  const [showGroupModal, setShowGroupModal] = useState(false);

  const { notify } = useAlertToast();

  // ─── Fetch-once guard refs (prevents infinite-loop when data is empty) ───
  const deepFetched = React.useRef(false);
  const locationFetched = React.useRef(false);
  const ledgerFetched = React.useRef(false);

  // ─── BULK IMPORT STATE ─────────────────────────────────
  const [showImportModal, setShowImportModal] = useState(false);
  const [importRows, setImportRows] = useState([]);
  const [importHeaders, setImportHeaders] = useState([]);
  const [importColMap, setImportColMap] = useState({});
  const [importError, setImportError] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // ─── EDIT PRODUCT STATE ───────────────────────────────
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editImageFile, setEditImageFile] = useState(null);
  const [editImagePreview, setEditImagePreview] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const [productToDelete, setProductToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleMoveProductToDraft = (productId) => {
    const product = products.find(p => p.id === productId) || { id: productId, name: 'this product' };
    setProductToDelete(product);
  };

  const confirmMoveToDraft = async () => {
    if (!productToDelete) return;
    setDeleting(true);
    try {
      const res = await moveProductToDraft(productToDelete.id);
      if (!res?.success) {
        notify(res?.error || 'Failed to move product to drafts', { variant: 'danger' });
        return;
      }
      const refreshed = await getProducts();
      if (refreshed.success) setProducts(refreshed.data);
      notify('Product moved to drafts', { variant: 'success' });
    } catch (err) {
      notify(err?.message || 'Failed to move product to drafts', { variant: 'danger' });
    } finally {
      setDeleting(false);
      setProductToDelete(null);
    }
  };

  const cancelMoveToDraft = () => {
    setProductToDelete(null);
  };
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: '', parentId: '' });
  const [batchForm, setBatchForm] = useState({ productId: '', batchNumber: '', shadeCode: '', purchaseDate: '', expiryDate: '', quantity: 1, remainingQty: 1, costPrice: 0 });
  const [deepLoading, setDeepLoading] = useState(false);

  // Location view state
  const [godownStocks, setGodownStocks] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [locationLoading, setLocationLoading] = useState(false);
  const [selectedLocationGodown, setSelectedLocationGodown] = useState('');
  const [locationSearch, setLocationSearch] = useState('');

  // Stock Ledger state
  const [ledgerEntries, setLedgerEntries] = useState([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  // Serialized granite / marble stock: a lot contains individually measured slabs.
  const [stoneLots, setStoneLots] = useState([]);
  const [stoneLoading, setStoneLoading] = useState(false);
  const [showStoneLotModal, setShowStoneLotModal] = useState(false);
  const [stoneLotForm, setStoneLotForm] = useState({ productId: '', godownId: '', lotNumber: '', origin: '', shadeCode: '', qualityGrade: '', thicknessMm: '', costPerSqft: '', notes: '', slabsText: '01/01, 120, 72' });
  const [stoneLotPhotos, setStoneLotPhotos] = useState([]);
  const [sampleLoans, setSampleLoans] = useState([]);
  const [stoneOffcuts, setStoneOffcuts] = useState([]);
  const [showSampleLoanModal, setShowSampleLoanModal] = useState(false);
  const [sampleLoanForm, setSampleLoanForm] = useState({ customerName: '', customerPhone: '', productId: '', slabId: '', expectedReturn: '', notes: '' });

  useEffect(() => {
    Promise.all([getProducts(), getCategories(), getWarehouses(), getGodowns(), getGodownStock()]).then(([pRes, cRes, wRes, gdRes, gsRes]) => {
      if (pRes.success) setProducts(pRes.data);
      setCategories(['All', ...cRes.map(c => c.name)]);
      setWarehouses(['All', ...wRes.map(w => w.name)]);
      if (gdRes.success) setGodowns(gdRes.data);
      if (gsRes.success) setGodownStocks(gsRes.data);
    }).catch(err => setPageError(err.message || 'Could not load inventory')).finally(() => setLoading(false));
  }, []);

  const refreshProducts = async () => {
    const [res, cats, whs] = await Promise.all([getProducts(), getCategories(), getWarehouses()]);
    if (!res.success) throw new Error(res.error || 'Could not refresh inventory');
    setProducts(res.data);
    setCategories(['All', ...cats.map(c => c.name)]);
    setWarehouses(['All', ...whs.map(w => w.name)]);
    setPageError('');
    // Reload views that have already been opened after every mutation.
    await Promise.all([
      deepFetched.current ? loadDeepInventory() : Promise.resolve(),
      locationFetched.current ? loadLocationData() : Promise.resolve(),
      ledgerFetched.current ? loadLedger() : Promise.resolve(),
    ]);
  };

  const loadStoneLots = useCallback(async () => {
    setStoneLoading(true);
    try {
    const [result, loansResult, offcutsResult, productsResult] = await Promise.all([getStoneLots(), getSampleLoans(), getScrapInventory(), getProducts()]);
    if (productsResult.success) setProducts(productsResult.data);
    if (result.success) setStoneLots(result.data);
    if (loansResult.success) setSampleLoans(loansResult.data);
    if (offcutsResult.success) setStoneOffcuts(offcutsResult.data.filter(entry => entry.sourceSlabId));
    } catch (err) { notify(err.message || 'Could not load inventory data', { variant: 'danger' }); }
    finally { setStoneLoading(false); }
  }, [notify]);

  // ─── EDIT PRODUCT HANDLERS ────────────────────────
  const openEditModal = (product, e) => {
    if (e) e.stopPropagation();
    setEditProduct(product);
    setEditForm({
      name: product.name || '',
      price: product.price || 0,
      costPrice: product.costPrice || 0,
      reorderLevel: product.reorderLevel ?? 5,
      material: product.material || '',
      color: product.color || '',
      description: product.description || '',
      brand: product.brand || '',
      unitOfMeasure: product.unitOfMeasure || 'PCS',
      stockGroupId: product.stockGroupId || '',
      tileSize: product.tileSize || '', finish: product.finish || '',
      coveragePerBox: product.coveragePerBox ?? '', tilesPerBox: product.tilesPerBox ?? '',
      surfaceType: product.surfaceType || '', applicationArea: product.applicationArea || '',
      origin: product.origin || '', thicknessMm: product.thicknessMm ?? '', qualityGrade: product.qualityGrade || '',
    });
    setEditImageFile(null);
    setEditImagePreview(product.image ? product.image.split(',')[0] : null);
    setEditError('');
    void loadDeepInventory();
    setShowEditModal(true);
  };

  const handleEditImageChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setEditImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setEditImagePreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleEditSave = async () => {
    if (!editProduct) return;
    setEditSaving(true);
    setEditError('');
    try {
      let imageUrl = editProduct.image || '';

      if (editImageFile) {
        const formData = new FormData();
        formData.set('folder', 'products');
        formData.append('files', editImageFile);
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok || !data?.success) throw new Error(data?.error || 'Image upload failed');
        imageUrl = Array.isArray(data.urls) && data.urls.length > 0 ? data.urls[0] : imageUrl;
      }

      const updateData = {
        name: editForm.name,
        price: Number(editForm.price) || 0,
        costPrice: Number(editForm.costPrice) || 0,
        reorderLevel: Number(editForm.reorderLevel) || 0,
        material: editForm.material || '',
        color: editForm.color || '',
        description: editForm.description || '',
        brand: editForm.brand || '',
        unitOfMeasure: editForm.unitOfMeasure || 'PCS',
        image: imageUrl,
        stockGroupId: editForm.stockGroupId ? Number(editForm.stockGroupId) : null,
        ...(IS_TILES && !editProduct.isRawMaterial ? {
          tileSize: editForm.tileSize || null, finish: editForm.finish || null,
          coveragePerBox: editForm.coveragePerBox === '' ? null : Number(editForm.coveragePerBox),
          tilesPerBox: editForm.tilesPerBox === '' ? null : Number(editForm.tilesPerBox),
          surfaceType: editForm.surfaceType || null, applicationArea: editForm.applicationArea || null,
          origin: editForm.origin || null, thicknessMm: editForm.thicknessMm === '' ? null : Number(editForm.thicknessMm),
          qualityGrade: editForm.qualityGrade || null,
        } : {}),
      };

      const { updateProduct } = await import('@/app/actions/products');
      const res = await updateProduct(editProduct.id, updateData);
      if (!res.success) throw new Error(res.error || 'Update failed');

      await refreshProducts();
      notify('Updated successfully!', { variant: 'success' });
      setShowEditModal(false);
      setEditProduct(null);
    } catch (err) {
      const msg = err.message || 'Failed to update';
      setEditError(msg);
      notify(msg, { variant: 'danger' });
    }
    setEditSaving(false);
  };

  // ─── COLUMN MAPPING (flexible header matching) ─────────
  const mapProductImportColumns = (headers) => {
    const map = {};
    const normalize = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    const ALIASES = {
      name: ['productname', 'name', 'itemname', 'product'],
      sku: ['sku', 'skucode', 'itemcode', 'code', 'productcode'],
      category: ['category', 'cat', 'productcategory', 'type'],
      price: ['price', 'sellingprice', 'mrp', 'rate'],
      instock: ['instock', 'stock', 'quantity', 'qty', 'stockqty'],
      description: ['description', 'desc', 'details', 'productdesc'],
      material: ['material', 'materials', 'fabric'],
      color: ['color', 'colour'],
      reorderLevel: ['reorderlevel', 'reorder', 'minstock', 'minimumstock'],
      warehouse: ['warehouse', 'location', 'store'],
      unitOfMeasure: ['unitofmeasure', 'unit', 'uom'], costPrice: ['costprice', 'cost', 'purchaseprice'],
      brand: ['brand'], tileSize: ['tilesize'], finish: ['finish'],
      coveragePerBox: ['coverageperbox', 'boxcoverage'], tilesPerBox: ['tilesperbox'],
    };
    headers.forEach((h, i) => {
      const norm = normalize(h);
      for (const [key, aliases] of Object.entries(ALIASES)) {
        if (aliases.includes(norm) && map[key] === undefined) {
          map[key] = i;
        }
      }
    });
    return map;
  };

  const downloadProductTemplate = () => {
    const wb = XLSX.utils.book_new();
    const headers = [
      'Product Name', 'SKU Code', 'Category', 'Price', 'In Stock', 'Description',
      'Material', 'Color', 'Reorder Level', 'Warehouse', 'Unit of Measure', 'Cost Price', 'Brand', 'Tile Size', 'Finish', 'Coverage Per Box', 'Tiles Per Box'
    ];
    const example = [
      ...(IS_TILES ? ['Premium Porcelain Tile', 'TILE-001', 'Tiles', '750', '10', 'Floor tile', 'TILE', 'Ivory', '2', '', 'BOX', '500', 'Sekol', '600x600 mm', 'matte', '15.5', '4'] : ['Royal Sofa', 'PRD-001', 'Sofas', '25000', '10', 'Premium 3-seater sofa', 'Sheesham Wood', 'Walnut Brown', '2', '', 'PCS', '15000', '', '', '', '', ''])
    ];
    const note = [
      '* Required', 'Optional', 'Optional', '* Required', '* Required', 'Optional',
      'Optional', 'Optional', 'Optional', 'Optional'
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers, note, example]);
    ws['!cols'] = headers.map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Products');
    XLSX.writeFile(wb, 'product_import_template.xlsx');
  };

  const handleImportFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    setImportError('');
    setImportResult(null);
    setImportRows([]);
    setImportHeaders([]);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (rawData.length < 2) {
        setImportError('File is empty or has no data rows.');
        return;
      }

      // Find the real header row (skip note rows)
      let headerRowIdx = 0;
      const headers = rawData[headerRowIdx].map(h => String(h));
      const colMap = mapProductImportColumns(headers);

      // Skip note row if next row also looks like headers/notes
      const rows = rawData.slice(1).filter(row => {
        const nameVal = String(row[colMap.name ?? 0] ?? '').trim();
        return row.some(value => String(value ?? '').trim()) && nameVal !== '*' && nameVal.toLowerCase() !== 'name' && nameVal.toLowerCase() !== '* required';
      });

      if (colMap.name === undefined) {
        setImportError('Could not find Product Name column. Please use the template.');
        return;
      }
      if (colMap.price === undefined) {
        setImportError('Could not find Price column. Please use the template.');
        return;
      }
      if (colMap.instock === undefined) {
        setImportError('Could not find In Stock column. Please use the template.');
        return;
      }

      setImportHeaders(headers);
      setImportRows(rows);
      setImportColMap(colMap);
    } catch (err) {
      setImportError(`Failed to parse file: ${err.message || 'Unknown error'}. Please use .xlsx, .xls, or .csv.`);
    }

    event.target.value = '';
  };

  const handleImportSubmit = async () => {
    if (importRows.length === 0) return;
    setImportLoading(true);
    setImportError('');

    try {
      const parsed = importRows.map(row => ({
        name: String(row[importColMap.name] ?? '').trim(),
        sku: importColMap.sku !== undefined ? String(row[importColMap.sku] ?? '').trim() : '',
        category: importColMap.category !== undefined ? String(row[importColMap.category] ?? '').trim() : 'General',
        price: importColMap.price !== undefined ? String(row[importColMap.price] ?? '').trim() : 0,
        instock: importColMap.instock !== undefined ? String(row[importColMap.instock] ?? '').trim() : 0,
        description: importColMap.description !== undefined ? String(row[importColMap.description] ?? '').trim() : '',
        material: importColMap.material !== undefined ? String(row[importColMap.material] ?? '').trim() : '',
        color: importColMap.color !== undefined ? String(row[importColMap.color] ?? '').trim() : '',
        reorderLevel: importColMap.reorderLevel !== undefined ? Number(row[importColMap.reorderLevel] ?? 5) : 5,
        warehouse: importColMap.warehouse !== undefined ? String(row[importColMap.warehouse] ?? '').trim() : '',
        ...Object.fromEntries(['unitOfMeasure', 'costPrice', 'brand', 'tileSize', 'finish', 'coveragePerBox', 'tilesPerBox'].filter(key => importColMap[key] !== undefined).map(key => [key, row[importColMap[key]] === '' ? undefined : row[importColMap[key]]])),
      }));

      const payload = parsed;

      if (payload.length === 0) {
        setImportError('No valid rows found. Ensure Product Name, Price, and In Stock columns have valid data.');
        setImportLoading(false);
        return;
      }

      const res = await bulkImportProducts(payload);
      if (res.success) {
        setImportResult(res.data);
        setImportRows([]);
        setImportHeaders([]);
        await refreshProducts();
        notify(`Imported ${res.data.created} product(s); ${res.data.skipped} failed.`, { variant: res.data.skipped ? 'warning' : 'success' });
      } else {
        setImportError(res.error || 'Import failed');
        if (res.data) setImportResult(res.data);
      }
    } catch (err) {
      setImportError(`Import failed: ${err.message}`);
    }

    setImportLoading(false);
  };

  const loadDeepInventory = useCallback(async () => {
    setDeepLoading(true);
    try {
    const [sgRes, bRes, aRes] = await Promise.all([getStockGroups(), getBatches(), getAgingAnalysis()]);
    if (sgRes.success) setStockGroups(sgRes.data);
    if (bRes.success) setBatches(bRes.data);
    if (aRes.success) setAgingData(aRes.data);
    } catch (err) { notify(err.message || 'Could not load inventory data', { variant: 'danger' }); }
    finally { setDeepLoading(false); }
  }, [notify]);

  const loadLocationData = useCallback(async () => {
    setLocationLoading(true);
    try {
    const [gsRes, gdRes] = await Promise.all([getGodownStock(), getGodowns()]);
    if (gsRes.success) setGodownStocks(gsRes.data);
    if (gdRes.success) setGodowns(gdRes.data);
    } catch (err) { notify(err.message || 'Could not load inventory data', { variant: 'danger' }); }
    finally { setLocationLoading(false); }
  }, [notify]);

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
    const res = await getStockLedger({ limit: 200 });
    if (res.success) setLedgerEntries(res.data);
    } catch (err) { notify(err.message || 'Could not load inventory data', { variant: 'danger' }); }
    finally { setLedgerLoading(false); }
  }, [notify]);

  useEffect(() => {
    if (['stockGroups', 'batches', 'aging'].includes(tab) && !deepFetched.current) {
      deepFetched.current = true;
      loadDeepInventory();
    }
    if (tab === 'location' && !locationFetched.current) {
      locationFetched.current = true;
      loadLocationData();
    }
    if (tab === 'ledger' && !ledgerFetched.current) {
      ledgerFetched.current = true;
      loadLedger();
    }
    if (tab === 'stoneLots' || tab === 'offcuts') {
      const timer = setTimeout(() => { void loadStoneLots(); }, 0);
      return () => clearTimeout(timer);
    }
  }, [tab, loadDeepInventory, loadLocationData, loadLedger, loadStoneLots]);

  useEffect(() => {
    if (!showStockModal) return;
    const timer = setTimeout(() => { setStockError(''); void loadLocationData(); }, 0);
    return () => clearTimeout(timer);
  }, [showStockModal, loadLocationData]);

  const filtered = useMemo(() => {
    const base = products.filter(p =>
      (productType === 'finished' ? !p.isRawMaterial : p.isRawMaterial) &&
      (category === 'All' || p.category === category) &&
      (warehouseFilter === 'All' || p.warehouse === warehouseFilter) &&
      (p.name.toLowerCase().includes(search.toLowerCase()) || p.category.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()))
    );
    return base;
  }, [category, warehouseFilter, search, products, productType]);

  // Derived slices for stats
  const finishedGoods = useMemo(() => products.filter(p => !p.isRawMaterial), [products]);
  const rawMaterials = useMemo(() => products.filter(p => p.isRawMaterial), [products]);
  const activeProducts = productType === 'finished' ? finishedGoods : rawMaterials;

  // Categories relevant to current type (excluding 'Raw Material' from finished goods list)
  const relevantCategories = useMemo(() => {
    const unique = [...new Set(activeProducts.map(p => p.category))];
    return ['All', ...unique.sort()];
  }, [activeProducts]);

  // Group godown stocks by product for location view
  const locationProducts = useMemo(() => {
    const map = {};
    const filteredGdStocks = godownStocks.filter(s =>
      (!selectedLocationGodown || s.godownId === Number(selectedLocationGodown)) &&
      (!locationSearch || s.product?.name?.toLowerCase().includes(locationSearch.toLowerCase()) || s.product?.sku?.toLowerCase().includes(locationSearch.toLowerCase()))
    );
    for (const s of filteredGdStocks) {
      if (!map[s.productId]) {
        map[s.productId] = { product: s.product, locations: [], totalQty: 0 };
      }
      map[s.productId].locations.push({ godown: s.godown, quantity: s.quantity });
      map[s.productId].totalQty += s.quantity;
    }
    return Object.values(map).sort((a, b) => b.totalQty - a.totalQty);
  }, [godownStocks, selectedLocationGodown, locationSearch]);

  const lowStockItems = activeProducts.filter(p => inventoryQuantity(p) > 0 && inventoryQuantity(p) <= p.reorderLevel);
  const outOfStockItems = activeProducts.filter(p => inventoryQuantity(p) === 0);
  const totalValue = activeProducts.reduce((sum, p) => sum + inventoryValue(p), 0);
  const needsReorder = [...lowStockItems, ...outOfStockItems].sort((a, b) => inventoryQuantity(a) - inventoryQuantity(b));

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-64 bg-surface rounded-lg" />
        <div className="flex gap-3">{[1, 2, 3, 4, 5].map(i => <div key={i} className="h-20 min-w-[160px] bg-surface rounded-2xl flex-1" />)}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-64 bg-surface rounded-2xl" />)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-[fade-in_0.5s_ease-out]">
      {pageError && <p role="alert" className="p-3 rounded-xl bg-danger-light text-danger">{pageError}</p>}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">{getTerm('inventoryUnit')} Inventory & Warehouse</h1>
          <p className="text-xs md:text-sm text-muted mt-1">
            {finishedGoods.length} finished goods · {rawMaterials.length} raw materials · {godowns.length || 1} location{godowns.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex w-full sm:w-auto items-center gap-2">
          <button aria-label="Refresh inventory" onClick={() => refreshProducts().catch(err => setPageError(err.message))} className="p-2.5 border border-border rounded-xl text-muted"><RefreshCw className="w-4 h-4" /></button>
          {tab === 'products' && productType === 'finished' && (
            <button
              onClick={() => { setImportResult(null); setImportRows([]); setImportError(''); setShowImportModal(true); }}
              className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-surface hover:bg-surface-hover border border-border text-muted hover:text-accent rounded-xl text-sm font-semibold transition-all"
            >
              <Upload className="w-4 h-4" /> Bulk Import
            </button>
          )}
          {tab === 'stoneLots' ? (
            <div className="flex gap-2">
              <button onClick={() => setShowSampleLoanModal(true)} className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-surface border border-border hover:border-accent/40 text-foreground rounded-xl text-sm font-semibold transition-all"><Package className="w-4 h-4" /> Issue Sample</button>
              <button
                onClick={() => setShowStoneLotModal(true)}
                className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"
              >
                <Plus className="w-4 h-4" /> Receive Stone Lot
              </button>
            </div>
          ) : tab === 'offcuts' ? null : !(tab === 'products' && productType === 'rawMaterial') && (
            <button
              onClick={() => setShowAddModal(true)}
              className="flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"
            >
              <Plus className="w-4 h-4" />
              Add Product
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="overflow-x-auto hide-scrollbar -mx-3.5 md:mx-0">
        <div className="flex bg-surface rounded-xl border border-border p-0.5 w-max min-w-full md:w-fit mx-3.5 md:mx-0">
          <button onClick={() => setTab('products')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'products' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <Package className="w-3.5 h-3.5" /> Products
          </button>
          {IS_TILES && (
            <button onClick={() => setTab('stoneLots')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'stoneLots' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
              <Layers className="w-3.5 h-3.5" /> Lot / Slab Explorer
            </button>
          )}
          {IS_TILES && <button onClick={() => setTab('offcuts')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'offcuts' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}><Package className="w-3.5 h-3.5" /> Stone Offcuts</button>}
          <button onClick={() => setTab('location')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'location' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <MapPin className="w-3.5 h-3.5" /> Location
          </button>
          <button onClick={() => setTab('alerts')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'alerts' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <Bell className="w-3.5 h-3.5" /> Alerts
            {needsReorder.length > 0 && (
              <span className="w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{needsReorder.length}</span>
            )}
          </button>
          <button onClick={() => setTab('ledger')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'ledger' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <FileText className="w-3.5 h-3.5" /> Ledger
          </button>
          <button onClick={() => setTab('stockGroups')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'stockGroups' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <Layers className="w-3.5 h-3.5" /> Groups
          </button>
          <button onClick={() => setTab('batches')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'batches' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <Boxes className="w-3.5 h-3.5" /> Batches
          </button>
          <button onClick={() => setTab('aging')} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs md:text-sm font-medium transition-all flex-shrink-0 ${tab === 'aging' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}>
            <Timer className="w-3.5 h-3.5" /> Aging
          </button>
        </div>
      </div>


      {tab === 'products' && (
        <>
          {/* Product Type Sub-Tabs */}
          <div className="flex items-center gap-2">
            <div className="flex bg-surface border border-border rounded-xl p-1 gap-0.5">
              <button
                onClick={() => { setProductType('finished'); setCategory('All'); setSearch(''); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${productType === 'finished'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-muted hover:text-foreground hover:bg-surface-hover'
                  }`}
              >
                <Package className="w-3.5 h-3.5" />
                Finished Goods
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${productType === 'finished' ? 'bg-white/20 text-white' : 'bg-surface-hover text-muted'
                  }`}>{finishedGoods.length}</span>
              </button>
              <button
                onClick={() => { setProductType('rawMaterial'); setCategory('All'); setSearch(''); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${productType === 'rawMaterial'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-muted hover:text-foreground hover:bg-surface-hover'
                  }`}
              >
                <Boxes className="w-3.5 h-3.5" />
                Raw Materials
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${productType === 'rawMaterial' ? 'bg-white/20 text-white' : 'bg-surface-hover text-muted'
                  }`}>{rawMaterials.length}</span>
              </button>
            </div>

          </div>

          {/* Stats */}
          <div className="flex gap-3 overflow-x-auto hide-scrollbar pb-1">
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className={`p-2.5 rounded-xl ${productType === 'rawMaterial' ? 'bg-accent-light' : 'bg-accent-light'}`}>
                {productType === 'rawMaterial' ? <Boxes className="w-5 h-5 text-accent" /> : <Package className="w-5 h-5 text-accent" />}
              </div>
              <div>
                <p className="text-xs text-muted">{productType === 'rawMaterial' ? 'Raw Materials' : 'Finished Goods'}</p>
                <p className="text-lg font-bold text-foreground">{activeProducts.length}</p>
              </div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-success-light"><TrendingUp className="w-5 h-5 text-success" /></div>
              <div>
                <p className="text-xs text-muted">{productType === 'rawMaterial' ? 'Material value (at cost)' : 'Stock value (at cost)'}</p>
                <p className="text-lg font-bold text-foreground">₹{(totalValue / 100000).toFixed(1)}L</p>
              </div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-warning-light"><AlertTriangle className="w-5 h-5 text-warning" /></div>
              <div><p className="text-xs text-muted">Low Stock</p><p className="text-lg font-bold text-warning">{lowStockItems.length}</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-danger-light"><XCircle className="w-5 h-5 text-danger" /></div>
              <div><p className="text-xs text-muted">Out of Stock</p><p className="text-lg font-bold text-danger">{outOfStockItems.length}</p></div>
            </div>
            <div className="glass-card p-4 flex items-center gap-3 min-w-[160px] flex-shrink-0">
              <div className="p-2.5 rounded-xl bg-info-light"><Warehouse className="w-5 h-5 text-info" /></div>
              <div><p className="text-xs text-muted">Locations</p><p className="text-lg font-bold text-foreground">{godowns.length || (warehouses.length - 1)}</p></div>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input type="text" placeholder={`Search ${productType === 'rawMaterial' ? 'raw materials' : 'products'} by name or SKU...`} value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-10 pr-4 py-3 md:py-2.5 bg-surface rounded-xl border border-border text-sm" />
            </div>
            <div className="flex items-center gap-2 md:contents">
              <div className="flex gap-1.5 md:gap-1 overflow-x-auto hide-scrollbar -mx-3.5 px-3.5 md:mx-0 md:px-0 flex-1 md:flex-none">
                {relevantCategories.map(cat => (
                  <button key={cat} onClick={() => setCategory(cat)} className={`flex-shrink-0 whitespace-nowrap px-3 py-2 md:py-1.5 rounded-lg text-xs font-medium transition-all ${category === cat ? 'bg-accent text-white' : 'bg-surface md:bg-transparent text-muted hover:text-foreground hover:bg-surface-hover'}`}>{cat}</button>
                ))}
              </div>
              <div className="flex bg-surface rounded-lg border border-border p-0.5 flex-shrink-0 ml-auto">
                <button onClick={() => setView('grid')} className={`p-2 rounded-md transition-all ${view === 'grid' ? 'bg-accent/20 text-accent' : 'text-muted'}`}><Grid3x3 className="w-4 h-4" /></button>
                <button onClick={() => setView('list')} className={`p-2 rounded-md transition-all ${view === 'list' ? 'bg-accent/20 text-accent' : 'text-muted'}`}><List className="w-4 h-4" /></button>
              </div>
            </div>
          </div>

          {view === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map(product => {
                const badge = stockBadge(inventoryQuantity(product), product.reorderLevel);
                const isBestSeller = !product.isRawMaterial && product.sold >= 30;
                // Get godown distribution for this product
                const godownDist = godownStocks.filter(gs => gs.productId === product.id);
                return (
                    <div key={product.id} className="glass-card overflow-hidden group hover:scale-[1.02] transition-transform cursor-pointer" onClick={() => product.isSlabTracked ? setTab('stoneLots') : setShowStockModal(product)}>
                    <div className="h-32 bg-surface flex items-center justify-center relative overflow-hidden">
                      {product.image && !product.image.includes('/') ? (
                        <span className="text-5xl">{product.image}</span>
                      ) : product.image ? (
                        <img src={product.image.split(',')[0]} alt={product.name} className="w-full h-full object-cover" />
                      ) : (
                        product.isRawMaterial ? <Boxes className="w-10 h-10 text-accent/40" /> : <Package className="w-10 h-10 text-muted/30" />
                      )}
                      {isBestSeller && (
                        <span className="absolute top-2 left-2 badge bg-accent text-white text-[10px]">Best Seller</span>
                      )}
                      {product.isRawMaterial && (
                        <span className="absolute top-2 left-2 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-accent/90 text-white">RAW MAT</span>
                      )}
                      <span className="absolute top-2 right-12 text-[10px] font-mono text-muted bg-surface-hover px-1.5 py-0.5 rounded">{product.sku}</span>
                      {!product.isRawMaterial && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openEditModal(product, e); }}
                          className="absolute top-10 right-2 p-1.5 rounded-md bg-accent-light text-accent md:bg-blue-50 md:text-blue-600"
                          title="Edit Product"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); handleMoveProductToDraft(product.id); }} className="absolute top-2 right-2 p-1.5 rounded-md bg-danger-light text-danger md:bg-red-50 md:text-red-600" title="Move to Draft" aria-label="Move product to drafts">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="p-4">
                      <div className="flex items-start justify-between mb-1">
                        <h3 className="text-sm font-semibold text-foreground leading-tight">{product.name}</h3>
                      </div>
                      <p className="text-xs text-muted mb-1">{product.category}{product.brand ? ` · ${product.brand}` : product.material ? ` · ${product.material}` : ''}</p>
                      <p className="text-[10px] text-muted mb-2 flex items-center gap-1"><Warehouse className="w-3 h-3" /> {product.warehouse}</p>

                      {/* Godown distribution */}
                      {godownDist.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {godownDist.map(gs => (
                            <span key={gs.id} className="text-[9px] px-1.5 py-0.5 rounded bg-surface-hover text-muted">
                              {gs.godown?.name}: {gs.quantity}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        {product.isRawMaterial ? (
                          <span className="text-base font-bold text-accent">₹{(product.costPrice || 0).toLocaleString()} <span className="text-[10px] font-normal text-muted">/ {inventoryUnitLabel(product)}</span></span>
                        ) : (
                          <span className="text-base font-bold text-accent">₹{product.price.toLocaleString()}</span>
                        )}
                        <span className={`badge text-[10px] ${badge.cls}`}>{badge.text}</span>
                      </div>
                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                        <span className="text-xs text-muted">{inventoryStockText(product)} in stock</span>
                        {product.isRawMaterial ? (
                          <span className="text-xs text-muted">Reorder @ {product.reorderLevel}</span>
                        ) : (
                          <span className="text-xs text-muted">{product.sold} sold</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="col-span-full glass-card p-12 text-center">
                  {productType === 'rawMaterial'
                    ? <Boxes className="w-10 h-10 text-accent/30 mx-auto mb-3" />
                    : <Package className="w-10 h-10 text-muted/30 mx-auto mb-3" />}
                  <p className="text-foreground font-medium">
                    No {productType === 'rawMaterial' ? 'raw materials' : 'finished goods'} found
                  </p>
                  <p className="text-xs text-muted mt-1">
                    {productType === 'rawMaterial'
                      ? 'Add raw materials from the Manufacturing module.'
                      : 'Click “Add Product” to add your first product.'}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Mobile stacked card list */}
              <div className="md:hidden space-y-3">
                {filtered.map(product => {
                  const badge = stockBadge(inventoryQuantity(product), product.reorderLevel);
                  const godownDist = godownStocks.filter(gs => gs.productId === product.id);
                  return (
                    <div
                      key={product.id}
                      onClick={() => product.isSlabTracked ? setTab('stoneLots') : setShowStockModal(product)}
                      className="glass-card p-3 flex items-center gap-3 active:scale-[0.99] transition-transform"
                    >
                      <div className="w-14 h-14 rounded-xl bg-surface flex items-center justify-center overflow-hidden flex-shrink-0">
                        {product.image && !product.image.includes('/') ? (
                          <span className="text-2xl">{product.image}</span>
                        ) : product.image ? (
                          <img src={product.image.split(',')[0]} alt={product.name} className="w-full h-full object-cover" />
                        ) : (
                          product.isRawMaterial ? <Boxes className="w-6 h-6 text-accent/40" /> : <Package className="w-6 h-6 text-muted/30" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-sm font-semibold text-foreground leading-tight truncate">{product.name}</h3>
                          <span className={`badge text-[10px] flex-shrink-0 ${badge.cls}`}>{badge.text}</span>
                        </div>
                        <p className="text-[11px] text-muted mt-0.5 truncate">
                          <span className="font-mono">{product.sku}</span> · {product.category}
                        </p>
                        <div className="flex items-center justify-between gap-2 mt-1.5">
                          {product.isRawMaterial ? (
                            <span className="text-sm font-bold text-accent">₹{(product.costPrice || 0).toLocaleString()}<span className="text-[10px] font-normal text-muted"> /{inventoryUnitLabel(product)}</span></span>
                          ) : (
                            <span className="text-sm font-bold text-accent">₹{product.price.toLocaleString()}</span>
                          )}
                          <span className="text-[11px] text-muted text-right">{inventoryStockText(product)} in stock</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); product.isSlabTracked ? setTab('stoneLots') : setShowStockModal(product); }}
                            className="touch-target flex-1 px-2 py-1.5 rounded-lg bg-surface-hover text-xs font-medium text-muted active:text-accent transition-colors"
                          >
                            {product.isSlabTracked ? 'View Lots' : 'Update Stock'}
                          </button>
                          {!product.isRawMaterial && (
                            <button
                              onClick={(e) => openEditModal(product, e)}
                              className="touch-target px-2.5 py-1.5 rounded-lg bg-accent-light text-xs font-medium text-accent flex items-center gap-1"
                            >
                              <Pencil className="w-3.5 h-3.5" /> Edit
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); handleMoveProductToDraft(product.id); }}
                            className="touch-target px-2.5 py-1.5 rounded-lg bg-danger-light text-danger flex items-center justify-center"
                            title="Move to Draft"
                            aria-label="Move product to drafts"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filtered.length === 0 && (
                  <div className="glass-card p-12 text-center">
                    {productType === 'rawMaterial'
                      ? <Boxes className="w-10 h-10 text-accent/30 mx-auto mb-3" />
                      : <Package className="w-10 h-10 text-muted/30 mx-auto mb-3" />}
                    <p className="text-foreground font-medium">No {productType === 'rawMaterial' ? 'raw materials' : 'finished goods'} found</p>
                  </div>
                )}
              </div>

              {/* Desktop table */}
              <div className="hidden md:block glass-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="crm-table">
                    <thead>
                      <tr>
                        <th>{productType === 'rawMaterial' ? 'Material' : 'Product'}</th>
                        <th>SKU</th>
                        <th>Category</th>
                        <th>{productType === 'rawMaterial' ? 'Cost / Unit' : 'Price'}</th>
                        <th>Stock</th>
                        <th>Godown Split</th>
                        <th>Reorder At</th>
                        {productType === 'rawMaterial' ? <th>UOM</th> : <th>Sold</th>}
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(product => {
                        const badge = stockBadge(inventoryQuantity(product), product.reorderLevel);
                        const godownDist = godownStocks.filter(gs => gs.productId === product.id);
                        return (
                          <tr key={product.id} className="cursor-pointer" onClick={() => product.isSlabTracked ? setTab('stoneLots') : setShowStockModal(product)}>
                            <td>
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center overflow-hidden flex-shrink-0">
                                  {product.image && !product.image.includes('/') ? (
                                    <span className="text-xl">{product.image}</span>
                                  ) : product.image ? (
                                    <img src={product.image.split(',')[0]} alt={product.name} className="w-full h-full object-cover" />
                                  ) : (
                                    <Package className="w-5 h-5 text-muted/30" />
                                  )}
                                </div>
                                <div>
                                  <p className="font-medium text-foreground">{product.name}</p>
                                  <p className="text-xs text-muted">{product.material} · {product.color}</p>
                                </div>
                              </div>
                            </td>
                            <td className="font-mono text-xs text-muted">{product.sku}</td>
                            <td>{product.category}</td>
                            {product.isRawMaterial ? (
                              <td className="text-accent font-semibold">₹{(product.costPrice || 0).toLocaleString()} <span className="text-[10px] text-muted font-normal">/{inventoryUnitLabel(product)}</span></td>
                            ) : (
                              <td className="text-accent font-semibold">₹{product.price.toLocaleString()}</td>
                            )}
                            <td className={`font-medium ${inventoryQuantity(product) <= product.reorderLevel ? 'text-danger' : 'text-foreground'}`}>{product.isSlabTracked ? `${inventoryQuantity(product)} / ${Number(product.availableStoneSqft || 0).toFixed(2)} sq.ft` : inventoryQuantity(product)}</td>
                            <td>
                              <div className="flex flex-wrap gap-1">
                                {godownDist.length > 0 ? godownDist.map(gs => (
                                  <span key={gs.id} className="text-[9px] px-1.5 py-0.5 rounded bg-surface-hover text-muted">{gs.godown?.name}: {gs.quantity}</span>
                                )) : <span className="text-[10px] text-muted">—</span>}
                              </div>
                            </td>
                            <td className="text-muted">{product.reorderLevel}</td>
                            {product.isRawMaterial ? (
                              <td className="text-muted text-xs">{inventoryUnitLabel(product)}</td>
                            ) : (
                              <td>{product.sold}</td>
                            )}
                            <td><span className={`badge ${badge.cls}`}>{badge.text}</span></td>
                            <td>
                              <div className="flex items-center gap-2">
                                <button onClick={(e) => { e.stopPropagation(); product.isSlabTracked ? setTab('stoneLots') : setShowStockModal(product); }} className="px-2 py-1 rounded-lg bg-surface-hover text-xs text-muted hover:text-accent transition-colors">
                                  {product.isSlabTracked ? 'View Lots' : 'Update Stock'}
                                </button>
                                {!product.isRawMaterial && (
                                  <button onClick={(e) => openEditModal(product, e)} className="px-2 py-1 rounded-lg bg-blue-50 text-xs text-blue-600 hover:bg-blue-100 transition-colors flex items-center gap-1">
                                    <Pencil className="w-3 h-3" /> Edit
                                  </button>
                                )}
                                <button onClick={(e) => { e.stopPropagation(); handleMoveProductToDraft(product.id); }} className="p-1.5 rounded-md bg-red-50 text-red-600" title="Move to Draft" aria-label="Move product to drafts">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ─── SERIALIZED STONE LOT / SLAB EXPLORER ─── */}
      {tab === 'stoneLots' && (
        <div className="space-y-4">
          <div className="glass-card p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-foreground">Granite & Marble Lots</h2>
              <p className="text-xs text-muted mt-1">Every slab remains individually measured, status-controlled, and traceable to its lot.</p>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-700">{stoneLots.reduce((sum, lot) => sum + lot.availableSlabs, 0)} available slabs</span>
              <span className="px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-700">{stoneLots.reduce((sum, lot) => sum + lot.availableSqft, 0).toFixed(2)} sq.ft available</span>
            </div>
          </div>

          {stoneLoading ? (
            <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>
          ) : stoneLots.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <Layers className="w-10 h-10 text-accent/35 mx-auto mb-3" />
              <p className="font-medium text-foreground">No stone lots received yet</p>
              <p className="text-xs text-muted mt-1">Create a slab-tracked granite or marble item, then receive its physical slabs here.</p>
            </div>
          ) : stoneLots.map(lot => (
            <div key={lot.id} className="glass-card overflow-hidden">
              <div className="p-4 border-b border-border flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
                <div className="flex items-start gap-3 min-w-0">
                  {lot.photos?.[0] ? (
                    <img
                      src={lot.photos[0]}
                      alt={`${lot.product.name} lot ${lot.lotNumber}`}
                      className="w-16 h-16 md:w-20 md:h-20 rounded-xl object-cover border border-border flex-shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 md:w-20 md:h-20 rounded-xl bg-surface flex items-center justify-center flex-shrink-0">
                      <Layers className="w-7 h-7 text-muted/40" />
                    </div>
                  )}
                  <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-foreground">{lot.product.name}</h3>
                    <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface-hover text-muted">Lot {lot.lotNumber}</span>
                    {lot.shadeCode && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700">Shade {lot.shadeCode}</span>}
                  </div>
                  <p className="text-xs text-muted mt-1">{lot.origin || 'Origin not recorded'} · {lot.qualityGrade || 'Grade not recorded'} · Cost ₹{lot.costPerSqft}/sq.ft</p>
                  </div>
                </div>
                <div className="text-sm md:text-right"><span className="font-bold text-foreground">{lot.availableSqft.toFixed(2)} sq.ft</span><span className="text-muted"> / {lot.totalSqft.toFixed(2)} sq.ft</span><p className="text-xs text-muted">{lot.availableSlabs} available · {lot.reservedSlabs} allocated</p></div>
              </div>
              <div className="overflow-x-auto">
                <table className="crm-table min-w-[800px]">
                   <thead><tr><th>Slab</th><th>Size</th><th>Measured Area</th><th>Thickness</th><th>Location</th><th>QC</th><th>Book match</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>{lot.slabs.map(slab => (
                    <tr key={slab.id}>
                      <td className="font-mono text-xs text-foreground">{slab.slabNumber}</td>
                      <td>{slab.lengthInches}″ × {slab.widthInches}″</td>
                      <td className="font-semibold">{slab.sqft.toFixed(2)} sq.ft</td>
                      <td>{slab.thicknessMm || lot.avgThicknessMm || '—'} mm</td>
                      <td>{slab.godown?.name || 'Unassigned'}</td>
                       <td>{slab.qcGrade || 'Not graded'}</td>
                       <td><select value={slab.bookMatchPairId || ''} onChange={async e => { const result = await pairSlabs({ slabId: slab.id, partnerId: e.target.value ? Number(e.target.value) : null }); if (result.success) { notify('Book-match pairing updated.', { variant: 'success' }); loadStoneLots(); } else notify(result.error || 'Could not pair slabs', { variant: 'danger' }); }} className="px-2 py-1.5 bg-surface border border-border rounded-lg text-xs"><option value="">None</option>{lot.slabs.filter(candidate => candidate.id !== slab.id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.slabNumber}</option>)}</select></td>
                      <td><span className={`badge ${slab.status === 'AVAILABLE' ? 'bg-success-light text-success' : slab.status === 'SOLD' ? 'bg-surface-hover text-muted' : slab.status === 'DAMAGED' ? 'bg-danger-light text-danger' : 'bg-warning-light text-warning'}`}>{slab.status.replace('_', ' ')}</span></td>
                      <td>{slab.status === 'AVAILABLE' || slab.status === 'DAMAGED' ? <button type="button" onClick={async () => {
                        const damaging = slab.status === 'AVAILABLE';
                        const question = damaging
                          ? `Write off slab ${slab.slabNumber} (${slab.sqft.toFixed(2)} sq.ft) as damaged? It leaves sellable stock. A manager can restore it if this was a mistake.`
                          : `Restore slab ${slab.slabNumber} to available stock?`;
                        if (!confirm(question)) return;
                        const result = await updateSlab({ slabId: slab.id, status: damaging ? 'DAMAGED' : 'AVAILABLE' });
                        if (result.success) { notify(damaging ? 'Slab written off' : 'Slab restored', { variant: 'success' }); loadStoneLots(); } else notify(result.error || 'Could not update slab', { variant: 'danger' });
                      }} className={`px-2 py-1.5 border rounded-lg text-xs ${slab.status === 'AVAILABLE' ? 'border-red-500/30 text-red-500 hover:bg-red-500/10' : 'border-border text-foreground hover:bg-surface-hover'}`}>{slab.status === 'AVAILABLE' ? 'Mark damaged' : 'Restore'}</button> : <span className="text-[11px] text-muted">Use the linked job / sample workflow</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="glass-card overflow-hidden">
            <div className="p-4 border-b border-border flex items-center justify-between"><div><h3 className="font-semibold text-foreground">Stone Samples Out</h3><p className="text-xs text-muted mt-1">Track sample pieces and sample slabs issued for customer approval. Converted slabs remain reserved until invoiced.</p></div><span className="text-xs text-muted">{sampleLoans.filter(loan => loan.status === 'OUT').length} open</span></div>
            {sampleLoans.length === 0 ? <p className="p-5 text-sm text-muted">No sample loans recorded.</p> : <div className="overflow-x-auto"><table className="crm-table min-w-[720px]"><thead><tr><th>Customer</th><th>Sample</th><th>Issued</th><th>Expected return</th><th>Status</th><th>Close</th></tr></thead><tbody>{sampleLoans.map(loan => <tr key={loan.id}><td><div className="font-medium">{loan.contact.name}</div><div className="text-xs text-muted">{loan.contact.phone}</div></td><td>{loan.slab ? `Lot ${loan.slab.lot.lotNumber} · Slab ${loan.slab.slabNumber}` : loan.product?.name || 'Sample item'}</td><td>{new Date(loan.checkoutDate).toLocaleDateString('en-IN')}</td><td>{loan.expectedReturn ? new Date(loan.expectedReturn).toLocaleDateString('en-IN') : '—'}</td><td><span className={`badge ${loan.status === 'OUT' ? 'bg-warning-light text-warning' : loan.status === 'RETURNED' ? 'bg-success-light text-success' : 'bg-danger-light text-danger'}`}>{loan.status.replaceAll('_', ' ')}</span></td><td>{loan.status === 'OUT' ? <select defaultValue="" onChange={async e => { if (!e.target.value) return; const result = await updateSampleLoanStatus({ id: loan.id, status: e.target.value }); if (result.success) { notify('Sample loan updated.', { variant: 'success' }); loadStoneLots(); } else notify(result.error || 'Could not update sample loan', { variant: 'danger' }); }} className="px-2 py-1.5 bg-surface border border-border rounded-lg text-xs"><option value="">Close as…</option><option value="RETURNED">Returned</option><option value="LOST">Lost / damaged</option></select> : '—'}</td></tr>)}</tbody></table></div>}
          </div>
        </div>
      )}

      {tab === 'offcuts' && IS_TILES && (
        <div className="space-y-4">
          <div className="glass-card p-4"><h2 className="font-semibold text-foreground">Reusable Stone Offcuts</h2><p className="text-xs text-muted mt-1">Remnants recorded from fabrication or sold slabs, available for thresholds, sills, jambs and small tops.</p></div>
          {stoneOffcuts.length === 0 ? <div className="glass-card p-10 text-center"><Package className="w-10 h-10 text-accent/30 mx-auto mb-3" /><p className="font-medium text-foreground">No stone offcuts recorded</p><p className="text-xs text-muted mt-1">Record remnants from the Manufacturing → Scrap Inventory tab after fabrication.</p></div> : <div className="glass-card overflow-hidden"><div className="overflow-x-auto"><table className="crm-table min-w-[820px]"><thead><tr><th>Material</th><th>Source</th><th>Size</th><th>Area</th><th>Shade</th><th>Resale price</th><th>Status</th><th>Action</th></tr></thead><tbody>{stoneOffcuts.map(offcut => <tr key={offcut.id}><td><p className="font-medium text-foreground">{offcut.rawMaterial?.name}</p><p className="text-[10px] font-mono text-muted">{offcut.rawMaterial?.sku}</p></td><td className="text-xs text-muted">{offcut.sourceSlab ? `Lot ${offcut.sourceSlab.lot?.lotNumber} · Slab ${offcut.sourceSlab.slabNumber}` : '—'}</td><td>{offcut.lengthInches || '—'}″ × {offcut.widthInches || '—'}″</td><td className="font-semibold">{offcut.areaSqft || offcut.quantity} sq.ft</td><td>{offcut.shadeCode || '—'}</td><td className="text-accent font-semibold">{offcut.salePrice ? `₹${offcut.salePrice.toLocaleString('en-IN')}` : 'On request'}</td><td><span className={`badge ${offcut.status === 'IN_STOCK' ? 'bg-success-light text-success' : 'bg-surface-hover text-muted'}`}>{offcut.status.replaceAll('_', ' ')}</span></td><td>{offcut.status === 'IN_STOCK' && <div className="flex gap-2"><button onClick={async () => { const result = await updateScrapInventoryStatus({ id: offcut.id, status: 'USED' }); if (result.success) loadStoneLots(); else notify(result.error || 'Could not update offcut', { variant: 'danger' }); }} className="text-xs text-accent hover:underline">Mark used</button><button onClick={async () => { const result = await updateScrapInventoryStatus({ id: offcut.id, status: 'DISPOSED' }); if (result.success) loadStoneLots(); else notify(result.error || 'Could not update offcut', { variant: 'danger' }); }} className="text-xs text-red-400 hover:underline">Dispose</button></div>}</td></tr>)}</tbody></table></div></div>}
        </div>
      )}

      {/* ─── LOCATION VIEW TAB ─── */}
      {tab === 'location' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
              <input value={locationSearch} onChange={e => setLocationSearch(e.target.value)} placeholder="Search products..." className="w-full pl-10 pr-4 py-2 bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50" />
            </div>
            <select value={selectedLocationGodown} onChange={e => setSelectedLocationGodown(e.target.value)} className="px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
              <option value="">All Locations</option>
              {godowns.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button onClick={loadLocationData} className="p-2 bg-surface border border-border rounded-lg text-muted hover:text-foreground"><RefreshCw className="w-4 h-4" /></button>
          </div>

          {locationLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>
          ) : (
            <div className="space-y-3">
              {locationProducts.map((item, idx) => (
                <div key={idx} className="glass-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-foreground text-sm">{item.product?.name}</h3>
                      <p className="text-[10px] text-muted font-mono">{item.product?.sku} · {item.product?.category?.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-foreground">{item.totalQty}</p>
                      <p className="text-[10px] text-muted">{inventoryUnitLabel(item.product)}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                    {item.locations.map((loc, li) => {
                      const pct = item.totalQty > 0 ? Math.round((loc.quantity / item.totalQty) * 100) : 0;
                      return (
                        <div key={li} className="bg-surface rounded-lg p-2.5 border border-border/50">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Warehouse className="w-3 h-3 text-muted" />
                            <span className="text-xs font-medium text-foreground truncate">{loc.godown?.name || 'Unassigned'}</span>
                          </div>
                          <div className="flex items-end justify-between">
                            <span className={`text-base font-bold ${loc.quantity <= 0 ? 'text-red-400' : loc.quantity < 5 ? 'text-amber-400' : 'text-emerald-400'}`}>{loc.quantity}</span>
                            <span className="text-[9px] text-muted">{pct}%</span>
                          </div>
                          <div className="h-1 bg-border rounded-full mt-1 overflow-hidden">
                            <div className="h-full bg-accent/60 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {locationProducts.length === 0 && (
                <div className="glass-card p-10 text-center">
                  <MapPin className="w-10 h-10 text-muted/30 mx-auto mb-3" />
                  <p className="text-foreground font-medium">No stock allocated to godowns yet</p>
                  <p className="text-xs text-muted mt-1">Go to Godowns → Sync Stock to allocate existing product stock to your godowns.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── STOCK LEDGER TAB ─── */}
      {tab === 'ledger' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">Complete audit trail of all stock movements</p>
            <button onClick={loadLedger} className="p-2 bg-surface border border-border rounded-lg text-muted hover:text-foreground"><RefreshCw className="w-4 h-4" /></button>
          </div>
          {ledgerLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div>
          ) : (
            <div className="glass-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border">
                    {['Date', 'Product', 'Godown', 'Type', 'Qty', 'Balance', 'Reference', 'Notes'].map(h => <th key={h} className="px-3 py-3 text-left text-xs font-medium text-muted uppercase whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {ledgerEntries.map(e => {
                      const typeColors = {
                        'IN': 'bg-emerald-500/10 text-emerald-400', 'OUT': 'bg-red-500/10 text-red-400',
                        'TRANSFER_IN': 'bg-blue-500/10 text-blue-400', 'TRANSFER_OUT': 'bg-orange-500/10 text-orange-400',
                        'ADJUSTMENT': 'bg-amber-500/10 text-amber-400', 'PRODUCTION': 'bg-purple-500/10 text-purple-400',
                        'SALE': 'bg-red-500/10 text-red-400', 'RETURN': 'bg-cyan-500/10 text-cyan-400',
                      };
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
                            <span className={`font-semibold flex items-center gap-0.5 ${e.quantity > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {e.quantity > 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                              {Math.abs(e.quantity)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-foreground font-medium text-xs">{e.balanceAfter}</td>
                          <td className="px-3 py-2.5 text-muted text-[10px]">{e.referenceType || '—'}</td>
                          <td className="px-3 py-2.5 text-muted text-[10px] max-w-[200px] truncate">{e.notes || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {ledgerEntries.length === 0 && <div className="text-center py-12 text-muted">No stock movements yet. Movements will appear here when stock is adjusted, transferred, or sold.</div>}
            </div>
          )}
        </div>
      )}

      {/* ─── STOCK ALERTS TAB ─── */}
      {tab === 'alerts' && (
        <div className="space-y-6">
          {needsReorder.length === 0 ? (
            <div className="glass-card p-10 text-center">
              <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-3" />
              <p className="text-foreground font-medium">All stock levels are healthy!</p>
              <p className="text-xs text-muted mt-1">No products need reordering right now.</p>
            </div>
          ) : (
            <>
              <div className="glass-card p-4 border-l-4 border-l-warning">
                <p className="text-sm text-foreground font-medium">{needsReorder.length} products need attention</p>
                <p className="text-xs text-muted mt-1">{outOfStockItems.length} out of stock, {lowStockItems.length} below reorder level</p>
              </div>

              <div className="glass-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="crm-table">
                    <thead>
                      <tr>
                        <th className="whitespace-nowrap">Product</th>
                        <th className="whitespace-nowrap">SKU</th>
                        <th className="whitespace-nowrap">Current Stock</th>
                        <th className="whitespace-nowrap">Reorder Level</th>
                        <th className="whitespace-nowrap">Shortfall</th>
                        <th className="whitespace-nowrap">Warehouse</th>
                        <th className="whitespace-nowrap">Last Restocked</th>
                        <th className="whitespace-nowrap">Priority</th>
                        <th className="whitespace-nowrap">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {needsReorder.map(product => {
                        const quantity = inventoryQuantity(product);
                        const shortfall = product.reorderLevel - quantity;
                        const isOut = quantity === 0;
                        return (
                          <tr key={product.id}>
                            <td className="whitespace-nowrap">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center overflow-hidden flex-shrink-0">
                                  {product.image && !product.image.includes('/') ? (
                                    <span className="text-lg">{product.image}</span>
                                  ) : product.image ? (
                                    <img src={product.image.split(',')[0]} alt={product.name} className="w-full h-full object-cover" />
                                  ) : (
                                    <Package className="w-4 h-4 text-muted/30" />
                                  )}
                                </div>
                                <div>
                                  <p className="font-medium text-foreground">{product.name}</p>
                                  <p className="text-xs text-muted">{product.category}</p>
                                </div>
                              </div>
                            </td>
                            <td className="font-mono text-xs text-muted whitespace-nowrap">{product.sku}</td>
                            <td className={`font-bold whitespace-nowrap ${isOut ? 'text-danger' : 'text-warning'}`}>{product.isSlabTracked ? `${quantity} slabs` : quantity}</td>
                            <td className="text-muted whitespace-nowrap">{product.reorderLevel}</td>
                            <td className="text-danger font-medium whitespace-nowrap">
                              {shortfall > 0 ? `Need ${shortfall} more` : 'Restocked'}
                            </td>
                            <td className="text-xs text-muted whitespace-nowrap">{product.warehouse}</td>
                            <td className="text-xs text-muted whitespace-nowrap">{product.lastRestocked}</td>
                            <td className="whitespace-nowrap">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${isOut ? 'bg-red-500/10 text-red-700 border-red-500/20' : 'bg-amber-500/10 text-amber-700 border-amber-500/20'}`}>
                                {isOut ? 'Urgent' : 'Low'}
                              </span>
                            </td>
                            <td className="whitespace-nowrap">
                              <button
                                onClick={() => product.isSlabTracked ? setTab('stoneLots') : setShowStockModal(product)}
                                className="px-3 py-1.5 rounded-lg bg-accent/10 text-accent text-xs font-medium hover:bg-accent/20 transition-colors border border-accent/20"
                              >
                                Restock
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── STOCK GROUPS TAB ─── */}
      {tab === 'stockGroups' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowGroupModal(true)} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2"><Plus className="w-4 h-4" /> Add Stock Group</button>
          </div>
          {deepLoading ? <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div> : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {stockGroups.map(g => (
                <div key={g.id} className="glass-card p-5">
                  <h3 className="font-semibold text-foreground">{g.name}</h3>
                  <p className="text-xs text-muted mt-1">Parent: {g.parent?.name || 'Root'}</p>
                  <div className="flex items-center gap-4 mt-3 text-sm text-muted">
                    <span>{g._count?.products || 0} products</span>
                    <span>{g._count?.children || 0} sub-groups</span>
                  </div>
                </div>
              ))}
              {stockGroups.length === 0 && <div className="col-span-full text-center py-12 text-muted">No stock groups created yet</div>}
            </div>
          )}
          <Modal isOpen={showGroupModal} onClose={() => setShowGroupModal(false)} title="Add Stock Group">
            <div className="space-y-4">
              <div>
                <label className="text-sm text-muted mb-1 block">Group Name *</label>
                <input value={groupForm.name} onChange={e => setGroupForm(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
              </div>
              <div>
                <label className="text-sm text-muted mb-1 block">Parent Group</label>
                <select value={groupForm.parentId} onChange={e => setGroupForm(p => ({ ...p, parentId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                  <option value="">None (Root)</option>
                  {stockGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <button onClick={async () => {
                const res = await createStockGroup({ name: groupForm.name, parentId: groupForm.parentId ? Number(groupForm.parentId) : undefined });
                if (res.success) { setShowGroupModal(false); setGroupForm({ name: '', parentId: '' }); loadDeepInventory(); }
                else alert(res.error);
              }} disabled={!groupForm.name} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">Create Stock Group</button>
            </div>
          </Modal>
        </div>
      )}

      {/* ─── BATCHES TAB ─── */}
      {tab === 'batches' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => setShowBatchModal(true)} className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 flex items-center gap-2"><Plus className="w-4 h-4" /> Add Batch</button>
          </div>
          {deepLoading ? <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div> : (
            <div className="glass-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border">
                    {['Product', 'SKU', 'Batch #', 'Purchase Date', 'Expiry', 'Original Qty', 'Remaining', 'Cost Price'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {batches.map(b => (
                      <tr key={b.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                        <td className="px-4 py-3 text-foreground font-medium whitespace-nowrap">{b.product?.name}</td>
                        <td className="px-4 py-3 text-muted font-mono text-xs whitespace-nowrap">{b.product?.sku}</td>
                        <td className="px-4 py-3 text-foreground whitespace-nowrap">{b.batchNumber}</td>
                        <td className="px-4 py-3 text-muted whitespace-nowrap">{new Date(b.purchaseDate).toLocaleDateString('en-IN')}</td>
                        <td className="px-4 py-3 text-muted whitespace-nowrap">{b.expiryDate ? new Date(b.expiryDate).toLocaleDateString('en-IN') : '—'}</td>
                        <td className="px-4 py-3 text-foreground whitespace-nowrap">{b.quantity}</td>
                        <td className="px-4 py-3 whitespace-nowrap"><span className={`font-medium ${b.remainingQty <= 0 ? 'text-red-400' : b.remainingQty < b.quantity * 0.2 ? 'text-amber-400' : 'text-emerald-400'}`}>{b.remainingQty}</span></td>
                        <td className="px-4 py-3 text-foreground whitespace-nowrap">₹{b.costPrice?.toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {batches.length === 0 && <div className="text-center py-12 text-muted">No batch records found</div>}
            </div>
          )}
          <Modal isOpen={showBatchModal} onClose={() => setShowBatchModal(false)} title="Add Batch">
            <div className="space-y-4">
              <div>
                <label className="text-sm text-muted mb-1 block">Product *</label>
                <select value={batchForm.productId} onChange={e => setBatchForm(p => ({ ...p, productId: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground">
                  <option value="">Select Product</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-muted mb-1 block">Batch Number *</label>
                  <input value={batchForm.batchNumber} onChange={e => setBatchForm(p => ({ ...p, batchNumber: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Shade / Dye Lot</label>
                  <input value={batchForm.shadeCode} onChange={e => setBatchForm(p => ({ ...p, shadeCode: e.target.value }))} placeholder="e.g. SH-24A" className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
                </div>
                <div>
                  <label className="text-sm text-muted mb-1 block">Cost Price</label>
                  <input type="number" min="0" value={batchForm.costPrice} onChange={e => setBatchForm(p => ({ ...p, costPrice: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-muted mb-1 block">Purchase Date</label>
                  <input type="date" value={batchForm.purchaseDate} onChange={e => setBatchForm(p => ({ ...p, purchaseDate: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                </div>
                <div>
                  <label className="text-sm text-muted mb-1 block">Expiry Date</label>
                  <input type="date" value={batchForm.expiryDate} onChange={e => setBatchForm(p => ({ ...p, expiryDate: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-muted mb-1 block">Quantity *</label>
                  <input type="number" min="1" value={batchForm.quantity} onChange={e => setBatchForm(p => ({ ...p, quantity: e.target.value, remainingQty: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                </div>
                <div>
                  <label className="text-sm text-muted mb-1 block">Remaining Qty</label>
                  <input type="number" min="0" value={batchForm.remainingQty} onChange={e => setBatchForm(p => ({ ...p, remainingQty: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground" />
                </div>
              </div>
              <p className="text-xs text-muted">Assign a batch/shade to existing unassigned stock. To receive new supplier stock, use Purchases or add stock first.</p>
              <button onClick={async () => {
                if (batchSaving) return;
                setBatchSaving(true);
                try {
                const res = await createBatch({
                  productId: Number(batchForm.productId), batchNumber: batchForm.batchNumber,
                  shadeCode: batchForm.shadeCode || undefined,
                  purchaseDate: batchForm.purchaseDate || undefined, expiryDate: batchForm.expiryDate || undefined,
                  quantity: Number(batchForm.quantity), remainingQty: Number(batchForm.remainingQty), costPrice: Number(batchForm.costPrice)
                });
                if (res.success) { setShowBatchModal(false); setBatchForm({ productId: '', batchNumber: '', shadeCode: '', purchaseDate: '', expiryDate: '', quantity: 1, remainingQty: 1, costPrice: 0 }); await refreshProducts(); await loadDeepInventory(); }
                else notify(res.error, { variant: 'danger' });
                } catch (err) { notify(err.message || 'Could not create batch', { variant: 'danger' }); }
                finally { setBatchSaving(false); }
              }} disabled={batchSaving || !batchForm.productId || !batchForm.batchNumber} className="w-full py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50">Create Batch</button>
            </div>
          </Modal>
        </div>
      )}

      {/* ─── AGING ANALYSIS TAB ─── */}
      {tab === 'aging' && (
        <div className="space-y-4">
          {deepLoading ? <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" /></div> : (
            <>
              {agingData.length > 0 ? (
                <>
                  {/* Batch-based aging (when batch records exist) */}
                  <div className="glass-card p-3 border-l-4 border-accent">
                    <p className="text-xs text-muted">Showing batch-level aging. Each row represents a product batch received from a supplier.</p>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                    {['0-30 days', '31-60 days', '61-90 days', '91-180 days', '180+ days'].map(bracket => {
                      const items = agingData.filter(a => a.bracket === bracket);
                      const value = items.reduce((s, a) => s + a.value, 0);
                      const colors = { '0-30 days': 'text-emerald-400', '31-60 days': 'text-blue-400', '61-90 days': 'text-amber-400', '91-180 days': 'text-orange-400', '180+ days': 'text-red-400' };
                      return (
                        <div key={bracket} className="glass-card p-4">
                          <p className="text-xs text-muted">{bracket}</p>
                          <p className={`text-lg font-semibold ${colors[bracket]}`}>₹{value.toLocaleString('en-IN')}</p>
                          <p className="text-xs text-muted">{items.length} batches</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="glass-card overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="border-b border-border">
                          {['Product', 'SKU', 'Category', 'Batch #', 'Age (Days)', 'Bracket', 'Remaining', 'Value'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase whitespace-nowrap">{h}</th>)}
                        </tr></thead>
                        <tbody>
                          {agingData.map((a, i) => (
                            <tr key={i} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                              <td className="px-4 py-3 text-foreground font-medium whitespace-nowrap">{a.product?.name}</td>
                              <td className="px-4 py-3 text-muted font-mono text-xs whitespace-nowrap">{a.product?.sku}</td>
                              <td className="px-4 py-3 text-muted whitespace-nowrap">{a.product?.category?.name || '—'}</td>
                              <td className="px-4 py-3 text-foreground whitespace-nowrap">{a.batchNumber}</td>
                              <td className="px-4 py-3 text-foreground whitespace-nowrap">{a.ageDays}</td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <span className={`px-2 py-1 rounded-full text-xs font-medium ${a.bracket === '180+ days' ? 'bg-red-500/10 text-red-400' :
                                  a.bracket === '91-180 days' ? 'bg-orange-500/10 text-orange-400' :
                                    a.bracket === '61-90 days' ? 'bg-amber-500/10 text-amber-400' :
                                      'bg-emerald-500/10 text-emerald-400'
                                  }`}>{a.bracket}</span>
                              </td>
                              <td className="px-4 py-3 text-foreground whitespace-nowrap">{a.remainingQty}</td>
                              <td className="px-4 py-3 text-foreground whitespace-nowrap">₹{a.value?.toLocaleString('en-IN')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Product-based aging fallback (when no batch records) */}
                  <div className="glass-card p-3 border-l-4 border-amber-500">
                    <p className="text-xs text-foreground font-medium">Showing product-level aging based on last restock date.</p>
                    <p className="text-xs text-muted mt-0.5">For batch-level aging (FIFO/FEFO), add batches in the Batches tab when you receive stock.</p>
                  </div>
                  {(() => {
                    const now = new Date();
                    const productAging = products
                      .filter(p => inventoryQuantity(p) > 0)
                      .map(p => {
                        const refDate = p.lastRestocked ? new Date(p.lastRestocked) : new Date(p.createdAt || now);
                        const ageDays = Math.floor((now - refDate) / (1000 * 60 * 60 * 24));
                        let bracket = '0-30 days';
                        if (ageDays > 180) bracket = '180+ days';
                        else if (ageDays > 90) bracket = '91-180 days';
                        else if (ageDays > 60) bracket = '61-90 days';
                        else if (ageDays > 30) bracket = '31-60 days';
                        return { ...p, ageDays, bracket, value: inventoryValue(p), inventoryQuantity: inventoryQuantity(p) };
                      })
                      .sort((a, b) => b.ageDays - a.ageDays);

                    const bracketColors = { '0-30 days': 'text-emerald-400', '31-60 days': 'text-blue-400', '61-90 days': 'text-amber-400', '91-180 days': 'text-orange-400', '180+ days': 'text-red-400' };
                    const bracketBg = { '0-30 days': 'bg-emerald-500/10', '31-60 days': 'bg-blue-500/10', '61-90 days': 'bg-amber-500/10', '91-180 days': 'bg-orange-500/10', '180+ days': 'bg-red-500/10' };

                    return (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                          {['0-30 days', '31-60 days', '61-90 days', '91-180 days', '180+ days'].map(bracket => {
                            const items = productAging.filter(p => p.bracket === bracket);
                            const value = items.reduce((s, p) => s + p.value, 0);
                            return (
                              <div key={bracket} className="glass-card p-4">
                                <p className="text-xs text-muted">{bracket}</p>
                                <p className={`text-lg font-semibold ${bracketColors[bracket]}`}>₹{value.toLocaleString('en-IN')}</p>
                                <p className="text-xs text-muted">{items.length} products</p>
                              </div>
                            );
                          })}
                        </div>
                        <div className="glass-card overflow-hidden">
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead><tr className="border-b border-border">
                                {['Product', 'SKU', 'Category', 'Last Restocked', 'Age (Days)', 'Bracket', 'Stock', 'Value'].map(h => <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase whitespace-nowrap">{h}</th>)}
                              </tr></thead>
                              <tbody>
                                {productAging.length === 0
                                  ? <tr><td colSpan={8} className="text-center py-12 text-muted">No in-stock products found.</td></tr>
                                  : productAging.map((p, i) => (
                                    <tr key={i} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                                      <td className="px-4 py-3 text-foreground font-medium whitespace-nowrap">{p.name}</td>
                                      <td className="px-4 py-3 text-muted font-mono text-xs whitespace-nowrap">{p.sku}</td>
                                      <td className="px-4 py-3 text-muted whitespace-nowrap">{p.category || '—'}</td>
                                      <td className="px-4 py-3 text-muted whitespace-nowrap">{p.lastRestocked ? new Date(p.lastRestocked).toLocaleDateString('en-IN') : 'Not recorded'}</td>
                                      <td className="px-4 py-3 text-foreground whitespace-nowrap">{p.ageDays}d</td>
                                      <td className="px-4 py-3 whitespace-nowrap">
                                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${bracketBg[p.bracket]} ${bracketColors[p.bracket]}`}>{p.bracket}</span>
                                      </td>
                                      <td className="px-4 py-3 text-foreground whitespace-nowrap">{p.isSlabTracked ? `${p.inventoryQuantity} slabs` : p.inventoryQuantity}</td>
                                      <td className="px-4 py-3 text-foreground whitespace-nowrap">₹{p.value.toLocaleString('en-IN')}</td>
                                    </tr>
                                  ))
                                }
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </>
          )}
        </div>
      )}

      <Modal isOpen={showStoneLotModal} onClose={() => setShowStoneLotModal(false)} title="Receive Granite / Marble Lot" size="lg" fullScreenMobile>
        <form className="space-y-4" onSubmit={async e => {
          e.preventDefault();
          const lines = stoneLotForm.slabsText.split('\n').map(line => line.trim()).filter(Boolean);
          const slabs = lines.map(line => {
            const parts = line.split(',').map(value => value.trim());
            return { slabNumber: parts[0] || '', lengthInches: Number(parts[1]), widthInches: Number(parts[2]), valid: parts.length === 3 && Boolean(parts[0]) && Number(parts[1]) > 0 && Number(parts[2]) > 0 };
          });
          if (!stoneLotForm.productId || slabs.length === 0 || slabs.some(slab => !slab.valid)) { notify('Fix every slab row. Use: slab number, length in inches, width in inches.', { variant: 'danger' }); return; }
          const duplicateNumbers = slabs.map(slab => slab.slabNumber.toLowerCase()).filter((number, index, values) => values.indexOf(number) !== index);
          if (duplicateNumbers.length > 0) { notify(`Duplicate slab number: ${duplicateNumbers[0]}`, { variant: 'danger' }); return; }
          const normalizedSlabs = slabs.map(({ valid, ...slab }) => slab);
           let photos = [];
           if (stoneLotPhotos.length > 0) {
             const formData = new FormData();
             formData.set('folder', 'stone-lots');
             stoneLotPhotos.forEach(file => formData.append('files', file));
             const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
             const uploadData = await uploadRes.json();
             if (!uploadRes.ok || !uploadData.success) { notify(uploadData.error || 'Could not upload lot photos', { variant: 'danger' }); return; }
             photos = uploadData.urls || [];
           }
           const result = await createStoneLot({
            productId: Number(stoneLotForm.productId), godownId: stoneLotForm.godownId ? Number(stoneLotForm.godownId) : undefined,
            lotNumber: stoneLotForm.lotNumber, origin: stoneLotForm.origin || undefined, shadeCode: stoneLotForm.shadeCode || undefined,
            qualityGrade: stoneLotForm.qualityGrade || undefined, avgThicknessMm: stoneLotForm.thicknessMm ? Number(stoneLotForm.thicknessMm) : undefined,
             costPerSqft: Number(stoneLotForm.costPerSqft) || 0, notes: stoneLotForm.notes || undefined, photos, slabs: normalizedSlabs,
           });
           if (result.success) { setShowStoneLotModal(false); setStoneLotPhotos([]); setStoneLotForm({ productId: '', godownId: '', lotNumber: '', origin: '', shadeCode: '', qualityGrade: '', thicknessMm: '', costPerSqft: '', notes: '', slabsText: '01/01, 120, 72' }); await loadStoneLots(); notify('Stone lot received with individually measured slabs.', { variant: 'success' }); }
          else notify(result.error || 'Could not receive stone lot', { variant: 'danger' });
        }}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><label className="text-xs text-muted block mb-1">Stone item *</label><select required value={stoneLotForm.productId} onChange={e => setStoneLotForm(form => ({ ...form, productId: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm"><option value="">Select slab-tracked item</option>{products.filter(product => product.isSlabTracked).map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></div>
            <div><label className="text-xs text-muted block mb-1">Stone yard / godown</label><select value={stoneLotForm.godownId} onChange={e => setStoneLotForm(form => ({ ...form, godownId: e.target.value }))} className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm"><option value="">Unassigned</option>{godowns.map(godown => <option key={godown.id} value={godown.id}>{godown.name}</option>)}</select></div>
            <div><label className="text-xs text-muted block mb-1">Lot number *</label><input required value={stoneLotForm.lotNumber} onChange={e => setStoneLotForm(form => ({ ...form, lotNumber: e.target.value }))} placeholder="e.g. TB-2608-A" className="w-full" /></div>
            <div><label className="text-xs text-muted block mb-1">Shade / block code</label><input value={stoneLotForm.shadeCode} onChange={e => setStoneLotForm(form => ({ ...form, shadeCode: e.target.value }))} placeholder="e.g. TB-AUG-26" className="w-full" /></div>
            <div><label className="text-xs text-muted block mb-1">Quarry / origin</label><input value={stoneLotForm.origin} onChange={e => setStoneLotForm(form => ({ ...form, origin: e.target.value }))} placeholder="e.g. Andhra Pradesh" className="w-full" /></div>
            <div><label className="text-xs text-muted block mb-1">Grade</label><input value={stoneLotForm.qualityGrade} onChange={e => setStoneLotForm(form => ({ ...form, qualityGrade: e.target.value }))} placeholder="Premium / Grade A" className="w-full" /></div>
            <div><label className="text-xs text-muted block mb-1">Thickness (mm)</label><input type="number" min="1" step="0.1" value={stoneLotForm.thicknessMm} onChange={e => setStoneLotForm(form => ({ ...form, thicknessMm: e.target.value }))} className="w-full" /></div>
            <div><label className="text-xs text-muted block mb-1">Cost / sq.ft (₹)</label><input type="number" min="0" value={stoneLotForm.costPerSqft} onChange={e => setStoneLotForm(form => ({ ...form, costPerSqft: e.target.value }))} className="w-full" /></div>
          </div>
          <div><label className="text-xs text-muted block mb-1">Slabs *</label><textarea required rows={5} value={stoneLotForm.slabsText} onChange={e => setStoneLotForm(form => ({ ...form, slabsText: e.target.value }))} placeholder={'One per line: slab number, length in inches, width in inches\n01/01, 120, 72'} className="w-full" /><p className="text-[11px] text-muted mt-1">Area is calculated automatically as length × width ÷ 144. Do not receive slabs as product quantity.</p></div>
          <div><label className="text-xs text-muted block mb-1">Lot / slab photos</label><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => setStoneLotPhotos(Array.from(e.target.files || []).slice(0, 5))} className="w-full text-xs" /><p className="text-[11px] text-muted mt-1">Upload up to five photos for vein, shade and QC reference.</p></div>
          <div><label className="text-xs text-muted block mb-1">Notes</label><textarea id="stockNotes" rows={2} value={stoneLotForm.notes} onChange={e => setStoneLotForm(form => ({ ...form, notes: e.target.value }))} className="w-full" /></div>
          <button className="w-full py-2.5 bg-accent text-white rounded-xl text-sm font-semibold">Receive lot and slabs</button>
        </form>
      </Modal>

      <Modal isOpen={showSampleLoanModal} onClose={() => setShowSampleLoanModal(false)} title="Issue Stone Sample" size="md" fullScreenMobile>
        <form className="space-y-4" onSubmit={async e => {
          e.preventDefault();
          const result = await createSampleLoan({ customerName: sampleLoanForm.customerName, customerPhone: sampleLoanForm.customerPhone, productId: sampleLoanForm.productId ? Number(sampleLoanForm.productId) : undefined, slabId: sampleLoanForm.slabId ? Number(sampleLoanForm.slabId) : undefined, expectedReturn: sampleLoanForm.expectedReturn || undefined, notes: sampleLoanForm.notes || undefined });
          if (result.success) { setShowSampleLoanModal(false); setSampleLoanForm({ customerName: '', customerPhone: '', productId: '', slabId: '', expectedReturn: '', notes: '' }); await loadStoneLots(); notify('Sample issued and recorded.', { variant: 'success' }); }
          else notify(result.error || 'Could not issue sample', { variant: 'danger' });
        }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label className="text-xs text-muted block mb-1">Customer name *</label><input required value={sampleLoanForm.customerName} onChange={e => setSampleLoanForm(form => ({ ...form, customerName: e.target.value }))} className="w-full" /></div><div><label className="text-xs text-muted block mb-1">Phone *</label><input required minLength="10" value={sampleLoanForm.customerPhone} onChange={e => setSampleLoanForm(form => ({ ...form, customerPhone: e.target.value }))} className="w-full" /></div></div>
          <div><label className="text-xs text-muted block mb-1">Sample slab (optional)</label><select value={sampleLoanForm.slabId} onChange={e => setSampleLoanForm(form => ({ ...form, slabId: e.target.value, productId: e.target.value ? '' : form.productId }))} className="w-full"><option value="">Select a physical slab</option>{stoneLots.flatMap(lot => lot.slabs.filter(slab => slab.status === 'AVAILABLE').map(slab => <option key={slab.id} value={slab.id}>{lot.product.name} · Lot {lot.lotNumber} · {slab.slabNumber} ({slab.sqft.toFixed(2)} sq.ft)</option>))}</select></div>
          <div><label className="text-xs text-muted block mb-1">Sample item (optional)</label><select value={sampleLoanForm.productId} onChange={e => setSampleLoanForm(form => ({ ...form, productId: e.target.value, slabId: e.target.value ? '' : form.slabId }))} className="w-full"><option value="">Select catalog item</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select><p className="text-[11px] text-muted mt-1">Select a slab or a catalog item. A slab is reserved until it is returned or closed.</p></div>
          <div><label className="text-xs text-muted block mb-1">Expected return</label><input type="date" value={sampleLoanForm.expectedReturn} onChange={e => setSampleLoanForm(form => ({ ...form, expectedReturn: e.target.value }))} className="w-full" /></div>
          <div><label className="text-xs text-muted block mb-1">Notes</label><textarea id="stockNotes" rows={2} value={sampleLoanForm.notes} onChange={e => setSampleLoanForm(form => ({ ...form, notes: e.target.value }))} className="w-full" /></div>
          <button className="w-full py-2.5 bg-accent text-white rounded-xl text-sm font-semibold">Issue sample</button>
        </form>
      </Modal>

      {/* Add Product / Raw Material Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => { setShowAddModal(false); setProductImages([]); }}
        title={tab === 'products' && productType === 'rawMaterial' ? 'Add Raw Material' : 'Add New Product'}
        fullScreenMobile
        footer={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => { setShowAddModal(false); setProductImages([]); }}
              className="hidden md:inline-flex px-4 py-2.5 rounded-xl text-sm text-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="add-product-form"
              disabled={addingProduct}
              className={`flex-1 md:flex-none md:ml-auto justify-center px-6 py-3 md:py-2.5 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-all flex items-center gap-2 ${tab === 'products' && productType === 'rawMaterial'
                ? 'bg-orange-500 hover:bg-orange-600'
                : 'bg-accent hover:bg-accent-hover'
                }`}
            >
              {addingProduct
                ? <><RefreshCw className="w-4 h-4 animate-spin" /> Adding...</>
                : tab === 'products' && productType === 'rawMaterial' ? 'Add Raw Material' : 'Add Product'
              }
            </button>
          </div>
        }
      >
        <form id="add-product-form" className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          setAddingProduct(true);
          const f = e.target;
          const isRawMode = tab === 'products' && productType === 'rawMaterial';
          // Upload images first
          let imageUrl = '';
          if (productImages.length > 0) {
            const formData = new FormData();
            formData.set('folder', 'products');
            productImages.forEach(p => formData.append('files', p.file));
            try {
              const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
              const uploadData = await uploadRes.json();
              if (uploadData.success && uploadData.urls.length > 0) {
                imageUrl = uploadData.urls.join(',');
              } else if (uploadData.error) {
                notify(uploadData.error, { variant: 'danger' });
              }
            } catch (err) {
              notify('Image upload failed — product will be saved without image.', { variant: 'warning' });
            }
          }
          const selectedGodownId = f.godownId?.value ? Number(f.godownId.value) : undefined;
          // Tiles vertical: capture the Tiles_Attribute_Set + SQFT/BOX unit (Requirement 6.1, 6.3).
          const showTilesInputs = IS_TILES && !isRawMode;
          const tilesAttrs = showTilesInputs ? {
            tileSize: f.tileSize?.value || undefined,
            finish: f.finish?.value || undefined,
            surfaceType: f.surfaceType?.value || undefined,
            applicationArea: f.applicationArea?.value || undefined,
            coveragePerBox: f.coveragePerBox?.value ? Number(f.coveragePerBox.value) : undefined,
            tilesPerBox: f.tilesPerBox?.value ? Number(f.tilesPerBox.value) : undefined,
            materialCategory: f.materialCategory?.value || undefined,
            isSlabTracked: f.isSlabTracked?.checked || false,
            origin: f.origin?.value || undefined,
            thicknessMm: f.thicknessMm?.value ? Number(f.thicknessMm.value) : undefined,
            qualityGrade: f.qualityGrade?.value || undefined,
            bookMatchPair: f.bookMatchPair?.checked || false,
          } : {};
          const unitOfMeasure = isRawMode
            ? (f.unitOfMeasure?.value || 'PCS')
            : showTilesInputs
              ? (f.unitOfMeasure?.value || 'PCS')
              : 'PCS';
          try {
          const res = await createProduct({
            name: f.productName.value,
            sku: f.sku.value,
            category: isRawMode ? 'Raw Material' : f.category.value,
            price: isRawMode ? 0 : Number(f.price.value),
            costPrice: isRawMode ? Number(f.costPrice?.value || 0) : Number(f.finishedCostPrice?.value || 0),
            material: f.material?.value || '',
            color: f.color?.value || '',
            stock: Number(f.stock.value),
            reorderLevel: Number(f.reorderLevel.value),
            unitOfMeasure,
            warehouse: f.warehouse?.value || '',
            description: f.description.value,
            image: imageUrl || '',
            godownId: selectedGodownId,
            ...tilesAttrs,
          });
          if (res.success) { setShowAddModal(false); setProductImages([]); await refreshProducts(); await loadLocationData(); }
          else if (res.error) alert(res.error);
          } catch (err) { notify(err.message || 'Could not create product', { variant: 'danger' }); }
          finally { setAddingProduct(false); }
        }}>

          {/* Mode indicator for raw materials */}
          {tab === 'products' && productType === 'rawMaterial' && (
            <div className="flex items-center gap-2 p-3 bg-orange-500/10 border border-orange-500/20 rounded-xl">
              <Boxes className="w-4 h-4 text-orange-500 flex-shrink-0" />
              <p className="text-xs text-orange-600">Raw materials are tracked for manufacturing use and are not listed for sale.</p>
            </div>
          )}

          {/* Product Images */}
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Images (optional)</label>
            <div className="flex gap-3 flex-wrap">
              {productImages.map((img, i) => (
                <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden border border-border group">
                  <img src={img.preview} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => { URL.revokeObjectURL(img.preview); setProductImages(prev => prev.filter((_, j) => j !== i)); }}
                    className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                </div>
              ))}
              {productImages.length < 5 && (
                <label className="w-20 h-20 rounded-xl border-2 border-dashed border-border hover:border-accent/50 flex flex-col items-center justify-center cursor-pointer transition-colors">
                  <Plus className="w-5 h-5 text-muted" />
                  <span className="text-[10px] text-muted mt-0.5">Add</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    if (productImages.length + files.length > 5) { alert('Maximum 5 images'); return; }
                    const previews = files.map(f => ({ file: f, preview: URL.createObjectURL(f) }));
                    setProductImages(prev => [...prev, ...previews]);
                    e.target.value = '';
                  }} />
                </label>
              )}
            </div>
            <p className="text-[10px] text-muted mt-1">Upload up to 5 images (JPG, PNG, WebP · max 10MB each)</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">
                {tab === 'products' && productType === 'rawMaterial' ? 'Material Name' : 'Product Name'} *
              </label>
              <input type="text" name="productName" required
                placeholder={tab === 'products' && productType === 'rawMaterial' ? (IS_TILES ? 'e.g., Tile Adhesive / Grout' : 'e.g., Sheesham Wood Plank') : (IS_TILES ? 'e.g., Black Galaxy Granite Slab' : 'e.g., Royal L-Shaped Sofa')}
                className="w-full" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">SKU Code *</label>
              <input type="text" name="sku" required
                placeholder={tab === 'products' && productType === 'rawMaterial' ? 'e.g., RM-001' : 'e.g., SOF-005'}
                className="w-full" />
            </div>
          </div>

          {/* Category — hidden/fixed for raw materials */}
          {tab === 'products' && productType === 'rawMaterial' ? (
            <div className="p-2.5 bg-surface rounded-xl border border-border flex items-center gap-2">
              <span className="text-xs text-muted">Category:</span>
              <span className="text-xs font-semibold text-orange-500">Raw Material</span>
              <span className="text-[10px] text-muted ml-auto">(auto-assigned)</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Category *</label>
                <input type="text" name="category" required placeholder={IS_TILES ? 'e.g., Floor Tiles, Wall Tiles, Granite' : 'e.g., Sofas, Beds, Tables'} className="w-full" list="categoryList" />
                <datalist id="categoryList">
                  {categories.filter(c => c !== 'All' && c !== 'Raw Material').map(c => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Selling price (₹ per unit) *</label>
                <input type="number" name="price" required min="0" placeholder="0" className="w-full" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Cost price (₹ per unit)</label>
                <input type="number" name="finishedCostPrice" min="0" placeholder="What you pay the supplier" className="w-full" />
                <span className="text-[11px] text-muted mt-1 block">Values opening stock; receipts keep it updated after that.</span>
              </div>
            </div>
          )}

          {/* Cost price + UOM for raw materials */}
          {tab === 'products' && productType === 'rawMaterial' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Cost Price (₹/unit)</label>
                <input type="number" name="costPrice" min="0" placeholder="0" className="w-full" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Unit of Measure</label>
                <select name="unitOfMeasure" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                  {['PCS', 'KG', 'L', 'M', 'M2', 'M3', 'FT', 'INCH', 'SET', 'BOX', 'ROLL', 'SHEET'].map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {tab !== 'products' || productType !== 'rawMaterial' ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Material</label>
                <input type="text" name="material" placeholder="e.g., Sheesham Wood" className="w-full" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Color</label>
                <input type="text" name="color" placeholder="e.g., Walnut" className="w-full" />
              </div>
            </div>
          ) : null}

          {/* TGM attributes — shown only for the combined tiles, granite & marble vertical. */}
          {IS_TILES && !(tab === 'products' && productType === 'rawMaterial') && (
            <div className="p-3 bg-accent/5 border border-accent/20 rounded-xl space-y-4">
              <p className="text-xs font-semibold text-accent flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" /> Tiles, Granite &amp; Marble Details
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Material Category</label>
                  <select name="materialCategory" defaultValue="TILE" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                    <option value="TILE">Tile</option><option value="GRANITE">Granite</option><option value="MARBLE">Marble</option><option value="QUARTZITE">Quartzite</option><option value="SANDSTONE">Sandstone / Kota</option><option value="ENGINEERED_QUARTZ">Engineered Quartz</option><option value="ADHESIVE_GROUT">Adhesive / Grout</option><option value="TRIM_PROFILE">Trim / Edge Profile</option><option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Unit of Measure</label>
                  <select name="unitOfMeasure" defaultValue="BOX" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                    {TILES_UNIT_VALUES.map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Tile Size</label>
                  <input type="text" name="tileSize" placeholder="e.g., 600x600" className="w-full" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Finish</label>
                  <select name="finish" defaultValue="" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                    <option value="">Select finish</option>
                    {FINISH_VALUES.map(v => (
                      <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Application Area</label>
                  <select name="applicationArea" defaultValue="" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                    <option value="">Select area</option>
                    {APPLICATION_AREA_VALUES.map(v => (
                      <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Coverage / Box (sq.ft)</label>
                  <input type="number" name="coveragePerBox" min="0" step="0.01" placeholder="e.g., 16" className="w-full" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">Tiles / Box</label>
                  <input type="number" name="tilesPerBox" min="1" step="1" placeholder="e.g., 4" className="w-full" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Surface Type</label>
                <input type="text" name="surfaceType" placeholder="e.g., Vitrified, Ceramic, Anti-skid" className="w-full" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div><label className="block text-xs font-medium text-muted mb-1.5">Quarry / Origin</label><input name="origin" placeholder="e.g., Rajasthan - Makrana" className="w-full" /></div>
                <div><label className="block text-xs font-medium text-muted mb-1.5">Thickness (mm)</label><input type="number" min="1" step="0.1" name="thicknessMm" placeholder="e.g., 18" className="w-full" /></div>
                <div><label className="block text-xs font-medium text-muted mb-1.5">Quality Grade</label><input name="qualityGrade" placeholder="Premium / Grade A" className="w-full" /></div>
              </div>
              <div className="flex flex-wrap gap-5 text-xs text-muted">
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="isSlabTracked" className="accent-accent" /> Track as unique physical slabs <span className="text-[10px]">(granite/marble; receive through Lot Explorer)</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="bookMatchPair" className="accent-accent" /> Supports book matching</label>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Stock Quantity</label>
              <input type="number" name="stock" placeholder={IS_TILES ? '0 (keep 0 for slab-tracked stone)' : '0'} className="w-full" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Reorder Level</label>
              <input type="number" name="reorderLevel" placeholder="5" className="w-full" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Warehouse</label>
              <input type="text" name="warehouse" placeholder="e.g., Main Store" className="w-full" list="warehouseList" />
              <datalist id="warehouseList">
                {warehouses.filter(w => w !== 'All').map(w => <option key={w} value={w} />)}
              </datalist>
            </div>
          </div>

          {/* Receiving Godown */}
          {godowns.length > 0 && (
            <div className="p-3 bg-accent/5 border border-accent/20 rounded-xl">
              <label htmlFor="stockGodownId" className="block text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                <Warehouse className="w-3.5 h-3.5 text-accent" /> Receiving Godown / Location *
              </label>
              <select name="godownId" required className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                <option value="">Select godown where stock will be stored</option>
                {godowns.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name} {g.isDefault ? '⭐ (Default)' : ''} — {g.branch?.name || 'Unassigned'}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted mt-1">This is the physical location where the stock will be stored</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">Description</label>
            <textarea id="stockNotes" rows={2} name="description" placeholder="Optional description..." className="w-full" />
          </div>
        </form>
      </Modal>

      {/* Confirm Move to Draft Modal */}
      <Modal isOpen={!!productToDelete} onClose={cancelMoveToDraft} title="Move to Draft" size="sm">
        {productToDelete && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Are you sure you want to move <strong className="text-foreground">{productToDelete.name}</strong> to drafts? It will be permanently deleted after 30 days.</p>
            <div className="flex gap-3 justify-end">
              <button onClick={cancelMoveToDraft} className="px-4 py-2 rounded-lg text-sm text-muted hover:bg-surface-hover">Cancel</button>
              <button onClick={confirmMoveToDraft} disabled={deleting} className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">
                {deleting ? 'Moving...' : 'Move to Draft'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Stock Update Modal */}
      <Modal isOpen={!!showStockModal} onClose={() => { if (!stockSaving) setShowStockModal(null); }} title="Update Stock" size="md">
        {showStockModal && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-xl bg-surface flex items-center justify-center overflow-hidden flex-shrink-0">
                {showStockModal.image && !showStockModal.image.includes('/') ? (
                  <span className="text-3xl">{showStockModal.image}</span>
                ) : showStockModal.image ? (
                  <img src={showStockModal.image.split(',')[0]} alt={showStockModal.name} className="w-full h-full object-cover" />
                ) : (
                  <Package className="w-8 h-8 text-muted/30" />
                )}
              </div>
              <div>
                <h3 className="font-semibold text-foreground">{showStockModal.name}</h3>
                <p className="text-xs text-muted font-mono">{showStockModal.sku} · {showStockModal.warehouse}</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="bg-surface rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-foreground">{showStockModal.stock}</p>
                <p className="text-[10px] text-muted">Current Stock</p>
              </div>
              <div className="bg-surface rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-foreground">{showStockModal.reorderLevel}</p>
                <p className="text-[10px] text-muted">Reorder Level</p>
              </div>
              <div className="bg-surface rounded-xl p-3 text-center">
                <p className="text-xl font-bold text-foreground">{showStockModal.sold}</p>
                <p className="text-[10px] text-muted">Total Sold</p>
              </div>
            </div>

            {/* Godown distribution */}
            {(() => {
              const gdStocks = godownStocks.filter(gs => gs.productId === showStockModal.id);
              return gdStocks.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-muted mb-2">Stock by Location</p>
                  <div className="grid grid-cols-2 gap-2">
                    {gdStocks.map(gs => (
                      <div key={gs.id} className="bg-surface rounded-lg p-2 flex items-center justify-between">
                        <span className="text-xs text-foreground flex items-center gap-1"><Warehouse className="w-3 h-3 text-muted" /> {gs.godown?.name}</span>
                        <span className={`text-sm font-bold ${gs.quantity <= 0 ? 'text-red-400' : 'text-foreground'}`}>{gs.quantity}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}

            {/* Target Godown — where to adjust stock (like Odoo's stock.move) */}
            {godowns.length > 0 && (
              <div className="p-3 bg-accent/5 border border-accent/20 rounded-xl">
                <label htmlFor="stockGodownId" className="block text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                  <Warehouse className="w-3.5 h-3.5 text-accent" /> Target Godown / Location *
                </label>
                <select id="stockGodownId" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                  <option value="">Select godown to adjust</option>
                  {(() => {
                    const gdStocksForProduct = godownStocks.filter(gs => gs.productId === showStockModal.id);
                    return godowns.map(g => {
                      const gdStock = gdStocksForProduct.find(gs => gs.godownId === g.id);
                      return (
                        <option key={g.id} value={g.id}>
                          {g.name} {g.isDefault ? '⭐' : ''} — Current: {gdStock?.quantity || 0} units
                        </option>
                      );
                    });
                  })()}
                </select>
                <p className="text-[10px] text-muted mt-1">Select the physical location where stock will be added/removed</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-muted mb-1.5">Stock Adjustment</label><label htmlFor="stockQty" className="sr-only">Quantity</label>
              <div className="flex gap-2">
                <select aria-label="Stock adjustment type" id="stockAdjType" className="px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                  <option>Add Stock</option>
                  <option>Remove Stock</option>
                  <option>Set Stock</option>
                </select>
                <input id="stockQty" type="number" step="any" placeholder="Quantity" min="0" className="flex-1 px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50" />
              </div>
            </div>

            <div>
              <label htmlFor="stockReason" className="block text-xs font-medium text-muted mb-1.5">Reason</label>
              <select id="stockReason" className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground">
                <option>Returned by customer</option>
                <option>Damaged / Write-off</option>

                <option>Stock count correction</option>
              </select>
            </div>

            <div>
              <label htmlFor="stockNotes" className="block text-xs font-medium text-muted mb-1.5">Notes</label>
              <textarea id="stockNotes" rows={2} placeholder="Optional notes..." className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground placeholder:text-muted focus:outline-none focus:border-accent/50 resize-none" />
            </div>

            {showStockModal.batches?.length > 0 && <div>
              <label htmlFor="stockBatch" className="block text-xs text-muted mb-1.5">Batch / Shade (for batch stock adjustments)</label>
              <select id="stockBatch" className="w-full px-3 py-2.5 bg-surface border border-border rounded-xl text-sm">
                <option value="">Unassigned stock</option>
                {showStockModal.batches.map(batch => <option key={batch.id} value={batch.id}>{batch.batchNumber} {batch.shadeCode || ''} — {batch.remainingQty} remaining</option>)}
              </select>
            </div>}
            {stockError && <p role="alert" className="text-sm text-danger">{stockError}</p>}
            <button disabled={stockSaving || locationLoading} onClick={async () => {
              if (stockSaving) return;
              const adjType = document.querySelector('#stockAdjType')?.value;
              const rawQty = document.querySelector('#stockQty')?.value?.trim();
              const qty = Number(rawQty);
              const selectedGodownId = document.querySelector('#stockGodownId')?.value;
              if (!rawQty || !Number.isFinite(qty) || qty < 0 || (adjType !== 'Set Stock' && qty === 0)) { setStockError('Enter a valid quantity. Add/remove quantities must be positive.'); return; }
              if (godowns.length > 0 && !selectedGodownId) { setStockError('Please select a godown / location'); return; }
              const gdStock = godownStocks.find(gs => gs.productId === showStockModal.id && gs.godownId === Number(selectedGodownId));
              const current = gdStock?.quantity ?? (godownStocks.some(gs => gs.productId === showStockModal.id) ? 0 : showStockModal.stock);
              setStockSaving(true);
              setStockError('');
              try {
                const res = await updateStock({
                  id: showStockModal.id, quantity: qty,
                  operation: adjType === 'Add Stock' ? 'ADD' : adjType === 'Remove Stock' ? 'REMOVE' : 'SET',
                  expectedBalance: adjType === 'Set Stock' ? current : undefined,
                  godownId: selectedGodownId ? Number(selectedGodownId) : undefined,
                  batchId: document.querySelector('#stockBatch')?.value ? Number(document.querySelector('#stockBatch').value) : undefined,
                  reason: document.querySelector('#stockReason')?.value,
                  notes: document.querySelector('#stockNotes')?.value,
                });
                if (!res.success) throw new Error(res.error || 'Stock update failed');
                await refreshProducts();
                await loadLocationData();
                setShowStockModal(null);
                notify('Stock updated', { variant: 'success' });
              } catch (err) { setStockError(err.message || 'Could not update stock'); }
              finally { setStockSaving(false); }
            }} className="w-full py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-all">
              {stockSaving ? 'Updating...' : locationLoading ? 'Loading balances...' : 'Update Stock'}
            </button>
          </div>
        )}
      </Modal>

      {/* ─── BULK IMPORT MODAL ─────────────────────── */}
      <Modal isOpen={showImportModal} onClose={() => setShowImportModal(false)} title="Bulk Import Products">
        <div className="space-y-5">

          {/* Download Template */}
          <div className="flex items-center justify-between p-4 bg-accent/5 border border-accent/20 rounded-xl">
            <div>
              <p className="text-sm font-semibold text-foreground">Download Excel Template</p>
              <p className="text-xs text-muted mt-0.5">Fill in the template and upload it below</p>
            </div>
            <button
              onClick={downloadProductTemplate}
              className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-xl text-sm font-semibold hover:bg-accent-hover transition-all"
            >
              <Download className="w-4 h-4" /> Template
            </button>
          </div>

          {/* Required Columns Info */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-red-500/5 border border-red-500/20 rounded-xl">
              <p className="text-xs font-bold text-red-500 mb-1.5">Required Columns</p>
              {['Product Name', 'Price', 'In Stock'].map(c => (
                <p key={c} className="text-xs text-muted flex items-center gap-1.5 mb-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />{c}
                </p>
              ))}
            </div>
            <div className="p-3 bg-surface border border-border rounded-xl">
              <p className="text-xs font-bold text-muted mb-1.5">Optional Columns</p>
              {['SKU Code', 'Category', 'Description', 'Material', 'Color', 'Reorder Level', 'Warehouse', 'Unit of Measure', 'Brand', 'Tile Size', 'Finish', 'Coverage Per Box', 'Tiles Per Box'].map(c => (
                <p key={c} className="text-xs text-muted flex items-center gap-1.5 mb-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-border flex-shrink-0" />{c}
                </p>
              ))}
            </div>
          </div>

          {/* File Upload */}
          {!importResult && (
            <label className="flex flex-col items-center justify-center gap-3 p-6 border-2 border-dashed border-border hover:border-accent/40 rounded-xl cursor-pointer transition-all group">
              <div className="p-3 rounded-full bg-accent/10 group-hover:bg-accent/20 transition-all">
                <Upload className="w-6 h-6 text-accent" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-foreground">Click to upload Excel / CSV</p>
                <p className="text-xs text-muted mt-1">.xlsx, .xls, or .csv formats supported</p>
              </div>
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFileUpload} />
            </label>
          )}

          {/* Error */}
          {importError && (
            <div className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
              <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-600 whitespace-pre-line">{importError}</p>
            </div>
          )}

          {/* Preview */}
          {importRows.length > 0 && !importResult && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">{importRows.length} rows ready to import</p>
                <button onClick={() => { setImportRows([]); setImportHeaders([]); }} className="text-xs text-muted hover:text-danger">
                  Clear
                </button>
              </div>
              <div className="overflow-auto max-h-48 rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface">
                      {['Name', 'SKU', 'Category', 'Price', 'In Stock', 'Description'].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-muted font-semibold border-b border-border whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.slice(0, 10).map((row, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-surface/50">
                        <td className="px-3 py-1.5 font-medium text-foreground truncate max-w-[120px]">{String(row[importColMap.name] ?? '')}</td>
                        <td className="px-3 py-1.5 text-muted">{importColMap.sku !== undefined ? String(row[importColMap.sku] ?? '') : '—'}</td>
                        <td className="px-3 py-1.5 text-muted">{importColMap.category !== undefined ? String(row[importColMap.category] ?? '') : '—'}</td>
                        <td className="px-3 py-1.5 text-muted">₹{importColMap.price !== undefined ? String(row[importColMap.price] ?? '').trim().toLocaleString('en-IN') : '0'}</td>
                        <td className="px-3 py-1.5 text-muted">{importColMap.instock !== undefined ? String(row[importColMap.instock] ?? '') : '0'}</td>
                        <td className="px-3 py-1.5 text-muted truncate max-w-[120px]">{importColMap.description !== undefined ? String(row[importColMap.description] ?? '') : '—'}</td>
                      </tr>
                    ))}
                    {importRows.length > 10 && (
                      <tr><td colSpan={6} className="px-3 py-1.5 text-center text-muted text-[10px]">+ {importRows.length - 10} more rows</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <button
                onClick={handleImportSubmit}
                disabled={importLoading}
                className="w-full py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2"
              >
                {importLoading ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Importing...</>
                ) : (
                  <><Upload className="w-4 h-4" /> Import {importRows.length} Products</>
                )}
              </button>
            </div>
          )}

          {/* Result */}
          {importResult?.errors?.length > 0 && <div role="alert" className="p-3 bg-warning-light rounded-xl text-xs space-y-1">{importResult.errors.map((error, index) => <p key={index}>Data row {error.row}: {error.message}</p>)}</div>}
          {importResult && (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-3 p-6 bg-success/5 border border-success/20 rounded-xl text-center">
                <CheckCircle className="w-10 h-10 text-success" />
                <p className="text-base font-bold text-foreground">Import Complete!</p>
                <div className="flex gap-6 text-sm">
                  <div><p className="text-2xl font-bold text-success">{importResult.created}</p><p className="text-xs text-muted">Created</p></div>
                  <div><p className="text-2xl font-bold text-muted">{importResult.skipped}</p><p className="text-xs text-muted">Skipped</p></div>
                  <div><p className="text-2xl font-bold text-foreground">{importResult.total}</p><p className="text-xs text-muted">Total</p></div>
                </div>
              </div>
              <button
                onClick={() => { setShowImportModal(false); setImportResult(null); }}
                className="w-full py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-all"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* ─── EDIT PRODUCT MODAL ───────────────────────── */}
      <Modal
        isOpen={showEditModal}
        onClose={() => { setShowEditModal(false); setEditProduct(null); }}
        title="Edit Product"
        fullScreenMobile
        footer={
          <div className="flex gap-3">
            <button
              onClick={() => { setShowEditModal(false); setEditProduct(null); }}
              className="flex-1 md:flex-none py-3 md:py-2.5 px-4 bg-surface border border-border text-muted rounded-xl text-sm font-semibold hover:text-foreground transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleEditSave}
              disabled={editSaving || !editForm.name}
              className="flex-1 md:ml-auto md:flex-none py-3 md:py-2.5 px-6 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2"
            >
              {editSaving ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Saving...</>
              ) : (
                <><Save className="w-4 h-4" /> Save Changes</>
              )}
            </button>
          </div>
        }
      >
        {editProduct && (
          <div className="space-y-4">

            {/* Image Section */}
            <div className="flex items-start gap-4">
              <div className="w-24 h-24 rounded-2xl bg-surface border-2 border-dashed border-border flex items-center justify-center overflow-hidden flex-shrink-0 relative group">
                {editImagePreview ? (
                  <img src={editImagePreview} alt="Product" className="w-full h-full object-cover" />
                ) : (
                  <ImageIcon className="w-8 h-8 text-muted/30" />
                )}
                <label className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer rounded-2xl">
                  <div className="flex flex-col items-center gap-1">
                    <Upload className="w-4 h-4 text-white" />
                    <span className="text-[10px] text-white font-medium">Change</span>
                  </div>
                  <input type="file" accept="image/*" className="hidden" onChange={handleEditImageChange} />
                </label>
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-muted mb-1">Product Image</p>
                <p className="text-[11px] text-muted">Hover over image to change. Supports JPG, PNG, WebP.</p>
                <label className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-lg text-xs text-muted hover:text-accent cursor-pointer transition-colors">
                  <Upload className="w-3 h-3" /> Upload Image
                  <input type="file" accept="image/*" className="hidden" onChange={handleEditImageChange} />
                </label>
                {editImageFile && (
                  <p className="text-[10px] text-success mt-1 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> {editImageFile.name}
                  </p>
                )}
              </div>
            </div>

            <hr className="border-border" />

            {/* Core Fields */}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-muted mb-1.5">Product Name *</label>
                <input
                  type="text"
                  value={editForm.name || ''}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="Enter product name"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Selling Price (₹)</label>
                <input
                  type="number"
                  value={editForm.price || 0}
                  onChange={e => setEditForm(f => ({ ...f, price: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="0"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Cost Price (₹)</label>
                <input
                  type="number"
                  value={editForm.costPrice || 0}
                  onChange={e => setEditForm(f => ({ ...f, costPrice: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="0"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Reorder Level</label>
                <input
                  type="number"
                  value={editForm.reorderLevel ?? 5}
                  onChange={e => setEditForm(f => ({ ...f, reorderLevel: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="5"
                  min="0"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Unit of Measure</label>
                <select
                  value={editForm.unitOfMeasure || 'PCS'}
                  onChange={e => setEditForm(f => ({ ...f, unitOfMeasure: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                >
                  {[...new Set([...TILES_UNIT_VALUES, 'SET', 'KG', 'MTR', 'L', 'ROLL', 'PAIR', editProduct?.unitOfMeasure])].filter(Boolean).map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="editStockGroup" className="block text-xs text-muted mb-1.5">Stock Group</label>
              <select id="editStockGroup" value={editForm.stockGroupId || ''} onChange={e => setEditForm(f => ({ ...f, stockGroupId: e.target.value }))} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm">
                <option value="">Unassigned</option>
                {stockGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            {IS_TILES && !editProduct?.isRawMaterial && <div className="grid grid-cols-2 gap-3">
              {[['tileSize', 'Tile Size'], ['surfaceType', 'Surface Type'], ['origin', 'Origin'], ['qualityGrade', 'Quality Grade']].map(([key, label]) => <div key={key}>
                <label htmlFor={`edit-${key}`} className="block text-xs text-muted mb-1.5">{label}</label>
                <input id={`edit-${key}`} value={editForm[key] ?? ''} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm" />
              </div>)}
              {[['coveragePerBox', 'Coverage / Box (sq.ft)', 'any'], ['tilesPerBox', 'Tiles / Box', '1'], ['thicknessMm', 'Thickness (mm)', 'any']].map(([key, label, step]) => <div key={key}>
                <label htmlFor={`edit-${key}`} className="block text-xs text-muted mb-1.5">{label}</label>
                <input id={`edit-${key}`} type="number" min="0" step={step} value={editForm[key] ?? ''} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm" />
              </div>)}
              {[['finish', 'Finish', FINISH_VALUES], ['applicationArea', 'Application Area', APPLICATION_AREA_VALUES]].map(([key, label, options]) => <div key={key}>
                <label htmlFor={`edit-${key}`} className="block text-xs text-muted mb-1.5">{label}</label>
                <select id={`edit-${key}`} value={editForm[key] || ''} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))} className="w-full px-3 py-2 bg-surface border border-border rounded-xl text-sm">
                  <option value="">Not specified</option>{options.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>)}
            </div>}

            {/* Optional Fields */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Brand</label>
                <input
                  type="text"
                  value={editForm.brand || ''}
                  onChange={e => setEditForm(f => ({ ...f, brand: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="e.g. Durian"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Material</label>
                <input
                  type="text"
                  value={editForm.material || ''}
                  onChange={e => setEditForm(f => ({ ...f, material: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="e.g. Sheesham Wood"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">Color</label>
                <input
                  type="text"
                  value={editForm.color || ''}
                  onChange={e => setEditForm(f => ({ ...f, color: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50"
                  placeholder="e.g. Walnut Brown"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-muted mb-1.5">Description</label>
                <textarea
                  rows={2}
                  value={editForm.description || ''}
                  onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-foreground focus:outline-none focus:border-accent/50 resize-none"
                  placeholder="Optional product description..."
                />
              </div>
            </div>

            {/* Error */}
            {editError && (
              <div className="flex items-start gap-2 p-3 bg-danger-light border border-danger/20 rounded-xl">
                <XCircle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
                <p className="text-xs text-danger">{editError}</p>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
