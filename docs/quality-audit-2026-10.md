# ERP quality audit — October 2026

Four read-only reviews (security, money/tax/accounting, stock integrity, document
lifecycles + error handling) of the whole codebase before handing the software to
clients. Each finding was traced in code; the headline finding of every area was
re-checked by hand. Findings reported by more than one reviewer are merged.

Status: ☐ open · ☑ fixed (with a regression test)

---

## Phase 1 — Security (fix before any client sees the software)

| # | Sev | Finding | Where |
|---|---|---|---|
| S1 ☑ | Critical | `getStoreSettings` has no auth and returns the **SMTP password**, bank account, GSTIN; `/login` calls it, so every anonymous visitor receives the password | `app/actions/settings.ts:97,156`, `app/login/page.js:48` |
| S2 ☑ | Critical | `getStaff` has no auth (also called by `/login`): every staff name, phone, email, **login username**; staff PINs can be 4 chars and login has no rate limit | `app/actions/staff.ts:114`, `/api/auth/login` |
| S3 ☑ | Critical | Session HMAC secret falls back to a hard-coded string when `SESSION_SECRET` is unset → anyone can forge an ADMIN cookie | `lib/session.ts:3` |
| S4 ☑ | High | Daily payments: all 9 actions unauthenticated; STAFF can delete cash-book entries, reverse, reconcile, change opening cash | `app/actions/payments.js` |
| S5 ☑ | High | Expenses: 18/19 actions unauthenticated; `createExpense` auto-approves and moves cash; approver name comes from the client | `app/actions/expenses.ts` |
| S6 ☑ | High | `getStaffMember` returns salary, PAN, bank, UAN/ESI to any user | `app/actions/staff.ts:144` |
| S7 ☑ | High | `clockIn/clockOut` take `staffId` from the browser; geofence skipped without GPS → attendance/payroll fraud | `app/actions/staff.ts:377,431` |
| S8 ☑ | High | `getChannelConfigs` returns WhatsApp/FB/IG access tokens to STAFF; toggle/send unauthenticated | `app/actions/channels.ts` |
| S9 ☑ | High | Public webhook GET returns any conversation by sequential id → all chat history dumpable | `app/api/webhooks/website/route.ts:71` |
| S10 ☑ | High | SVG upload served from the app's origin → stored XSS (STAFF → ADMIN takeover) | `app/api/upload`, `app/api/uploads/[...path]`, `lib/r2.ts` |
| S11 ☑ | High | FB/IG webhook never verifies the signature | `app/api/social/webhook/route.ts:70` |
| S12 ☑ | Medium | Middleware skips every path containing a dot (`/sales-orders/1.x`, uploads) | `middleware.ts:55-60` |
| S13 ☑ | Medium | Quotations (7), drafts (10), leads, calls, notifications… — 151 actions without auth, ~74 of them change data | see per-file table below |
| S14 ☑ | Medium | Sessions never revoked: deactivated user / role change only applies after 7-day cookie expiry | `lib/auth-helpers` |
| S15 ☑ | Medium | Password oracles: `updatePassword` unauthenticated for any `userId`; staff-portal password check; no rate limits | `app/actions/auth.ts:68`, `staff.ts:248` |
| S16 ☑ | Medium | Cleanup cron fails open without `CRON_SECRET` and deletes WhatsApp data on GET; `/api/download-echo` is an SSRF proxy; `/api/debug` dumps data | `app/api/cron/cleanup`, `app/api/download-echo`, `app/api/debug` |
| S17 ☑ | Low | Non-constant-time secret comparisons; 5 cron routes redirected to /login (never run); role mismatches (financials, payroll); mass assignment in `updateMarketplaceChannel` | various |

