'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { BookOpen, RefreshCw, Scale, AlertTriangle, CheckCircle2, Search } from 'lucide-react';
import { useAlertToast } from '@/components/AlertToastProvider';
import { useSession } from '@/components/AuthProvider';
import { postJournalsNow, getAccountingOverview, getGeneralLedger, getJournalList, postOpeningStockDifference } from '@/app/actions/accounting';
import { Badge, Button, Card, EmptyState, Field, Loading, PageHeader, Tabs, inputClass, formatDate, formatINR } from '@/components/erp/kit';

const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

function Stat({ label, value, tone }) {
  return (
    <div className="glass-card p-3.5">
      <p className={`text-lg font-semibold ${tone === 'red' ? 'text-red-500' : tone === 'green' ? 'text-emerald-500' : 'text-foreground'}`}>{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  );
}

export default function AccountingPage() {
  const { notify } = useAlertToast();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const [tab, setTab] = useState('overview');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [ledgerCode, setLedgerCode] = useState('');
  const [ledger, setLedger] = useState(null);
  const [journals, setJournals] = useState([]);
  const [journalSearch, setJournalSearch] = useState('');
  const [journalSource, setJournalSource] = useState('all');
  const [expanded, setExpanded] = useState(null);

  const loadOverview = useCallback(async () => {
    const res = await getAccountingOverview(asOf);
    if (res.success) setOverview(res.data); else notify(res.error, { variant: 'danger' });
    setLoading(false);
  }, [asOf, notify]);

  const sync = useCallback(async (quiet) => {
    setSyncing(true);
    const res = await postJournalsNow();
    setSyncing(false);
    if (!res.success) { notify(res.error, { variant: 'danger' }); return; }
    setLastSync(res.data);
    if (!quiet || res.data.posted) notify(`${res.data.posted} new journal entr${res.data.posted === 1 ? 'y' : 'ies'} posted`, { variant: 'success' });
    if (res.data.skipped.length) notify(`${res.data.skipped.length} document(s) could not be posted: ${res.data.skipped.slice(0, 3).join(', ')}`, { variant: 'warning' });
    await loadOverview();
  }, [loadOverview, notify]);

  // Odoo posts in real time; here every visit posts whatever happened since.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post pending documents on open
    sync(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reload when the as-of date changes
    if (!loading) loadOverview();
  }, [asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const openLedger = async (code) => {
    setLedgerCode(code);
    setTab('ledger');
    const res = await getGeneralLedger(code, undefined, asOf);
    if (res.success) setLedger(res.data); else notify(res.error, { variant: 'danger' });
  };

  useEffect(() => {
    if (tab !== 'journals') return;
    const timer = setTimeout(async () => {
      const res = await getJournalList({ search: journalSearch, source: journalSource });
      if (res.success) setJournals(res.data); else notify(res.error, { variant: 'danger' });
    }, journalSearch ? 300 : 0);
    return () => clearTimeout(timer);
  }, [tab, journalSearch, journalSource, notify]);

  const alignStock = async () => {
    const res = await postOpeningStockDifference();
    if (!res.success) return notify(res.error, { variant: 'danger' });
    notify(`Opening stock aligned (${formatINR(res.data.difference)})`, { variant: 'success' });
    loadOverview();
  };

  if (loading) return <Loading label="Posting journals…" />;
  const s = overview?.summary;
  const inventoryGap = overview ? overview.inventory.valuation.total - overview.inventory.books : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounting"
        subtitle="Double-entry books posted automatically from invoices, payments, stock moves, bills, expenses and payroll"
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Journals & ledger' }]}
        actions={(
          <>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className={`${inputClass} w-40`} title="As of" />
            <Button icon={RefreshCw} loading={syncing} onClick={() => sync(false)}>Post new entries</Button>
          </>
        )}
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'trial', label: 'Trial balance' }, { key: 'journals', label: 'Journal entries' }, { key: 'ledger', label: 'General ledger' }]} />

      {tab === 'overview' && s && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Income (year to date)" value={formatINR(s.income)} />
            <Stat label="Expenses incl. COGS" value={formatINR(s.expense)} />
            <Stat label="Profit on the books" value={formatINR(s.profit)} tone={s.profit < 0 ? 'red' : 'green'} />
            <Stat label="Journal entries (auto / manual)" value={`${overview.entries.auto} / ${overview.entries.manual}`} />
            <Stat label="Customers owe (receivable)" value={formatINR(s.receivable)} />
            <Stat label="We owe suppliers (payable)" value={formatINR(s.payable)} tone={s.payable < 0 ? 'green' : undefined} />
            <Stat label="GST output − input (net payable)" value={formatINR(s.gstOutput - s.gstInput)} />
            <Stat label="Received, not yet billed (GRNI)" value={formatINR(s.grni)} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Balance check">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted">Assets</span><span className="text-foreground">{formatINR(s.assets)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Liabilities</span><span className="text-foreground">{formatINR(s.liabilities)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Equity + profit</span><span className="text-foreground">{formatINR(s.equity + s.profit)}</span></div>
                <div className="flex justify-between border-t border-border pt-2 font-medium">
                  <span className="text-foreground">Debits = credits</span>
                  {overview.trial.totals.debit === overview.trial.totals.credit
                    ? <Badge tone="green"><CheckCircle2 className="w-3 h-3" /> Balanced · {formatINR(overview.trial.totals.debit)}</Badge>
                    : <Badge tone="red">Out by {formatINR(overview.trial.totals.debit - overview.trial.totals.credit)}</Badge>}
                </div>
              </div>
            </Card>
            <Card title="Inventory: books vs stock valuation">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted">Inventory account (1200)</span><span className="text-foreground">{formatINR(overview.inventory.books)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Tiles & materials at cost</span><span className="text-foreground">{formatINR(overview.inventory.valuation.quantity)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Stone slabs at lot cost / sq.ft</span><span className="text-foreground">{formatINR(overview.inventory.valuation.stone)}</span></div>
                <div className="flex justify-between border-t border-border pt-2 font-medium">
                  <span className="text-foreground">Difference</span>
                  {inventoryGap === 0 ? <Badge tone="green">Reconciled</Badge> : <Badge tone="amber"><AlertTriangle className="w-3 h-3" /> {formatINR(inventoryGap)}</Badge>}
                </div>
                {inventoryGap !== 0 && (
                  <div className="text-xs text-muted space-y-2 pt-1">
                    <p>Stock that existed before automatic posting, stone lots (valued per sq.ft, not moved through the ledger) and cost-price changes create this gap. Align it once against opening balance equity; afterwards every movement posts automatically.</p>
                    {isAdmin && <Button size="sm" icon={Scale} onClick={alignStock}>Align opening stock</Button>}
                  </div>
                )}
              </div>
            </Card>
          </div>
          {lastSync?.skipped?.length > 0 && <Card title="Not posted"><ul className="text-xs text-amber-500 list-disc pl-4">{lastSync.skipped.map(key => <li key={key}>{key}</li>)}</ul></Card>}
        </div>
      )}

      {tab === 'trial' && overview && (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead><tr className="border-b border-border text-left text-[11px] uppercase text-muted">{['Code', 'Account', 'Group', 'Debit', 'Credit', 'Balance'].map(h => <th key={h} className={`px-4 py-3 font-medium ${['Debit', 'Credit', 'Balance'].includes(h) ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
              <tbody>
                {TYPE_ORDER.map(type => {
                  const rows = overview.trial.rows.filter(row => row.type === type);
                  if (rows.length === 0) return null;
                  return (
                    <Fragment key={type}>
                      <tr><td colSpan={6} className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wider text-muted font-semibold">{type.toLowerCase()}</td></tr>
                      {rows.map(row => (
                        <tr key={row.id} onClick={() => openLedger(row.code)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                          <td className="px-4 py-2 text-muted">{row.code}</td>
                          <td className="px-4 py-2 text-accent">{row.name}</td>
                          <td className="px-4 py-2 text-muted">{row.group}</td>
                          <td className="px-4 py-2 text-right">{formatINR(row.debit)}</td>
                          <td className="px-4 py-2 text-right">{formatINR(row.credit)}</td>
                          <td className="px-4 py-2 text-right font-medium">{row.balance >= 0 ? `${formatINR(row.balance)} Dr` : `${formatINR(-row.balance)} Cr`}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                <tr className="font-semibold"><td colSpan={3} className="px-4 py-3 text-right">Total</td><td className="px-4 py-3 text-right">{formatINR(overview.trial.totals.debit)}</td><td className="px-4 py-3 text-right">{formatINR(overview.trial.totals.credit)}</td><td /></tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'journals' && (
        <Card padded={false} title={<Tabs value={journalSource} onChange={setJournalSource} tabs={[{ key: 'all', label: 'All' }, { key: 'auto', label: 'Automatic' }, { key: 'manual', label: 'Manual' }]} />}
          actions={<div className="relative w-64"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" /><input value={journalSearch} onChange={e => setJournalSearch(e.target.value)} placeholder="Entry no. or narration" className={`${inputClass} pl-9`} /></div>}>
          {journals.length === 0 ? <EmptyState icon={BookOpen} title="No journal entries" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead><tr className="border-y border-border text-left text-[11px] uppercase text-muted">{['Entry', 'Date', 'Narration', 'Source', 'Amount', 'Status'].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {journals.map(entry => (
                    <Fragment key={entry.id}>
                      <tr onClick={() => setExpanded(expanded === entry.id ? null : entry.id)} className="border-b border-border/50 hover:bg-surface-hover cursor-pointer">
                        <td className="px-4 py-2 font-medium text-accent">{entry.displayId}</td>
                        <td className="px-4 py-2 text-muted">{formatDate(entry.date)}</td>
                        <td className="px-4 py-2 text-foreground max-w-[420px] truncate">{entry.narration}</td>
                        <td className="px-4 py-2"><Badge tone={entry.isAuto ? 'blue' : 'purple'}>{entry.isAuto ? entry.referenceType : 'Manual'}</Badge></td>
                        <td className="px-4 py-2">{formatINR(entry.totalDebit)}</td>
                        <td className="px-4 py-2"><Badge tone={entry.status === 'POSTED' ? 'green' : 'red'}>{entry.status.toLowerCase()}</Badge></td>
                      </tr>
                      {expanded === entry.id && entry.lines.map(line => (
                        <tr key={line.id} className="bg-surface-hover/40 text-xs">
                          <td />
                          <td className="px-4 py-1.5 text-muted">{line.account.code}</td>
                          <td className="px-4 py-1.5 text-foreground">{line.account.name}{line.description ? ` · ${line.description}` : ''}</td>
                          <td />
                          <td className="px-4 py-1.5">{line.debit ? `${formatINR(line.debit)} Dr` : ''}</td>
                          <td className="px-4 py-1.5">{line.credit ? `${formatINR(line.credit)} Cr` : ''}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'ledger' && (
        <div className="space-y-3">
          <Field label="Account" className="max-w-sm">
            <select value={ledgerCode} onChange={e => openLedger(e.target.value)} className={inputClass}>
              <option value="">Choose an account…</option>
              {overview?.trial.rows.map(row => <option key={row.code} value={row.code}>{row.code} · {row.name}</option>)}
            </select>
          </Field>
          {ledger && (
            <Card padded={false} title={`${ledger.account.code} · ${ledger.account.name}`} actions={<span className="text-xs text-muted">Opening {formatINR(ledger.openingBalance)} → Closing {formatINR(ledger.closingBalance)}</span>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead><tr className="border-y border-border text-left text-[11px] uppercase text-muted">{['Date', 'Entry', 'Narration', 'Debit', 'Credit', 'Balance'].map(h => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {ledger.rows.map(row => (
                      <tr key={row.id} className="border-b border-border/50">
                        <td className="px-4 py-2 text-muted">{formatDate(row.date)}</td>
                        <td className="px-4 py-2 text-accent">{row.entry}</td>
                        <td className="px-4 py-2 text-foreground max-w-[420px] truncate">{row.narration}{row.description ? ` · ${row.description}` : ''}</td>
                        <td className="px-4 py-2">{row.debit ? formatINR(row.debit) : ''}</td>
                        <td className="px-4 py-2">{row.credit ? formatINR(row.credit) : ''}</td>
                        <td className="px-4 py-2 font-medium">{formatINR(row.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
