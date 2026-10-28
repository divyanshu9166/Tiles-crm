import type { Prisma } from '@prisma/client'
import { supplyTypeFor } from './gst-math'

type Db = Pick<Prisma.TransactionClient, 'storeSettings' | 'contact' | 'supplier'>

async function storeGstin(db: Db) {
  return (await db.storeSettings.findFirst({ where: { id: 1 }, select: { gstNumber: true } }))?.gstNumber
}

// Sales: our GSTIN vs the customer's; the user's choice stands when either is missing.
export async function customerSupplyType(db: Db, contactId: number | null | undefined, chosen?: string | null) {
  const contact = contactId ? await db.contact.findUnique({ where: { id: contactId }, select: { gstNumber: true } }) : null
  return supplyTypeFor(await storeGstin(db), contact?.gstNumber, chosen)
}

// Purchases: our GSTIN vs the supplier's.
export async function supplierSupplyType(db: Db, supplierId: number) {
  const supplier = await db.supplier.findUnique({ where: { id: supplierId }, select: { gstNumber: true } })
  return supplyTypeFor(await storeGstin(db), supplier?.gstNumber)
}
