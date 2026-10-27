# Inventory review and fixes

## Stock integrity

- Product creation, location allocation and opening ledger entries now commit together. Invalid locations roll back the entire creation.
- Stock additions/removals are calculated on the server using live location balances. The screen no longer converts an uninitialized balance into an absolute stock replacement or silently clamps excessive removals to zero.
- PostgreSQL product locks serialize quantity changes across locations. Stock totals and movement ledgers stay consistent during concurrent adjustments, invoices, orders, receipts, transfers and manufacturing movements.
- Absolute counts can include the displayed balance; stale counts fail rather than overwrite a newer movement. Legacy aggregate stock requests preserve balances at other locations.
- Existing unallocated stock gets an opening ledger entry on its first location movement.
- Product metadata updates cannot directly replace stock or change tracking/units after inventory history exists. Omitted fields in partial updates no longer apply creation defaults.

## Batches, sales and purchases

- Manual batches assign a shade/batch to existing unassigned stock. They do not imply a second physical receipt. Quantity, dates, supplier and duplicate batch validation are enforced.
- Batch quantities cannot exceed physical stock. Batch stock adjustments update both balances; reductions require enough stock in the selected batch.
- Invoices and store orders cannot silently consume assigned batch stock without its batch/shade workflow.
- Order creation and stock deduction are atomic. Cancelling an order returns its stock once and prevents reopening without a new allocation.
- Purchase receipt rechecks the locked order and cannot receive it twice. Multi-line stone POs remain partially received until all lines are complete; competing slab receipts cannot exceed the ordered quantity.
- Supplier returns reduce the matching supplier/PO batches and physical stock together, and link ledger entries to the return. Another supplier's batch is protected.
- Received POs and products with inventory history cannot be deleted through drafts to bypass their stock/document workflows.
- Concurrent transfer creation generates distinct numbers; completion applies both movements only once.

## Serialized stone and samples

- Slab availability comes from physical slabs, including inventory alerts and location views. Location-filtered lots omit empty lots and report scoped totals.
- Sample checkout/return and lot balances update together. Failed checkout leaves no orphan customer; duplicate returns cannot reopen a sold or allocated slab.
- Inventory edits cannot fabricate allocations or sale prices. Those changes use the linked job, invoice or sample workflow.
- Book-match pairing validates availability, clears both previous partners and preserves symmetric links.
- Offcuts must fit within the source dimensions and remaining area. Concurrent claims cannot exceed the source slab's area.
- Locations containing slabs cannot be deleted.

## Forms and imports

- Added tile/stone attribute editing, nullable attribute clearing and stock-group assignment.
- Fixed blank-SKU generation hangs. Explicit duplicate SKUs are reported rather than silently renamed.
- Imports retain units, cost, brand and tile attributes, reject malformed/negative numeric values and report failed data rows. The tiles template uses tile examples and accurate required-column labels.
- Stock reason/notes are persisted, mutation failures are shown, duplicate submission is guarded, and loading states recover from server failures.
- Inventory refresh updates previously opened location, batch, aging and ledger views. A zero reorder threshold remains zero.
- Inventory mutations enforce roles and reads require authentication.

## Verification

`node scripts/test-inventory.cjs` provisions a unique disposable PostgreSQL schema, runs **53 regression checks**, and removes the schema in a finally block. Existing CRM records are not changed by the tests. The suite covers concurrency, rollback, stock/batch consistency, receipts, returns, cancellations, samples, pairing and offcuts.

The read-only existing-database audit found **zero** stock-total mismatches, negative godown balances, overassigned batches and stale available slab-area totals. TypeScript checking, linting of the changed inventory files and the production build passed.

The broader test suite has an unrelated failure in `lib/validations/ai-call.test.ts`: its calling-worker status expectation fails. Calling-agent configuration was not modified for this inventory task.

The local browser smoke check reached the login page. Signed-in inventory UI interaction still needs an authenticated browser session.

Current schema constraints remain: prices/costs and batch/transfer quantities use integer columns; aggregate stock and physical dimensions support fractional quantities. Inputs now validate these constraints instead of failing at database insertion. No production schema migration or database reset is required.