Unauthenticated actions per file: expenses 18, custom-orders 15, manufacturing 15, drafts 10, payments 9, email-campaigns 8, leads 8, quotations 7, staff 7, calls 5, channels 5, invoices 5, notifications 5, appointments 4, gst 4, settings 4, campaigns 3, orders 3, purchases 3, reviews 3, walkins 3, indiamart 2, auth/contacts/dashboard/financials/godowns 1 each.
Already fully guarded: accounting, accounts-desk, batches, chatter, dealers, erp-settings, inventory-counts, landed-costs, operations, payroll, pricelists, products, replenishment, sales-orders, sales-teams, stock-groups, stone-inventory, vendor-bills.

---

### Phase 1 result (branch `security-phase-1`)

S1–S16 fixed. S17 partly: the cleanup cron now compares its secret in constant time; the other cron
secrets, the 5 cron routes blocked by middleware, the financials/payroll role mismatches remain.

- Login page uses two public actions that return only store name/logo and staff names.
- SMTP password and channel tokens never reach the browser; blank/masked values keep the stored secret.
- Session secret has no fallback; every action re-reads the account (deactivation and role changes apply at once).
- Failed-password limiter on login, staff-portal unlock, password change and verify routes (5 tries / 15 min, per process).
- 106 previously open server actions now check the session (role per screen); STAFF act only on their own staff id.
- Webhooks: website chat polling needs the visitor's sessionId; FB/IG events must carry a valid Meta signature.
- Uploads: type detected from content, SVG never served, nosniff + sandbox; middleware only skips real static files.
- Removed unused, unauthenticated code: /api/debug, /api/download-echo, four channel helpers; email tracking moved out of server actions.
- Tests: `lib/actions-auth.test.ts` fails if any new server action lacks an access check; `lib/security.test.ts`,
  `lib/password-limit.test.ts`, `lib/file-type.test.ts` cover the behaviour.

**Deployment notes:** the website chat widget must send `sessionId` when polling replies; Facebook/Instagram
pages need their App Secret saved (or `META_APP_SECRET`) or their events are rejected; `CRON_SECRET` must be set
for the cleanup cron; `SESSION_SECRET` (32+ chars) is mandatory.

---

## Phase 2 — Money and stock correctness (wrong bills, wrong stock)

