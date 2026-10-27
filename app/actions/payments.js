'use server';

import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import { requireAuth, requireRole } from '@/lib/auth-helpers';

const MANAGERS = ['ADMIN', 'MANAGER'];

function denied(error) {
  return { success: false, error: error?.message === 'Forbidden' ? 'Manager access required' : 'Please sign in again' };
}

// PAY-YYYYMM-NNNN from the highest number this month, under a lock, so deleted
// entries never make the next number collide (count()+1 did).
async function nextPaymentDisplayId(tx, now = new Date()) {
  const prefix = `PAY-${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}-`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(82463213)::text`;
  const pattern = `^${prefix}([0-9]+)$`;
  const rows = await tx.$queryRaw`SELECT MAX(CAST(substring("displayId" from ${pattern}) AS INTEGER)) AS max FROM "DailyPayment" WHERE "displayId" ~ ${pattern}`;
  return `${prefix}${String((Number(rows[0]?.max) || 0) + 1).padStart(4, '0')}`;
}

// Helper: Generate hash for duplicate detection
const generateReferenceHash = (method, reference) => {
  if (!reference || method === 'Cash') return null; // Cash doesn't need unique reference
  const normalizedMethod = String(method).trim().toLowerCase();
  const normalizedReference = String(reference).trim().toLowerCase();
  return crypto.createHash('md5').update(`${normalizedMethod}:${normalizedReference}`).digest('hex');
};

export async function getDailyPayments(filters = {}) {
  try { await requireAuth(); } catch (error) { return denied(error); }
  try {
    const { startDate, endDate, method, type, search, status, reconciled } = filters;
    const where = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      where.date = {
        gte: start,
        lte: end,
      };
    } else if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      where.date = { gte: start };
    }

    if (method && method !== 'All') where.method = method;
    if (type && type !== 'All') where.type = type;

    if (status && status !== 'All') where.status = status;
    if (reconciled !== undefined) where.reconciled = reconciled === true;
    if (filters.includeReversals !== true) where.isReversal = false;

    if (search) {
      where.OR = [
        { displayId: { contains: search, mode: 'insensitive' } },
        { reference: { contains: search, mode: 'insensitive' } },
        { contact: { name: { contains: search, mode: 'insensitive' } } },
        { customerName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const payments = await prisma.dailyPayment.findMany({
      where,
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, displayId: true } },
        invoice: { select: { id: true, displayId: true } },
        customOrder: { select: { id: true, displayId: true } },
      },
      orderBy: { date: 'desc' },
    });

    return { success: true, data: payments };
  } catch (error) {
    console.error('Error fetching daily payments:', error);
    return { success: false, error: 'Failed to fetch payments' };
  }
}

export async function createDailyPayment(data) {
  let session;
  try { session = await requireAuth(); } catch (error) { return denied(error); }
  try {
    // Validation: Amount must be positive integer
    const amount = parseInt(data.amount);
    if (!amount || amount <= 0) return { success: false, error: 'Invalid amount. Must be greater than 0.' };
    const type = data.type || 'IN';
    if (type !== 'IN' && type !== 'OUT') return { success: false, error: 'Payment type must be IN or OUT.' };
    const gstAmount = parseInt(data.gstAmount || 0);
    if (!Number.isInteger(gstAmount) || gstAmount < 0 || gstAmount > amount) return { success: false, error: 'Invalid GST amount.' };
    // Staff record payments as themselves; managers may name who received it.
    const receivedByStaffId = session.user.role === 'STAFF'
      ? (session.user.staffId ? Number(session.user.staffId) : null)
      : (data.receivedByStaffId ? parseInt(data.receivedByStaffId) : null);

    // Validation: Payment method is required
    if (!data.method) return { success: false, error: 'Payment method is required.' };

    // Validation: For cheques, cheque number is mandatory
    if (data.method === 'Cheque' && !data.chequeNumber) {
      return { success: false, error: 'Cheque number is mandatory for cheque payments.' };
    }

    // Validation: Reference uniqueness (prevent duplicates for non-cash payments)
    if (data.reference && data.method !== 'Cash') {
      const hash = generateReferenceHash(data.method, data.reference);
      const duplicate = await prisma.dailyPayment.findFirst({
        where: {
          referenceHash: hash,
          isReversal: false,
        }
      });

      if (duplicate) {
        return {
          success: false,
          error: `A payment with ${data.method} reference "${data.reference}" already exists. Please use a different reference or mark as duplicate.`
        };
      }
    }

    // Validation: Cheque-specific validations
    if (data.method === 'Cheque') {
      if (data.chequeDate && new Date(data.chequeDate) < new Date()) {
        // Allow post-dated cheques
      }
      // Check for duplicate cheque numbers from same drawer
      const duplicateCheque = await prisma.dailyPayment.findFirst({
        where: {
          chequeNumber: data.chequeNumber,
          contactId: data.contactId,
          method: 'Cheque',
          isReversal: false,
        }
      });
      if (duplicateCheque) {
        return { success: false, error: 'Cheque number already exists for this contact.' };
      }
    }

    const now = new Date();
    let parsedDate = now;
    if (data.date) {
      const d = new Date(data.date);
      if (!isNaN(d.getTime())) parsedDate = d;
    }

    const referenceHash = generateReferenceHash(data.method, data.reference);

    // Create payment
    const payment = await prisma.$transaction(async tx => tx.dailyPayment.create({
      data: {
        displayId: await nextPaymentDisplayId(tx, now),
        amount,
        gstAmount,
        type,
        method: data.method,
        reference: data.reference || null,
        referenceHash: referenceHash,
        date: parsedDate,
        status: 'Pending', // New payments start as Pending
        receivedByStaffId,
        chequeNumber: data.chequeNumber || null,
        chequeDate: data.chequeDate ? new Date(data.chequeDate) : null,
        customerName: data.customerName || null,
        contactId: data.contactId ? parseInt(data.contactId) : null,
        orderId: data.orderId ? parseInt(data.orderId) : null,
        invoiceId: data.invoiceId ? parseInt(data.invoiceId) : null,
        customOrderId: data.customOrderId ? parseInt(data.customOrderId) : null,
        notes: data.notes || null,
        attachment: data.attachment || null,
      },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, displayId: true } },
        invoice: { select: { id: true, displayId: true } },
        customOrder: { select: { id: true, displayId: true } },
        receivedByStaff: { select: { id: true, name: true, email: true } },
      }
    }));

    revalidatePath('/payments');
    return { success: true, data: payment };
  } catch (error) {
    console.error('Error creating payment:', error.message, error.code);
    let errorMessage = 'Failed to create payment';
    if (error.code === 'P2003') {
      errorMessage = 'The Customer ID, Order ID, Invoice ID, or Staff ID does not exist.';
    } else if (error.code === 'P2002') {
      errorMessage = 'A unique constraint was violated. This reference may already exist.';
    }
    return { success: false, error: errorMessage };
  }
}


// Only an admin may delete, and only an unreconciled pending entry (a typo
// caught the same day). Anything else is reversed so the cash book keeps history.
export async function deleteDailyPayment(id) {
  try { await requireRole('ADMIN'); } catch (error) { return { success: false, error: error?.message === 'Forbidden' ? 'Only an admin can delete payments. Reverse it instead.' : 'Please sign in again' }; }
  try {
    const deleted = await prisma.dailyPayment.deleteMany({ where: { id: parseInt(id), status: 'Pending', reconciled: false, isReversal: false } });
    if (deleted.count !== 1) return { success: false, error: 'Only unreconciled pending payments can be deleted. Reverse this payment instead.' };
    revalidatePath('/payments');
    return { success: true };
  } catch (error) {
    console.error('Error deleting payment:', error);
    return { success: false, error: 'Failed to delete payment' };
  }
}

// NEW: Reverse a payment (creates audit trail)
export async function reversePayment(id, reason = '') {
  try { await requireRole(...MANAGERS); } catch (error) { return denied(error); }
  try {
    const reversal = await prisma.$transaction(async tx => {
    // Claim the original first so the same payment can be reversed only once.
    const claimed = await tx.dailyPayment.updateMany({ where: { id: parseInt(id), isReversal: false, status: { not: 'Reversed' } }, data: { status: 'Reversed' } });
    if (claimed.count !== 1) throw new Error('This payment is already reversed (or not found)');
    const original = await tx.dailyPayment.findUnique({ where: { id: parseInt(id) } });
    const now = new Date();

    // Create reversal entry (negative of original)
    return tx.dailyPayment.create({
      data: {
        displayId: await nextPaymentDisplayId(tx, now),
        amount: original.amount,
        gstAmount: original.gstAmount,
        type: original.type === 'IN' ? 'OUT' : 'IN', // Reverse the type
        method: original.method,
        reference: `REVERSAL-${original.reference || original.id}`,
        date: now,
        status: 'Reversed',
        reversalId: parseInt(id),
        isReversal: true,
        reversalReason: reason,
        customerName: original.customerName,
        contactId: original.contactId,
        notes: `Reversal of ${original.displayId}: ${reason}`,
      },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        receivedByStaff: { select: { id: true, name: true, email: true } },
      }
    });
    });

    revalidatePath('/payments');
    return { success: true, data: reversal };
  } catch (error) {
    console.error('Error reversing payment:', error);
    return { success: false, error: error instanceof Error && error.message.startsWith('This payment') ? error.message : 'Failed to reverse payment' };
  }
}

// NEW: Mark cheque as bounced
export async function markChequeBounced(id, bounceReason = '') {
  try { await requireRole(...MANAGERS); } catch (error) { return denied(error); }
  try {
    const payment = await prisma.dailyPayment.findUnique({ where: { id: parseInt(id) } });
    if (!payment) return { success: false, error: 'Payment not found' };
    if (payment.method !== 'Cheque') return { success: false, error: 'Only cheque payments can be marked as bounced' };

    const updated = await prisma.dailyPayment.update({
      where: { id: parseInt(id) },
      data: {
        chequeBounced: true,
        bounceReason: bounceReason,
        status: 'Bounced',
      },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
        receivedByStaff: { select: { id: true, name: true, email: true } },
      }
    });

    revalidatePath('/payments');
    return { success: true, data: updated };
  } catch (error) {
    console.error('Error marking cheque as bounced:', error);
    return { success: false, error: 'Failed to update cheque status' };
  }
}

// NEW: Reconcile payments (batch mark as reconciled)
export async function reconcilePayments(paymentIds, bankRefNumbers = {}) {
  try { await requireRole(...MANAGERS); } catch (error) { return denied(error); }
  try {
    if (!Array.isArray(paymentIds) || paymentIds.length === 0) {
      return { success: false, error: 'No payments selected for reconciliation' };
    }
    if (paymentIds.length > 500 || paymentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
      return { success: false, error: 'Invalid payment selection' };
    }

    const updates = await Promise.all(
      paymentIds.map(id =>
        prisma.dailyPayment.update({
          where: { id: parseInt(id) },
          data: {
            reconciled: true,
            reconciledDate: new Date(),
            bankRefNumber: bankRefNumbers[id] || null,
            status: 'Reconciled'
          }
        })
      )
    );

    revalidatePath('/payments');
    return { success: true, count: updates.length };
  } catch (error) {
    console.error('Error reconciling payments:', error);
    return { success: false, error: 'Failed to reconcile payments' };
  }
}

// NEW: Get payment reconciliation summary
export async function getReconciliationSummary(filters = {}) {
  try { await requireAuth(); } catch (error) { return denied(error); }
  try {
    const { startDate, endDate, method } = filters;
    const where = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      where.date = { gte: start, lte: end };
    }

    if (method && method !== 'All') where.method = method;

    const unreconciled = await prisma.dailyPayment.findMany({
      where: { ...where, reconciled: false, isReversal: false },
      include: { contact: { select: { name: true } } }
    });

    const reconciled = await prisma.dailyPayment.findMany({
      where: { ...where, reconciled: true, isReversal: false },
      include: { contact: { select: { name: true } } }
    });

    const bouncedCheques = await prisma.dailyPayment.findMany({
      where: { ...where, chequeBounced: true },
      include: { contact: { select: { name: true } } }
    });

    return {
      success: true,
      data: {
        unreconciledCount: unreconciled.length,
        unreconciledAmount: unreconciled.reduce((s, p) => s + p.amount, 0),
        unreconciledList: unreconciled,
        reconciledCount: reconciled.length,
        reconciledAmount: reconciled.reduce((s, p) => s + p.amount, 0),
        bouncedChequeCount: bouncedCheques.length,
        bouncedChequeAmount: bouncedCheques.reduce((s, p) => s + p.amount, 0),
        bouncedCheques,
      }
    };
  } catch (error) {
    console.error('Error getting reconciliation summary:', error);
    return {
      success: true,
      data: {
        unreconciledCount: 0,
        unreconciledAmount: 0,
        unreconciledList: [],
        reconciledCount: 0,
        reconciledAmount: 0,
        bouncedChequeCount: 0,
        bouncedChequeAmount: 0,
        bouncedCheques: [],
      }
    };
  }
}

export async function getDailyCashRegister(date) {
  try { await requireAuth(); } catch (error) { return denied(error); }
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    let register = await prisma.dailyCashRegister.findUnique({
      where: { date: startOfDay },
    });

    if (!register) {
      register = await prisma.dailyCashRegister.create({
        data: {
          date: startOfDay,
          openingCash: 0,
        },
      });
    }

    // Recalculate cashIn / cashOut from DailyPayment and Expenses
    const payments = await prisma.dailyPayment.findMany({
      where: {
        date: { gte: startOfDay, lte: endOfDay },
        method: 'Cash',
        isReversal: false,
        chequeBounced: false,
        status: { not: 'Reversed' },
      },
    });
    // Cash taken at the POS / on invoices belongs in the day's cash book too.
    const invoiceCash = await prisma.payment.aggregate({
      where: { date: { gte: startOfDay, lte: endOfDay }, method: 'Cash', amount: { gt: 0 }, invoice: { heldAt: null } },
      _sum: { amount: true },
    });
    const cashIn = payments.filter(p => p.type === 'IN').reduce((sum, p) => sum + p.amount, 0) + (invoiceCash._sum.amount || 0);

    // For cashOut we also include Cash expenses from Expense model
    const cashPaymentsOut = payments.filter(p => p.type === 'OUT').reduce((sum, p) => sum + p.amount, 0);
    let totalCashOut = cashPaymentsOut;

    try {
      const cashExpenses = await prisma.expense.findMany({
        where: { date: { gte: startOfDay, lte: endOfDay }, paymentMode: 'Cash', status: 'Approved' },
      });
      totalCashOut += cashExpenses.reduce((sum, e) => sum + e.amount, 0);
    } catch (e) {
      // Expense model error, continue with just payments
    }

    register = await prisma.dailyCashRegister.update({
      where: { id: register.id },
      data: {
        cashIn,
        cashOut: totalCashOut
      },
    });

    return { success: true, data: register };
  } catch (error) {
    console.error('Error fetching cash register:', error);
    return { success: false, error: 'Failed to fetch cash register' };
  }
}

export async function updateOpeningCash(date, openingCash) {
  try { await requireRole(...MANAGERS); } catch (error) { return denied(error); }
  try {
    const amount = Number(openingCash);
    if (!Number.isInteger(amount) || amount < 0) return { success: false, error: 'Opening cash must be a whole amount of zero or more' };
    const startOfDay = new Date(date);
    if (Number.isNaN(startOfDay.getTime())) return { success: false, error: 'Invalid date' };
    startOfDay.setHours(0, 0, 0, 0);

    const register = await prisma.dailyCashRegister.upsert({
      where: { date: startOfDay },
      update: { openingCash: amount },
      create: { date: startOfDay, openingCash: amount },
    });

    revalidatePath('/payments');
    return { success: true, data: register };
  } catch (error) {
    console.error('Error updating opening cash:', error);
    return { success: false, error: 'Failed to update opening cash' };
  }
}
