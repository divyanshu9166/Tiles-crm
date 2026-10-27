// Where each chatter-enabled document opens in the app.
const ROUTES = {
  SalesOrder: id => `/sales-orders/${id}`,
  StockPicking: id => `/operations/${id}`,
  InventoryCount: id => `/inventory-counts/${id}`,
  VendorBill: id => `/vendor-bills/${id}`,
  PurchaseOrder: () => '/purchases',
  Supplier: () => '/purchases',
  Quotation: () => '/quotations',
  Invoice: () => '/billing',
  Lead: () => '/leads',
  Contact: () => '/leads',
  CustomOrder: () => '/custom-orders',
  ProductionOrder: () => '/manufacturing',
  Product: () => '/inventory',
};

export const MODEL_LABELS = {
  SalesOrder: 'Sales order', StockPicking: 'Transfer', InventoryCount: 'Physical count', PurchaseOrder: 'Purchase order',
  Supplier: 'Supplier', Quotation: 'Quotation', Invoice: 'Invoice', Lead: 'Lead', Contact: 'Customer',
  CustomOrder: 'Fabrication job', ProductionOrder: 'Production order', Product: 'Product', VendorBill: 'Vendor bill',
};

export function recordHref(resModel, resId) {
  return ROUTES[resModel]?.(resId) || '/';
}