| # | Sev | Finding | Example |
|---|---|---|---|
| M1 ☑ | Critical | POS area lines bill `ceil(area/coverage)` boxes but **deduct the typed qty** from stock | 300 sq.ft of a 15 sq.ft/box tile bills 20 boxes, stock drops by 1 (`invoices.ts:35` vs `:64,96`) |
| M2 ☑ | Critical | Editing a **percent-discount** invoice reloads the rupee amount as a percent | ₹10,000 −10% stored as 1,000 → edit → 1,000% off → saved ₹0, PAID (`billing/page.js:784`) |
| M3 ☑ | Critical | SQFT lines: screen and server disagree | qty 1, area 100, ₹50: cashier sees ₹59, invoice saves ₹5,900 (`billing/page.js:203-211` vs `invoices.ts:34`) |
| M4 ☑ | Critical | Overpayment ("Change") booked as cash received | bill ₹1,180, tendered ₹2,000 → cash +₹2,000, receivable −₹820 (`invoices.ts:462,543`) |
| M5 ☑ | Critical | **Editing an issued invoice** rewrites lines with no stock movement and the journal keeps the old amount | sell 10 A, edit to 2 B, cancel → A short by 10, B +2 phantom; GL stays at old total (`invoices.ts:594-789`) |
| M6 ☑ | Critical | Cancelled held bill can still be **finalized** → stock consumed for a cancelled sale | `cancelInvoice` leaves `heldAt`; `finalizeHeldInvoice` ignores status (`invoices.ts:853,919`) |
| M7 ☑ | Critical | Move cancelled store order to Drafts restores stock a second time | order 5 → cancel → drafts = +5 phantom (`drafts.ts:404-451`) |
| M8 ☑ | Critical | Quotation already confirmed as SO can be moved to drafts, restored, and confirmed into a **second SO** | `drafts.ts:476-543,1395` |
| M9 ☑ | Critical | Moving an approved/paid PO to drafts orphans payments, bills and its receipt; restore creates a second receipt | `drafts.ts:689-801` |
| M10 ☑ | High | Credit notes: never reduce `balanceDue`; double-click restores stock twice; later cancel reverses twice | `invoices.ts:844-906` |
| M11 ☑ | High | Cancelling an invoice with payments/credit notes drives receivables negative, no refund recorded | `invoices.ts:844` |
| M12 ☑ | High | Two cashiers paying the same bill: both Payment rows saved, `amountPaid` counts one | `invoices.ts:804-836` |
| M13 ☑ | High | Production complete/cancel not locked: double submit consumes materials twice; cancel after complete releases slabs | `manufacturing.ts:953-974,1059-1079` |
| M14 ☑ | High | Vendor bill ignores PO discount → AP and input GST overstated, bill never fully payable | `vendor-bills.ts:136` |
| M15 ☑ | High | GST on charges: quotation taxes installation/freight/loading, invoice and SO don't | quote ₹1,26,260 vs bill ₹1,25,000 |
| M16 ☑ | High | Re-invoicing a sales order after cancelling the first invoice loses freight/loading charges | `sales-orders.ts:395,445` |
| M17 ☑ | Medium | Applying a physical count erases sales made after counting | `inventory-counts.ts:187` |
| M18 ☑ | Medium | AVCO wrong when a receipt has the same product twice | `stock-ops.ts:177-212` |
| M19 ☑ | Medium | PO edit racing approval → receipt loses its PO link → second full receipt | `purchases.ts:367-399` |
| M20 ☑ | Medium | PO cancel strands advance payments; payments accepted on unapproved POs | `purchases.ts:648-701` |
| M21 ☑ | Medium | Manufacturing bypasses `adjustStock` (legacy stock wiped, no ledger without godowns, random location) | `manufacturing.ts:95-185` |
| M22 ☑ | Medium | Staff "Stock Out" skips the batch check; any role can post stock in/out | `staff.ts:596` |
| M23 ☑ | Medium | Quotations editable / status-changeable after confirmation; double-click "Create invoice" makes two | `quotations.ts:408-674` |
| M24 ☑ | Medium | Paise truncated instead of rounded; screen vs saved off by ₹1 | `invoices.ts:34`, `quotations/page.js:279` |
| M25 ☑ | Low | Held-invoice delete racing finalize; count line edit after apply; PO approval total re-read; slab moves have no ledger history | various |

---

### Phase 2 result (branch `money-stock-phase-2`)

M1–M16 fixed, each with an integration test in `lib/erp.integration.test.ts` (110 checks pass).

- One set of line rules (`lib/line-math.ts`) for the POS and quotation screens and both servers: the cashier's
  total is the saved total, a BOX tile sold by area deducts the boxes it bills, amounts round to whole rupees.
- Percent discounts reload as the rupee amount; issued bills keep their lines and totals (credit note + new bill
  to change them); parked bills stay editable under a lock.
- Change handed back is not booked as cash; a cancelled parked bill can't be finalized.
- Drafts: cancelled store orders don't restore stock twice; confirmed quotations and approved/paid/billed POs
  can't be deleted; quotations restore under their original number.
- Credit notes reduce balanceDue, run under a lock (stock returns once), share one numbering lock with order
  refunds; paid/credited bills can't be cancelled; concurrent payments both count.
- Production complete/cancel claim the order under a row lock and return errors instead of freezing.
- Vendor bills apply the PO discount to untaxed amount and GST.
- Cancelling a sales-order invoice that carried freight/loading/installation re-opens them for the next invoice.

**Open:**
- **M15 decided (tax them):** transport, freight, loading and installation on POS bills and sales orders now carry GST
  at the principal line's rate (composite supply), as quotations do. `Invoice.chargesGst` (migration
  `20261027100000_invoice_charges_gst`) records it; GSTR-1 adds taxed charges to taxable value and to the principal
  item's HSN row. Bills issued before this change keep their untaxed charges and report as before.
- M14 follow-up (Phase 3): received stock is still valued at the undiscounted PO price, so the PO discount stays
  in GRNI until stock valuation applies it.
