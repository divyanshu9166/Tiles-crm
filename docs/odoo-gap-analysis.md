# Tiles CRM vs Odoo — ERP gap analysis and what was built

Odoo (v17/18) was used as the reference: Sales, Inventory, Purchase, Manufacturing,
Accounting, Employees and the shared "Discuss/Activities" layer. Odoo is open source
(LGPL, github.com/odoo/odoo), so its flows are documented directly rather than
reverse-engineered. This document maps every relevant Odoo capability to the CRM,
records what was implemented in this round, and lists the remaining roadmap.

Legend: ✅ built now · 🟢 already existed · 🟡 partial · ⬜ roadmap

---

## 1. The core idea we copied from Odoo: documents, not screens

Odoo's strength is that every business event is a **document with a lifecycle** that
links to the next document:

```
Quotation ──confirm──▶ Sales Order ──▶ Delivery Order(s) ──validate──▶ stock moves
                            │                 └─ partial ▶ Backorder
                            └──────────▶ Invoice(s) for delivered/ordered qty ──▶ Payments

Purchase Order ──approve──▶ Goods Receipt (GRN) ──validate──▶ stock + average cost
                                   └─ partial ▶ Backorder / "No backorder" closes PO short

Reordering rule ──forecast below min──▶ Replenishment ──order──▶ draft PO per vendor
Physical count ──apply──▶ inventory adjustment (only the differences)
```

Every document carries a **chatter** (log + tracked changes) and **activities**
(scheduled calls / meetings / to-dos assigned to a team member). The CRM previously
went quotation → invoice directly, received POs all-or-nothing, and had no
team-activity layer. Those three gaps were the priority.

---

## 2. Module-by-module comparison

### Sales

