'use server'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireRole, requireAuth } from '@/lib/auth-helpers'
import { notifyManagers } from '@/lib/notify'

type NotificationItem = {
  id: string
  type: 'conversation' | 'followup' | 'invoice' | 'stock_alert' | 'field_visit' | 'purchase_order' | 'financial_alert'
  title: string
  subtitle: string
  date: string
  href: string
  unread?: number
}

export async function getTopNotifications() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const now = new Date()
  const followUpWhere = {
    sent: false,
    date: { lte: now },
  }
  const overdueInvoiceWhere = {
    invoiceStatus: 'ACTIVE' as const,
    balanceDue: { gt: 0 },
    dueDate: { lt: now },
  }

  const [
    unreadConversations,
    dueFollowUps,
    overdueInvoices,
    unreadConversationAggregate,
    pendingFollowUpsCount,
    overdueInvoicesCount,
    unreadNotifications,
    unreadNotificationsCount,
  ] = await Promise.all([
    prisma.conversation.findMany({
      where: { unread: { gt: 0 } },
      orderBy: { date: 'desc' },
      take: 8,
      select: {
        id: true,
        customerName: true,
        channel: true,
        unread: true,
        lastMessage: true,
        date: true,
      },
    }),
    prisma.followUp.findMany({
      where: followUpWhere,
      orderBy: { date: 'asc' },
      take: 8,
      include: {
        lead: {
          include: {
            contact: { select: { name: true } },
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: overdueInvoiceWhere,
      orderBy: { dueDate: 'asc' },
      take: 8,
      include: {
        contact: { select: { name: true } },
      },
    }),
    prisma.conversation.aggregate({
      where: { unread: { gt: 0 } },
      _sum: { unread: true },
    }),
    prisma.followUp.count({ where: followUpWhere }),
    prisma.invoice.count({ where: overdueInvoiceWhere }),
    prisma.notification.findMany({
      where: { read: false },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.notification.count({ where: { read: false } }),
  ])

  const conversationItems: NotificationItem[] = unreadConversations.map(c => ({
    id: `conversation-${c.id}`,
    type: 'conversation',
    title: `${c.customerName} sent ${c.unread} unread message${c.unread > 1 ? 's' : ''}`,
    subtitle: c.lastMessage || `New ${c.channel} message`,
    date: c.date.toISOString(),
    href: '/conversations',
    unread: c.unread,
  }))

  const followUpItems: NotificationItem[] = dueFollowUps.map(f => ({
    id: `followup-${f.id}`,
    type: 'followup',
    title: `Follow-up due: ${f.lead.contact.name}`,
    subtitle: f.message,
    date: f.date.toISOString(),
    href: '/leads',
  }))

  const invoiceItems: NotificationItem[] = overdueInvoices.map(inv => ({
    id: `invoice-${inv.id}`,
    type: 'invoice',
    title: `Invoice overdue: ${inv.displayId}`,
    subtitle: `${inv.contact.name} - Balance INR ${Intl.NumberFormat('en-IN').format(inv.balanceDue || 0)}`,
    date: (inv.dueDate || inv.date).toISOString(),
    href: '/billing',
  }))

  const notificationItems: NotificationItem[] = unreadNotifications.map(n => ({
    id: `notification-${n.id}`,
    type: n.type as 'stock_alert' | 'field_visit' | 'purchase_order' | 'financial_alert',
    title: n.title,
    subtitle: n.subtitle,
    date: n.createdAt.toISOString(),
    href: n.href,
  }))

  const items = [...conversationItems, ...followUpItems, ...invoiceItems, ...notificationItems]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 15)

  const unreadConversationsCount = unreadConversationAggregate._sum.unread || 0

  return {
    success: true,
    data: {
      unreadCount: unreadConversationsCount + pendingFollowUpsCount + overdueInvoicesCount + unreadNotificationsCount,
      unreadConversationsCount,
      pendingFollowUps: pendingFollowUpsCount,
      overdueInvoices: overdueInvoicesCount,
      unreadAlerts: unreadNotificationsCount,
      items,
    },
  }
}

export async function markConversationNotificationRead(conversationId: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { unread: 0 },
  })

  revalidatePath('/conversations')
  return { success: true }
}

export async function markAllConversationNotificationsRead() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  await prisma.conversation.updateMany({
    where: { unread: { gt: 0 } },
    data: { unread: 0 },
  })

  revalidatePath('/conversations')
  return { success: true }
}

export async function markNotificationRead(notificationId: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  await prisma.notification.update({
    where: { id: notificationId },
    data: { read: true },
  })

  return { success: true }
}

export async function markAllAlertNotificationsRead() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  await prisma.notification.updateMany({
    where: { read: false },
    data: { read: true },
  })

  return { success: true }
}

// ─── RUN STOCK CHECK (Settings page) ──────────────

