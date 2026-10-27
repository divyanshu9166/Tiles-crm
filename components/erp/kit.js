'use client';

import Link from 'next/link';
import { ChevronRight, Loader2 } from 'lucide-react';

// Shared building blocks for the Odoo-style document screens (sales orders,
// transfers, counts, replenishment). They only use the app's theme tokens.

export const formatINR = (value) => {
  const amount = Math.round(Number(value || 0));
  return `${amount < 0 ? '−' : ''}₹${Math.abs(amount).toLocaleString('en-IN')}`;
};
export const formatQty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const formatDate = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const toInputDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

const TONES = {
  gray: 'bg-stone-500/10 text-muted',
  blue: 'bg-blue-500/10 text-blue-500',
  amber: 'bg-amber-500/10 text-amber-500',
  green: 'bg-emerald-500/10 text-emerald-500',
  red: 'bg-red-500/10 text-red-500',
  purple: 'bg-purple-500/10 text-purple-500',
  accent: 'bg-accent/10 text-accent',
};

export function Badge({ tone = 'gray', children, className = '' }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${TONES[tone] || TONES.gray} ${className}`}>{children}</span>;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon: Icon, children, className = '', ...props }) {
  const variants = {
    primary: 'bg-accent text-white hover:bg-accent/90 border border-accent',
    secondary: 'bg-surface text-foreground border border-border hover:bg-surface-hover',
    danger: 'bg-surface text-red-500 border border-red-500/30 hover:bg-red-500/10',
    ghost: 'text-muted hover:text-foreground hover:bg-surface-hover border border-transparent',
  };
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-3.5 py-2 text-sm' };
  return (
    <button
      type="button"
      disabled={loading || props.disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : Icon ? <Icon className="w-4 h-4" /> : null}
      {children}
    </button>
  );
}

export function PageHeader({ title, subtitle, breadcrumbs = [], actions }) {
  return (
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
      <div className="min-w-0">
        {breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1 text-xs text-muted mb-1 flex-wrap">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.label} className="flex items-center gap-1">
                {index > 0 && <ChevronRight className="w-3 h-3" />}
                {crumb.href ? <Link href={crumb.href} className="hover:text-accent">{crumb.label}</Link> : <span className="text-foreground">{crumb.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-xl md:text-2xl font-semibold text-foreground truncate">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// Odoo's form "statusbar": the document's stages with the current one highlighted.
export function StatusBar({ steps, current }) {
  const currentIndex = steps.findIndex(step => step.key === current);
  return (
    <div className="flex items-stretch overflow-x-auto rounded-lg border border-border bg-surface">
      {steps.map((step, index) => {
        const active = step.key === current;
        const past = currentIndex > -1 && index < currentIndex;
        return (
          <div
            key={step.key}
            className={`relative flex items-center px-3 md:px-4 py-1.5 text-xs font-medium whitespace-nowrap ${index > 0 ? 'border-l border-border' : ''} ${active ? 'bg-accent text-white' : past ? 'text-foreground' : 'text-muted'}`}
          >
            {step.label}
          </div>
        );
      })}
    </div>
  );
}

// Odoo "smart buttons" on top of a form: counters linking to related records.
export function SmartButton({ icon: Icon, label, value, href, onClick, tone = 'accent' }) {
  const body = (
    <>
      {Icon && <Icon className={`w-5 h-5 ${tone === 'accent' ? 'text-accent' : 'text-muted'}`} />}
      <div className="text-left leading-tight">
        <div className="text-sm font-semibold text-foreground">{value}</div>
        <div className="text-[11px] text-muted">{label}</div>
      </div>
    </>
  );
  const className = 'flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-surface hover:bg-surface-hover transition-colors min-w-[120px]';
  if (href) return <Link href={href} className={className}>{body}</Link>;
  return <button type="button" onClick={onClick} className={className}>{body}</button>;
}

export function Card({ title, actions, children, className = '', padded = true }) {
  return (
    <section className={`glass-card ${padded ? 'p-4 md:p-5' : ''} ${className}`}>
      {(title || actions) && (
        <div className={`flex items-center justify-between gap-2 ${padded ? 'mb-3' : 'px-4 pt-4 pb-3'}`}>
          {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-muted mb-1 block">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted mt-1 block">{hint}</span>}
    </label>
  );
}

export const inputClass = 'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40';

export function InfoGrid({ items }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {items.filter(Boolean).map(item => (
        <div key={item.label} className="flex justify-between sm:justify-start gap-3 py-1 border-b border-border/40">
          <dt className="text-muted sm:w-36 shrink-0">{item.label}</dt>
          <dd className="text-foreground font-medium text-right sm:text-left break-words">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-4">
      {Icon && <Icon className="w-10 h-10 text-muted/60 mb-3" />}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {text && <p className="text-xs text-muted mt-1 max-w-sm">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-surface border border-border overflow-x-auto w-fit max-w-full">
      {tabs.map(tab => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${value === tab.key ? 'bg-accent text-white' : 'text-muted hover:text-foreground'}`}
        >
          {tab.label}
          {tab.count !== undefined && <span className={`ml-1.5 text-[11px] ${value === tab.key ? 'text-white/80' : 'text-muted'}`}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Loader2 className="w-4 h-4 animate-spin" /> {label}
    </div>
  );
}

export const SO_DELIVERY = { PENDING: { label: 'To deliver', tone: 'amber' }, PARTIAL: { label: 'Partially delivered', tone: 'blue' }, DELIVERED: { label: 'Delivered', tone: 'green' } };
export const SO_INVOICE = { NOTHING: { label: 'Nothing to invoice', tone: 'gray' }, TO_INVOICE: { label: 'To invoice', tone: 'amber' }, INVOICED: { label: 'Fully invoiced', tone: 'green' }, TO_REFUND: { label: 'To refund', tone: 'red' } };
export const SO_STATUS = { CONFIRMED: { label: 'Sales Order', tone: 'blue' }, DONE: { label: 'Locked', tone: 'gray' }, CANCELLED: { label: 'Cancelled', tone: 'red' } };
export const BILL_STATUS = { DRAFT: { label: 'Draft', tone: 'gray' }, POSTED: { label: 'Posted', tone: 'green' }, CANCELLED: { label: 'Cancelled', tone: 'red' } };
export const PICKING_STATUS = { READY: { label: 'Ready', tone: 'blue' }, DONE: { label: 'Done', tone: 'green' }, CANCELLED: { label: 'Cancelled', tone: 'red' } };
export const LANDED_STATUS = { DRAFT: { label: 'Draft', tone: 'gray' }, POSTED: { label: 'Validated', tone: 'green' }, CANCELLED: { label: 'Cancelled', tone: 'red' } };
export const LANDED_CREDIT_TO = { EXPENSE: 'Already in expenses', PAYABLE: 'Owed to transporter / agent', CASH: 'Paid in cash', BANK: 'Paid from bank' };
