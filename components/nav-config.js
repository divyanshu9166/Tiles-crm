import {
  Home, Users, Calendar, Package, ShoppingCart, Megaphone, MessageSquare, Settings,
  Headphones, UserPlus, UsersRound, Receipt, Ruler, KeyRound, Trash2, MailPlus, Truck, Warehouse,
  FileSpreadsheet, FileText, Factory, Wallet, BarChart3, Calculator, Building2, Banknote,
  Handshake, CalendarCheck, ClipboardList, ClipboardCheck, ArrowLeftRight, RefreshCcw, FileInput,
  PackagePlus, BookOpen, Tags, Trophy, Landmark, ShoppingBag, LayoutGrid,
} from 'lucide-react';

// Odoo-style apps. Each app is one sidebar entry; only the app you are in is
// expanded, so the menu stays short. roles: who can see an item (undefined =
// everyone signed in). vertical: only for that business type.
export const homeItems = [
  { href: '/staff-portal', label: 'Staff Portal', icon: KeyRound, roles: ['STAFF'] },
  { href: '/apps', label: 'All apps', icon: LayoutGrid },
  { href: '/', label: 'Dashboard', icon: Home },
  { href: '/activities', label: 'My Activities', icon: CalendarCheck },
];

export const apps = [
  {
    key: 'sales', label: 'Sales', icon: ShoppingBag, color: '#2f57e0',
    description: 'Leads, quotations, orders and billing',
    items: [
      { href: '/leads', label: 'Leads', icon: Users },
      { href: '/walkins', label: 'Walk-ins', icon: UserPlus },
      { href: '/appointments', label: 'Appointments', icon: Calendar },
      { href: '/quotations', label: 'Quotations', icon: FileText },
      { href: '/sales-orders', label: 'Sales Orders', icon: ClipboardList, roles: ['ADMIN', 'MANAGER'] },
      { href: '/billing', label: 'Billing & POS', icon: Receipt, roles: ['ADMIN', 'MANAGER'] },
      { href: '/payments', label: 'Daily Payments', icon: Banknote, roles: ['ADMIN', 'MANAGER', 'STAFF'] },
      { href: '/orders', label: 'Store & Online Orders', icon: ShoppingCart },
      { href: '/sales-teams', label: 'Sales Teams', icon: Trophy },
      { href: '/pricelists', label: 'Pricelists', icon: Tags, roles: ['ADMIN', 'MANAGER'] },
      { href: '/dealers', label: 'Dealers & Partners', icon: Handshake },
      { href: '/indiamart-leads', label: 'IndiaMART Leads', icon: Building2, roles: ['ADMIN', 'MANAGER'] },
    ],
  },
  {
    key: 'inventory', label: 'Inventory', icon: Package, color: '#0d8a80',
    description: 'Stock, transfers, counts and reordering',
    items: [
      { href: '/inventory', label: 'Products & Stock', tilesLabel: 'Inventory & Lots', icon: Package },
      { href: '/operations', label: 'Operations', icon: ArrowLeftRight, roles: ['ADMIN', 'MANAGER'] },
      { href: '/replenishment', label: 'Replenishment', icon: RefreshCcw, roles: ['ADMIN', 'MANAGER'] },
      { href: '/inventory-counts', label: 'Physical Counts', icon: ClipboardCheck },
      { href: '/godowns', label: 'Godowns', icon: Warehouse, roles: ['ADMIN', 'MANAGER', 'STAFF'] },
    ],
  },
  {
    key: 'purchase', label: 'Purchase', icon: Truck, color: '#b86a00',
    description: 'Purchase orders, vendor bills, landed costs',
    items: [
      { href: '/purchases', label: 'Purchase Orders', icon: Truck, roles: ['ADMIN', 'MANAGER'] },
      { href: '/vendor-bills', label: 'Vendor Bills', icon: FileInput, roles: ['ADMIN', 'MANAGER'] },
      { href: '/landed-costs', label: 'Landed Costs', icon: PackagePlus, roles: ['ADMIN', 'MANAGER'] },
    ],
  },
  {
    key: 'manufacturing', label: 'Manufacturing', icon: Factory, color: '#6d3fd0',
    description: 'Fabrication jobs and production',
    items: [
      { href: '/custom-orders', label: 'Custom Orders', tilesLabel: 'Fabrication Jobs', icon: Ruler },
      { href: '/manufacturing', label: 'Production', icon: Factory, roles: ['ADMIN', 'MANAGER', 'STAFF'] },
    ],
  },
  {
    key: 'accounting', label: 'Accounting', icon: Landmark, color: '#1a7f4b',
    description: 'Collections, payables, books and GST',
    items: [
      { href: '/accounts', label: 'Accounts Desk', icon: Landmark, roles: ['ADMIN', 'MANAGER'] },
      { href: '/expenses', label: 'Expenses', icon: Calculator, roles: ['ADMIN', 'MANAGER', 'STAFF'] },
      { href: '/gst', label: 'GST', icon: FileSpreadsheet, roles: ['ADMIN', 'MANAGER'] },
      { href: '/accounting', label: 'Journals & Ledger', icon: BookOpen, roles: ['ADMIN', 'MANAGER'] },
      { href: '/financials', label: 'Reports', icon: BarChart3, roles: ['ADMIN'] },
    ],
  },
  {
    key: 'marketing', label: 'Marketing', icon: Megaphone, color: '#c4246c',
    description: 'Calls, WhatsApp, email and social inbox',
    items: [
      { href: '/calls', label: 'Call Center', icon: Headphones },
      { href: '/whatsapp-marketing', label: 'WhatsApp', icon: Megaphone, roles: ['ADMIN', 'MANAGER'] },
      { href: '/email-marketing', label: 'Email', icon: MailPlus, roles: ['ADMIN', 'MANAGER'] },
      { href: '/social-inbox', label: 'Instagram & FB Inbox', icon: MessageSquare, roles: ['ADMIN', 'MANAGER'] },
    ],
  },
  {
    key: 'team', label: 'Employees', icon: UsersRound, color: '#4b5563',
    description: 'Staff and payroll',
    items: [
      { href: '/staff', label: 'Staff', icon: UsersRound, roles: ['ADMIN', 'MANAGER'] },
      { href: '/payroll', label: 'Payroll', icon: Wallet, roles: ['ADMIN'] },
    ],
  },
  {
    key: 'config', label: 'Settings', icon: Settings, color: '#4b5563',
    description: 'Company settings and drafts',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings, roles: ['ADMIN'] },
      { href: '/drafts', label: 'Drafts', icon: Trash2, roles: ['ADMIN', 'MANAGER'] },
    ],
  },
];

export function isRouteActive(pathname, href) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function itemLabel(item, vertical) {
  return vertical === 'tiles' && item.tilesLabel ? item.tilesLabel : item.label;
}

// Apps and items this user may see, empty apps dropped.
export function visibleApps({ role, vertical, indiaMartEnabled }) {
  const canSee = item => {
    if (item.vertical && item.vertical !== vertical) return false;
    if (item.href === '/indiamart-leads' && !indiaMartEnabled) return false;
    return !item.roles || item.roles.includes(role);
  };
  return {
    home: homeItems.filter(canSee),
    apps: apps.map(app => ({ ...app, items: app.items.filter(canSee) })).filter(app => app.items.length > 0),
  };
}
