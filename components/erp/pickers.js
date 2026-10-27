'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, UserRound, Package } from 'lucide-react';
import { searchContacts } from '@/app/actions/invoices';
import { inputClass } from './kit';

// Typeahead over existing customers (name or phone), or a new customer.
export function CustomerPicker({ value, onChange }) {
  const [query, setQuery] = useState(value?.name || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  const idle = query.trim().length < 2 || (value?.id && value.name === query);
  useEffect(() => {
    clearTimeout(timer.current);
    if (idle) return;
    timer.current = setTimeout(async () => {
      const res = await searchContacts(query.trim());
      if (res.success) setResults(res.data);
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query, idle]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={e => { setQuery(e.target.value); setOpen(true); onChange({ id: null, name: e.target.value, phone: value?.phone || '' }); }}
          placeholder="Search customer by name or phone"
          className={`${inputClass} pl-9`}
        />
        {open && !idle && results.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-border bg-surface shadow-xl">
            {results.map(contact => (
              <li key={contact.id}>
                <button type="button" onMouseDown={e => { e.preventDefault(); onChange(contact); setQuery(contact.name); setOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-surface-hover flex items-center gap-2">
                  <UserRound className="w-4 h-4 text-muted" />
                  <span className="text-sm text-foreground">{contact.name}</span>
                  <span className="text-xs text-muted ml-auto">{contact.phone}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {!value?.id && query.trim().length > 0 && (
        <input value={value?.phone || ''} onChange={e => onChange({ id: null, name: query, phone: e.target.value })} placeholder="Phone for the new customer" className={inputClass} />
      )}
    </div>
  );
}

// Product search over a preloaded catalogue (getProducts()).
export function ProductPicker({ products, onPick, excludeSlab = true, excludeRaw = true, placeholder = 'Add a product…' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = products.filter(p => (!excludeRaw || !p.isRawMaterial) && (!excludeSlab || !p.isSlabTracked));
    if (!q) return pool.slice(0, 12);
    return pool.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.tileSize || '').toLowerCase().includes(q)).slice(0, 20);
  }, [products, query, excludeSlab, excludeRaw]);

  return (
    <div className="relative">
      <Package className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
      <input
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        placeholder={placeholder}
        className={`${inputClass} pl-9`}
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-border bg-surface shadow-xl">
          {matches.map(product => (
            <li key={product.id}>
              <button type="button" onMouseDown={e => { e.preventDefault(); onPick(product); setQuery(''); setOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-surface-hover">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground truncate">{product.name}</span>
                  <span className="text-[11px] text-muted ml-auto whitespace-nowrap">{product.isSlabTracked ? `${product.availableStoneSlabs ?? 0} slabs` : `${product.stock} ${product.unitOfMeasure} on hand`}</span>
                </div>
                <div className="text-[11px] text-muted">{product.sku}{product.tileSize ? ` · ${product.tileSize}` : ''}{product.coveragePerBox ? ` · ${product.coveragePerBox} sq.ft/box` : ''} · ₹{Number(product.price || 0).toLocaleString('en-IN')}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