export async function runStockCheck() {
  try { await requireRole('ADMIN') } catch { return { success: false, error: 'Admin access required' } }

  try {
    const products = await prisma.product.findMany({
      select: { id: true, name: true, sku: true, stock: true, reorderLevel: true },
    })
    const lowStockProducts = products.filter(p => p.stock <= p.reorderLevel)

    if (lowStockProducts.length === 0) {
      return { success: true, alertsSent: 0, message: 'All stock levels OK' }
    }

    // Deduplicate — skip products already notified in last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recentAlerts = await prisma.notification.findMany({
      where: { type: 'stock_alert', createdAt: { gte: oneDayAgo } },
      select: { metadata: true },
    })
    const recentProductIds = new Set(
      recentAlerts.map(a => (a.metadata as Record<string, unknown>)?.productId).filter(Boolean)
    )
    const newAlerts = lowStockProducts.filter(p => !recentProductIds.has(p.id))

    if (newAlerts.length === 0) {
      return { success: true, alertsSent: 0, message: `${lowStockProducts.length} low-stock item(s) already notified in last 24h` }
    }

    const outOfStock = newAlerts.filter(p => p.stock === 0)
    const lowStock = newAlerts.filter(p => p.stock > 0)

    // WhatsApp text
    const lines = ['\u{1F6A8} *Stock Alert*\n']
    if (outOfStock.length > 0) {
      lines.push(`*Out of Stock (${outOfStock.length}):*`)
      outOfStock.forEach(p => lines.push(`  \u2022 ${p.name} (${p.sku})`))
      lines.push('')
    }
    if (lowStock.length > 0) {
      lines.push(`*Low Stock (${lowStock.length}):*`)
      lowStock.forEach(p => lines.push(`  \u2022 ${p.name} \u2014 ${p.stock} left (reorder at ${p.reorderLevel})`))
    }

    // Email HTML
    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#8B4513;border-bottom:2px solid #D4A574;padding-bottom:10px;">\u{1F6A8} Stock Alert</h2>
        <p style="color:#555;">${newAlerts.length} product(s) need attention.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead><tr style="background:#F5F0EB;">
            <th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;font-size:13px;">Product</th>
            <th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;font-size:13px;">SKU</th>
            <th style="padding:10px;text-align:center;border-bottom:1px solid #ddd;font-size:13px;">Stock</th>
            <th style="padding:10px;text-align:center;border-bottom:1px solid #ddd;font-size:13px;">Reorder At</th>
            <th style="padding:10px;text-align:center;border-bottom:1px solid #ddd;font-size:13px;">Status</th>
          </tr></thead>
          <tbody>${newAlerts.map(p => `
            <tr>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;">${p.name}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;">${p.sku}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;color:${p.stock === 0 ? '#DC2626' : '#D97706'};">${p.stock}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;font-size:13px;">${p.reorderLevel}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;">
                <span style="padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;${p.stock === 0 ? 'background:#FEE2E2;color:#DC2626;' : 'background:#FEF3C7;color:#D97706;'}">${p.stock === 0 ? 'Out of Stock' : 'Low Stock'}</span>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p style="margin-top:20px;font-size:13px;color:#888;">Log in to your dashboard to restock these items.</p>
      </div>`

    const summaryTitle = newAlerts.length === 1
      ? `Stock Alert: ${newAlerts[0].name}`
      : `Stock Alert: ${newAlerts.length} products need restocking`
    const summarySubtitle = newAlerts.length === 1
      ? `${newAlerts[0].stock === 0 ? 'Out of stock' : `Only ${newAlerts[0].stock} left`} (reorder at ${newAlerts[0].reorderLevel})`
      : `${outOfStock.length} out of stock, ${lowStock.length} low stock`

    await notifyManagers({
      type: 'stock_alert',
      title: summaryTitle,
      subtitle: summarySubtitle,
      href: '/inventory',
      metadata: { productIds: newAlerts.map(p => p.id), productId: newAlerts[0].id, count: newAlerts.length },
      emailSubject: `\u{1F6A8} Stock Alert \u2014 ${newAlerts.length} product(s) need restocking`,
      emailHtml,
      whatsappText: lines.join('\n'),
    })

    // Individual in-app notifications for dedup tracking
    if (newAlerts.length > 1) {
      for (const p of newAlerts) {
        try {
          await prisma.notification.create({
            data: {
              type: 'stock_alert',
              title: `Stock Alert: ${p.name}`,
              subtitle: `${p.stock === 0 ? 'Out of stock' : `${p.stock} left`} (reorder at ${p.reorderLevel})`,
              href: '/inventory',
              metadata: { productId: p.id, sku: p.sku },
            },
          })
        } catch { /* skip */ }
      }
    }

    return { success: true, alertsSent: newAlerts.length, message: `${newAlerts.length} alert(s) sent to managers` }
  } catch (err) {
    console.error('[runStockCheck] Error:', err)
    return { success: false, error: 'Failed to run stock check' }
  }
}