| Odoo feature | Before | Now |
|---|---|---|
| Quotations, PDF, validity, T&C | 🟢 | 🟢 |
| Quotation → **Sales Order** confirmation (one SO per quotation, locked link) | ⬜ (text marker to held invoice) | ✅ `createSalesOrderFromQuotation` |
| Multi-line sales order with salesperson, commitment date, customer ref, dispatch address | ⬜ (`Order` = 1 product) | ✅ `SalesOrder` / `SalesOrderLine` |
| Delivery status (to deliver / partial / delivered) | ⬜ | ✅ computed per order |
| Invoice status (nothing / to invoice / fully invoiced) | ⬜ | ✅ computed per order |
| Invoicing policy: ordered vs delivered quantities | ⬜ | ✅ per order |
| Partial invoices, charges (freight/loading/installation) billed once | ⬜ | ✅ |
| Lock order (close short) / cancel only before delivery or billing | ⬜ | ✅ |
| Stock warning on confirmation (free-to-use quantity) | ⬜ | ✅ |
| Serial-tracked stone (slabs) on sales orders: slab picking, reservation, billing on measured sq.ft | ⬜ (POS only) | ✅ |
| Pricelists per customer group (fixed / % off / cost-plus, quantity breaks, validity) | 🟡 dealer price lists only | ✅ `/pricelists`, applied on sales orders, quotations and the POS (customer's list by phone, or one picked by hand) |
| Optional products, quotation templates | ⬜ | ⬜ |
| Down payments / advance invoices | 🟡 via "ordered" policy | ⬜ dedicated down-payment line |
| Margin per line | ⬜ | ⬜ (cost is now AVCO, so margins become reliable) |
| Sales teams, targets, commissions | 🟡 staff targets JSON | ✅ `/sales-teams`: teams, round-robin lead assignment with capacity, invoiced vs target, team flow and leaderboard (commissions ⬜) |
| Customer returns (return picking + credit note) | 🟡 credit note only | ✅ Return on delivery → stock back → "Create refund" credit note |

### Inventory

| Odoo feature | Before | Now |
|---|---|---|
| Warehouses / locations, internal transfers, stock ledger | 🟢 godowns + transfers + ledger | 🟢 |
| Lots/batches with shade, FIFO-friendly remaining qty | 🟢 | 🟢 batch/shade selectable on deliveries |
| Serial tracking (slabs), book-match, samples, offcuts | 🟢 (ahead of Odoo for stone) | 🟢 |
| **Operation types**: Receipts and Delivery Orders as documents | ⬜ | ✅ `StockPicking` (GRN-/DO- numbers) |
| Partial validation + **backorders** / "No backorder" | ⬜ | ✅ |
| Reschedule / change source location of a transfer | ⬜ | ✅ |
| Delivery challan / GRN print with vehicle & driver | 🟡 e-way bill fields only | ✅ |
| **Forecasted quantity** (on hand − reserved + incoming) | ⬜ | ✅ `computeForecast` |
| Reservation of stock for confirmed deliveries | ⬜ | ✅ (soft reservation via ready deliveries) |
| **Reordering rules** (min / max / multiple / per location / vendor / lead time) | 🟡 single reorder level + alert | ✅ `ReorderRule` |
| **Replenishment report** + "Order" → draft POs merged per vendor | ⬜ | ✅ |
| **Physical inventory / cycle counts** with live-balance apply | 🟡 per-product "set stock" | ✅ `InventoryCount` |
| Inventory valuation — **average cost (AVCO)** | ⬜ cost overwritten by last price | ✅ configurable AVCO / last price |
| Inventory Overview dashboard (cards per operation, late counts) | ⬜ | ✅ `/operations` |
| Multi-step routes (pick → pack → ship), putaway rules, wave picking | ⬜ | ⬜ (not needed at current scale) |
| Landed costs (freight/duty added to stock value) | ⬜ | ✅ `/landed-costs`: split by quantity / value / equal over GRNs, AVCO raised for stock on hand, sold share to COGS, journal |
| FIFO valuation layers, stock valuation report | ⬜ | ⬜ |
| Scrap as a location | 🟡 offcut/scrap records | ⬜ |
| Barcode scanning app | 🟡 barcode lib present | ⬜ |

### Purchase

| Odoo feature | Before | Now |
|---|---|---|
| RFQ / PO, approval, supplier notification, payments, returns | 🟢 | 🟢 |
| **Vendor pricelists** (price, min qty, lead time, vendor SKU, preferred) | ⬜ | ✅ `ProductSupplier` |
| Receipt created on approval; partial receipts with backorders | ⬜ (all-or-nothing, default godown only) | ✅ |
| Close PO short ("No backorder") | ⬜ | ✅ |
| Cancel blocked once goods are received (no silent stock drift) | ⬜ | ✅ |
| **Order approval** (double validation above an amount) | ⬜ | ✅ Settings → ERP Policies |
| Race-free PO numbering | ⬜ (`count()+1`) | ✅ locked sequence |
| Vendor bills + 3-way match (ordered / received / billed) | ⬜ | ✅ `/vendor-bills`, quantity capped at receipts, price variance needs admin |
| Blanket orders / purchase agreements | ⬜ | ⬜ |
| Supplier ledger / statement | ⬜ | ⬜ |

### Manufacturing (fabrication)

| Odoo feature | Before | Now |
|---|---|---|
| BoM, work centers, production orders, steps, QC, scrap, job costing | 🟢 | 🟢 |
| MRP planning against stock | 🟡 ignores POs/reservations | ✅ MRP on `computeForecast`, "Order shortages" to preferred vendors |
| Component reservation at MO start | ⬜ | ✅ open production orders reserve components (with wastage) in the forecast |
| Chatter on production orders | ⬜ | 🟡 model enabled (`ProductionOrder`), UI to add |

### Accounting

| Odoo feature | Before | Now |
|---|---|---|
| P&L, balance sheet, cash flow, trial balance, aging, GST returns | 🟢 (computed from documents) | 🟢 |
| Operating expenses in P&L | ⬜ (payroll only) | ✅ approved expenses by category |
| Auto-posted double-entry journals from invoices, payments, bills | ⬜ (chart of accounts is decorative) | ✅ `/accounting`: idempotent posting, trial balance, general ledger, inventory reconciliation, cron |
| Bank reconciliation | 🟡 daily-payment reconcile flag | ⬜ |
| Payment follow-ups (dunning levels) | 🟡 overdue notifications | ✅ `/accounts` desk: reminder levels, call / email / promise-to-pay, statements |
| Analytic accounting (by project/site), budgets | 🟡 expense budgets | ⬜ |
| Lock dates, fiscal year closing | ⬜ | ⬜ |

### Team management / Discuss

| Odoo feature | Before | Now |
|---|---|---|
| **Chatter** on documents: notes + tracked field changes + system log | ⬜ (only custom-order timeline) | ✅ `RecordMessage` panel on SO, transfers, counts; POs, quotations and invoices are logged (panel to add on those legacy pages) |
| **Activities**: call / meeting / to-do / follow-up with due date & assignee | 🟡 dealer tasks only | ✅ `RecordActivity` |
| "My Activities" with overdue / today / planned, team view for managers | ⬜ | ✅ `/activities` + top-bar badge |
| App-grouped navigation (Sales, Inventory, Purchase…) | ⬜ flat list of 28 links | ✅ collapsible sections |
| Role permissions | 🟡 3 roles, several actions unguarded | ✅ guards added (see §4) |
| Departments, job positions, org chart | ⬜ | ⬜ |
| Approvals app (discount above X, expense approval UI) | 🟡 | ⬜ |
| Time off | ⬜ | ⬜ |

---

## 3. What was built in this round

**Data model** (`prisma/migrations/20261025100000_erp_core`, purely additive):
`SalesOrder`, `SalesOrderLine`, `StockPicking`, `StockPickingLine`, `ReorderRule`,
`ProductSupplier`, `InventoryCount`, `InventoryCountLine`, `RecordMessage`,
`RecordActivity`; `Invoice.salesOrderId`, `InvoiceItem.salesOrderLineId`,
`StoreSettings.costingMethod`, `StoreSettings.poApprovalLimit`.

**Engine** (`lib/erp/*`): locked document sequences, chatter helpers, forecast,
pricing/tax maths shared by SO and invoices, and `stock-ops.ts`, which validates
deliveries/receipts (row locks, partial quantities, backorders, AVCO, batch/shade rules)
on top of the existing `adjustStock` ledger.

**Screens**

| Route | Purpose |
|---|---|
| `/sales-orders` | Orders list with delivery/invoice status, KPI strip, "New order" form |
| `/sales-orders/[id]` | Form view: statusbar, smart buttons, ordered/delivered/invoiced/free-stock per line, create invoice, plan delivery, lock/cancel, print, chatter |
| `/operations` | Inventory overview cards + receipts / delivery orders list |
| `/operations/[id]` | Transfer form: done quantities, batch/shade, vehicle & driver, backorder dialog, challan/GRN print, chatter |
| `/replenishment` | To-order report, reordering rules, vendor pricelists |
| `/inventory-counts`, `/inventory-counts/[id]` | Count sessions; staff count, managers apply |
| `/activities` | My / team activities |
| Settings → ERP Policies | Costing method, PO approval limit |

Quotations get **Confirm → Sales Order**. Purchases route "Receive" to the GRN for
partial receipts, and "Receive all" now runs through the same GRN flow.

## 4. Bugs and risks fixed along the way

- `createInvoice`, `recordPayment`, `cancelInvoice`, `createCreditNote`, `finalizeHeldInvoice`
  had **no role check**. Any signed-in user, or a direct server-action call, could cancel bills.
  They now require Admin/Manager.
- `cancelInvoice` could restore stock twice under concurrent requests. It now claims the
  cancellation atomically.
- Staff Portal stock updates changed `Product.stock` directly. They wrote no godown balance, no ledger
  entry and had no auth check. They now go through the ledger, and staff can only post as themselves.
- PO receipt overwrote cost with the last price, and only ever received into the default godown.
- A partially received PO could be cancelled, leaving received stock orphaned.
- PO numbers used `count()+1`, which collided after deletes or concurrent creation.
- P&L ignored the Expenses module entirely.
- `/purchases` and `/financials` were hidden in the menu but not route-protected.

## 5. Second round (built and browser-tested)

| Module | What it does |
|---|---|
| Slabs on sales orders | Granite/marble lines by slab count; delivery shows the physical slabs (lot, size, sq.ft, shade, book-match) to pick; reserve/release slabs for a project; invoice bills the **measured** sq.ft of the slabs delivered |
| Vendor bills (`/vendor-bills`) | Create bill from a received PO; ordered vs received vs billed per line; over-billing blocked; price variance → "To check", admin must accept; duplicate supplier invoice no. blocked; cancel reverses billed qty |
| Accounting (`/accounting`) | Automatic double-entry from invoices, receipts, credit notes, stock moves (incl. slabs), GRNs (via GRNI), vendor bills, PO payments, expenses, payroll; reversals for cancellations; trial balance, general ledger, books-vs-stock reconciliation; `/api/cron/accounting` |
| Customer returns | "Return" on a validated delivery (quantities or specific slabs + reason) → RET-xxxx; stock/slabs back, order shows "To refund" → "Create refund" issues credit notes for exactly the returned part |
| Pricelists (`/pricelists`) | Price levels with product / category / all-product rules, quantity breaks and validity; customers assigned to a list; sales orders pick and re-price automatically, hand-typed prices are kept |

Migrations: `20261025120000_erp_slab_sales`, `20261025130000_erp_vendor_bills`,
`20261025140000_erp_auto_journals`, `20261025150000_stone_lot_po`,
`20261025160000_erp_customer_returns`, `20261025170000_erp_pricelists` (all additive).

## 6. Third round

| Module | What it does |
|---|---|
| MRP on forecast | Material planning uses on hand − reserved + incoming; open production orders reserve their components; "Order shortages" creates draft POs from vendor prices |
| Sales teams (`/sales-teams`) | Teams with leader, members and monthly invoicing target; round-robin auto-assignment of new leads respecting member capacity; sales orders inherit the salesperson's team; dashboard: flow lead → quotation → order → delivery → invoice → collection, leaderboard |
| Accounts desk (`/accounts`) | Receivables, overdue, bills to pay, bank/cash and GST from the journal; payment follow-ups with reminder levels, promise-to-pay snoozing and statements; **Register payment** on vendor bills; PO advances can be **applied to the bill** and a bill payment can never take the PO above its total |
| Landed costs (`/landed-costs`) | Transporter / customs / unloading costs over one or more GRNs, split per cost line by quantity, value or equally; validating raises the average cost of what is still on hand and sends the sold share to COGS; journal Dr Inventory / Dr COGS, Cr expense, payable, cash or bank; "Landed cost" button on every completed receipt |
| Pricelists on quotations and POS | Pricelist selector + "Apply prices" on the quotation builder and the billing screen; picking a product or a customer prices it from the customer's list (by phone); quotations and POS bills record the list, and quotations pass it to the sales order |

Migrations: `20261026100000_erp_teams_followups`, `20261026120000_erp_landed_costs_pricelists` (additive).

Known limits: PO advances are applied as whole payments (a payment larger than the bill's open amount
stays on the PO); validated landed costs are final, as in Odoo; under average costing the on-hand share
of a receipt is capped by current stock because there are no per-receipt valuation layers.

## 7. Recommended roadmap (next)

1. **Supplier ledger / statement** and partial application of advances.
2. **Bank reconciliation** against the journal (statement import, match receipts/payments).
3. **Commissions** on sales-team targets; departments and approval chains.
4. Barcode/QR scanning on transfers and counts (mobile).
5. Lock dates and year-end closing on the journal.
6. FIFO valuation layers and a stock valuation report.

## 8. Operating notes

- Apply the migration: `npm run db:migrate:tiles` (or `npm run db:migrate` for `.env`).
- Existing approved POs get their GRN automatically the first time Operations is opened.
- Tests: `node scripts/test-inventory.cjs` runs 97 checks (inventory, ERP flows and ERP math) on a
  disposable schema.
- First visit to Accounting posts the backlog; afterwards each visit (or the cron with
  `x-api-secret: CRM_API_SECRET`) posts only new events. If stock existed before, use
  "Align opening stock" once.