- M24: POS and quotation lines now round consistently; other places that truncate paise are Phase 3/4.
- M17–M23, M25 (medium/low) not started.
- SQFT-priced products (none in the data today) keep deducting their typed quantity, not boxes for the area;
  confirm how such products are stocked before changing it.


### Phase 2 follow-up (branch `books-phase`)

M14 follow-up and M17–M25 closed. M17 (count snapshot), M18 (same product twice on a receipt) and M22 (batch check
on staff stock-out) were already fixed in the Sales & Inventory pass; M24 is covered by the shared `line-math`.

- **M14:** receipt lines carry the PO's discounted unit cost, so stock is valued net of the discount and the supplier
  bill clears GRNI.
- **M19:** PO edit and approval re-check the status (and the approval limit against the current total) under the row lock.
- **M20:** no payments on draft POs; the balance is checked under the lock; a PO with money paid cannot be cancelled
  (the advance would be lost track of).
- **M21:** production receipts and issues use `adjustStock` (ledger row, legacy stock kept, default location).
- **M23:** a quotation confirmed as a sales order or invoiced can't be edited or re-statused; a double click on
  "Create invoice" makes one invoice (queued per quotation within a server process).
- **M25:** cancelling a parked bill that was finalized a moment earlier puts the stock back (fresh read after the claim).
  Count line edits after apply and the PO approval total were already guarded.
- **S17:** `secretMatches()` (constant time) for every API secret; the five cron routes are reachable (middleware);
  financial report actions are admin-only like their screen.

**Open:** slab status changes (sold, damaged, moved) still have no stock-ledger history; a double click on
"Create invoice" is serialized per server process only (fine for one instance).


---

## Sales & Inventory review (branch `sales-inventory-phase-3`)

The Surface Visualizer (`/recommend` page and API) was removed. The Sales and Inventory sections were then
re-audited. 117 integration checks pass, including 7 new `P3:` cases.

**Sales — fixed**
- Editing a quotation kept its area (it was wiped on reload); GST 0% survives edit; prices fall back to the
  product price only when no rate was typed.
- Only managers can confirm a quotation into a sales order or invoice; staff see a hint instead.
- Quotation → invoice duplicate check matches the exact quotation number on active invoices only.
- Bank details in quotation notes no longer leak onto sales orders, invoices and printed bills (notes are
  HTML-escaped on print).
- One customer per phone number: `+91 98765 43210`, `09876543210` and `9876543210` resolve to the same contact
  (`lib/phone.ts`) across leads, walk-ins, quotations, orders, sales orders, invoices, appointments and calls.
- India time for printed times (Docker `TZ=Asia/Kolkata`) and for date defaults (`lib/local-date.ts`); before
  05:30 IST screens used to default to yesterday.
- POS credit sale: no payment + a due date makes a "Credit" bill; held bills list only active ones; invoice stats
  ignore parked bills and count overdue from the due date; the daily cash register includes POS cash and
  excludes reversed payments.
- A payment above the balance is refused with a clear message (it used to be cut down silently).
- Dealer collections are atomic (two at once can't overpay); on-account payments settle the oldest open orders
  first and keep any remainder as an advance; approved dealer orders skip a second credit check.
- Double-booked appointment slots show a friendly message; leads search by phone; errors show as toasts.
- Store orders can be moved to packing / shipped / delivered or cancelled from the list; the dead Channels tab
  was removed.
- POS search shows out-of-stock matches greyed out and says when results are capped.
- The sales order list returns every open order (only closed history is capped at 300).

**Inventory — fixed**
- "Assign stock to godown" removed (it created stock from nothing); pending transfers can be cancelled; the
  approver is the signed-in user; completing a transfer asks for confirmation.
- Stock value is shown at cost (stone at its lot cost), not at selling price.
- Physical counts snapshot the shelf when a line is counted, so a sale made after counting is not undone.
- AVCO stays correct when one receipt has the same product on two lines.
- Staff quantity updates can't leave batch quantities above stock.
- Damaged slabs can be restored, with a reversing journal (`SLABLOSSREV`); slab actions confirm first.
- Low-stock alerts use the forecast (on hand − reserved + incoming) and skip products without a reorder level.
- Inventory list shows boxes with their area ("120 boxes · 1,860 sq.ft"); new products default to BOX with a
  cost field; the nav item "Transfers" is now "Operations".

**UX**
- Lead and walk-in screens have "New quotation", which opens the form with the customer filled in.
- The sales order form footer shows untaxed amount, GST and total, using the same math as the server.

**Done in the follow-up pass**
- Transfer lines show what the source godown holds and block more than that; bulk import skips blank rows, reports
  duplicate SKUs by sheet row; a BOX product needs coverage per box.
- Invoices made from a quotation carry the converting user's salesperson (team dashboards count them).

**Done in the Odoo-parity pass**
- A purchase order has a "Deliver to" location (`PurchaseOrder.godownId`, migration
  `20261030100000_po_destination_godown`); its receipt goes there. Replenishment makes one draft PO per supplier
  *and* location, and a location's rule counts only drafts delivering there.
- Receipts capture the supplier's lot number, shade and expiry per line (Operations → receipt). The same lot received
  again adds to the same batch; with nothing typed the PO-based batch is created as before.

**Open (needs a product decision or a larger change)**
- Batches per godown: batch quantity is still one total per batch (a shade's stock can't be told apart by
  location); that needs a per-location batch-stock table touching deliveries, transfers, counts and POS.
- Store orders still deduct stock without a GST invoice; staff can't reach Billing, so this is their only way to
  sell. Odoo's way is quotation → sales order → delivery → invoice, which staff can already start; turning
  store orders into invoices needs a rule for GST on their amount, so it was left as is.
- Large pages (`quotations`, `billing`, `inventory`, 2,300–2,800 lines each) should be split into routes
  (maintainability only; do it as its own change).

---

## Phase 3 — Books, GST and reports

| # | Sev | Finding |
|---|---|---|
| B1 ☑ | High | COGS/stock journals valued at the product's cost **when the cron runs**, not at the time of the movement (AVCO and landed costs change it) — store unit cost on each ledger row |
| B2 ☑ | High | Posted journals never follow edits: invoice edits, expense edits/deletes, approve→reject→approve, voided auto entries (versioned source keys + reversals) |
| B3 ☑ | High | P&L: credit notes subtracted gross of GST from net sales; refunded invoices excluded while their credit notes are subtracted |
| B4 ☑ | Medium | GSTR-1 includes parked bills; GSTR-3B ignores credit notes; ITC built from POs instead of posted vendor bills |
| B5 ☑ | Medium | Interstate vs intrastate never derived from customer/supplier state (SO from quotation forced intrastate; POs never IGST) |
| B6 ☑ | Medium | Legacy balance sheet: credit notes treated as cash refunds, payments on cancelled invoices dropped, AP includes draft POs |
| B7 ☑ | Low | Credit-note journal debits Sales for the charges share (should be Other Income) |


### Phase 3 result (branch `books-phase`)

B1–B7 fixed, each with an integration test in `lib/erp.integration.test.ts` (127 checks pass) and unit tests
for the GST helpers in `lib/erp/erp-math.test.ts`.

- **B1:** every stock-ledger row stores `unitCost` at the time of the move (migration
  `20261028100000_stock_ledger_unit_cost`); journals use it. Older rows fall back to the PO price / current cost.
- **B2:** invoices, payments, credit notes, vendor bills, supplier payments, expenses and landed costs follow their
  document: an edit reverses the live entry (`REV:<key>`) and posts `<key>~2`, `~3`…; cancel/reject/delete
  reverses it. Auto-posted entries can't be voided by hand. Expense edits no longer touch the cash register for
  unapproved expenses.
- **B3:** P&L keeps fully refunded bills in sales and subtracts only the goods share of credit notes.
- **B4:** GSTR-1 skips parked bills, counts cancelled ones in the document summary and lists credit-note tax;
  GSTR-3B nets it; GSTR-2/ITC come from posted vendor bills (IGST no longer counted twice).
- **B5:** with both GSTINs known, the state codes decide interstate vs intrastate on POS bills, parked-bill edits,
  sales orders (incl. from quotations), POs and replenishment POs; otherwise the user's choice stands. The billing
  screen locks the selector when it is decided.
- **B6:** balance sheet, trial balance and cash flow no longer treat credit notes as cash refunds; credit beyond what
  was owed shows as "Refunds owed to customers"; payments on refunded bills count; AP skips draft POs; ITC from
  posted vendor bills.
- **B7:** credit notes debit Other Income for the freight/loading/installation share.

**Follow-ups, since done:**
- Sales-order form locks its supply-type selector when both GSTINs are known.
- Cash refunds to customers are recorded (`CustomerRefund`, action `recordCustomerRefund`, journal `RF:<id>`); the
  balance sheet, trial balance and cash flow subtract refunds paid, and "Refunds owed to customers" shrinks accordingly.
- P&L cost of goods now comes from stock-ledger SALE/RETURN rows at their stamped `unitCost`.

**Migrations to run on each database before deploying:** `20261028100000_stock_ledger_unit_cost` and
`20261029100000_customer_refund`.

---

## Phase 4 — Reliability and numbering

| # | Sev | Finding |
|---|---|---|
| R1 ☑ | High | No error boundary anywhere; Dashboard, Billing, Quotations, Financials, Purchases, Manufacturing, Inventory go blank or freeze when an action fails |
| R2 ☑ | High | ~280 server actions throw instead of returning `{ success:false }` (quotations, invoices reads, purchases, drafts, manufacturing, financials, expenses…) |
| R3 ☑ | High | Daily-payment numbers `count()+1` with hard deletes → numbering jams for the month; same payment can be reversed repeatedly |
| R4 ☑ | Medium | Other `last+1` numbering that can collide under concurrent users: invoices (POS vs SO path use different locks), credit notes, quotations, production (PRD-), journal vouchers (JV-), draft restores (also ignore `invoicePrefix`) |
| R5 ☑ | Medium | 132 `alert()` and 27 `confirm()` calls for errors/confirmations; raw Prisma messages shown to users |


### Phase 4 result (branch `books-phase`)

R1–R5 fixed.

- **R1:** `app/(dashboard)/error.js` (sidebar stays, "Try again" / "Dashboard") and `app/global-error.js`.
- **R2:** `lib/action-guard.ts` `guarded()` wraps the 285 exported server actions that return `{ success }` but could
  throw (generated by a codemod; each public `foo` calls `_foo` inside the guard). A throw becomes
  `{ success:false, error }`; database/Prisma text is replaced by a plain message; redirect/not-found signals pass
  through. Actions that return raw data (not a result object) are untouched.
- **R3:** daily-payment numbers come from the highest number under a lock and a payment can be reversed only once
  (already in place from Phase 2; covered by the existing tests).
- **R4:** `nextNumber()` / `nextInvoiceNumber()` in `lib/erp/sequence.ts`: one lock and the store prefix for POS,
  sales-order and draft-restored invoices; quotations, production orders, manual journals, custom orders and draft
  restores (orders, quotations, invoices, credit notes, POs) no longer use `count()+1` or the last row.
- **R5:** `confirmDialog()` (in `components/AlertToastProvider.js`) replaces all 36 `window.confirm` calls with an
  in-app dialog. `alert()` was already routed to toasts by the provider; raw Prisma messages no longer reach users
  because of R2.

**Open:**
- Field-visit numbers (`SV-`/`FV-`) still use per-staff counts; low risk, not changed.
- The error pages and confirm dialog have not been checked in the browser (needs a signed-in session).

---

## How fixes are made

Each item is fixed with a regression test (integration test on the disposable schema
via `node scripts/test-inventory.cjs`, or a unit test for pure logic), then checked in
the browser where it is user-visible. Phases go in order; within a phase, Critical first.
