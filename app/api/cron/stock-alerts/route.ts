import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { notifyManagers } from '@/lib/notify'

/**
 * GET /api/cron/stock-alerts
 * Checks inventory for low-stock / out-of-stock products and sends
 * notifications to managers via in-app bell, email, and WhatsApp.
 *
 * Secured with x-api-secret header. Can be called by external cron
 * or manually from the settings page.
 */
export async function GET(req: NextRequest) {
  const apiSecret = req.headers.get('x-api-secret')
  if (!process.env.CRM_API_SECRET || apiSecret !== process.env.CRM_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // 1. Get all products and filter low stock (Prisma can't compare two columns)
    const products = await prisma.product.findMany({
      select: { id: true, name: true, sku: true, stock: true, reorderLevel: true, isSlabTracked: true, stoneLots: { select: { slabs: { where: { status: 'AVAILABLE' }, select: { id: true } } } } },
    })
    const lowStockProducts = products.map(p => ({ ...p, stock: p.isSlabTracked ? p.stoneLots.reduce((sum, lot) => sum + lot.slabs.length, 0) : p.stock })).filter(p => p.stock <= p.reorderLevel)

    if (lowStockProducts.length === 0) {
      return NextResponse.json({ success: true, alertsSent: 0, message: 'All stock levels OK' })
    }

    // 2. Check for recent notifications to avoid duplicates (within 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recentAlerts = await prisma.notification.findMany({
      where: {
        type: 'stock_alert',
        createdAt: { gte: oneDayAgo },
      },
      select: { metadata: true },
    })

    const recentProductIds = new Set(
      recentAlerts
        .flatMap(a => { const metadata = a.metadata as Record<string, unknown> | null; return [metadata?.productId, ...(Array.isArray(metadata?.productIds) ? metadata.productIds : [])] })
        .filter(Boolean)
    )

    const newAlerts = lowStockProducts.filter(p => !recentProductIds.has(p.id))

    if (newAlerts.length === 0) {
      return NextResponse.json({
        success: true,
        alertsSent: 0,
        message: `${lowStockProducts.length} low-stock items already notified in last 24h`,
      })
    }

    // 3. Build summary for batch notification
    const outOfStock = newAlerts.filter(p => p.stock === 0)
    const lowStock = newAlerts.filter(p => p.stock > 0)

    // Build WhatsApp text
    const lines = ['🚨 *Stock Alert*\n']
    if (outOfStock.length > 0) {
      lines.push(`*Out of Stock (${outOfStock.length}):*`)
      outOfStock.forEach(p => lines.push(`  • ${p.name} (${p.sku})`))
      lines.push('')
    }
    if (lowStock.length > 0) {
      lines.push(`*Low Stock (${lowStock.length}):*`)
      lowStock.forEach(p => lines.push(`  • ${p.name} — ${p.stock} left (reorder at ${p.reorderLevel})`))
    }
    const whatsappText = lines.join('\n')

    // Build email HTML
    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#8B4513;border-bottom:2px solid #D4A574;padding-bottom:10px;">🚨 Stock Alert</h2>
        <p style="color:#555;">${newAlerts.length} product(s) need attention.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <thead>
            <tr style="background:#F5F0EB;">
              <th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;font-size:13px;">Product</th>
              <th style="padding:10px;text-align:left;border-bottom:1px solid #ddd;font-size:13px;">SKU</th>
              <th style="padding:10px;text-align:center;border-bottom:1px solid #ddd;font-size:13px;">Stock</th>
              <th style="padding:10px;text-align:center;border-bottom:1px solid #ddd;font-size:13px;">Reorder Level</th>
              <th style="padding:10px;text-align:center;border-bottom:1px solid #ddd;font-size:13px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${newAlerts.map(p => `
              <tr>
                <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;">${p.name}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;">${p.sku}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;color:${p.stock === 0 ? '#DC2626' : '#D97706'};">${p.stock}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;font-size:13px;">${p.reorderLevel}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:center;">
                  <span style="padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;${p.stock === 0 ? 'background:#FEE2E2;color:#DC2626;' : 'background:#FEF3C7;color:#D97706;'}">${p.stock === 0 ? 'Out of Stock' : 'Low Stock'}</span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <p style="margin-top:20px;font-size:13px;color:#888;">Log in to your dashboard to restock these items.</p>
      </div>
    `

    // 4. Send one consolidated notification per product (for dedup tracking)
    //    but a single summary for email/WhatsApp
    const summaryTitle = newAlerts.length === 1
      ? `Stock Alert: ${newAlerts[0].name}`
      : `Stock Alert: ${newAlerts.length} products need restocking`

    const summarySubtitle = newAlerts.length === 1
      ? `${newAlerts[0].stock === 0 ? 'Out of stock' : `Only ${newAlerts[0].stock} left`} (reorder at ${newAlerts[0].reorderLevel})`
      : `${outOfStock.length} out of stock, ${lowStock.length} low stock`

    // Send summary notification (email + WhatsApp)
    await notifyManagers({
      type: 'stock_alert',
      title: summaryTitle,
      subtitle: summarySubtitle,
      href: '/inventory',
      metadata: {
        productIds: newAlerts.map(p => p.id),
        productId: newAlerts[0].id, // primary product for dedup
        count: newAlerts.length,
      },
      emailSubject: `🚨 Stock Alert — ${newAlerts.length} product(s) need restocking`,
      emailHtml,
      whatsappText,
    })

    // Create individual in-app notifications for each product (for granular dedup)
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
        } catch { /* ignore individual creation errors */ }
      }
    }

    return NextResponse.json({
      success: true,
      alertsSent: newAlerts.length,
      products: newAlerts.map(p => ({ name: p.name, stock: p.stock, reorderLevel: p.reorderLevel })),
    })
  } catch (err) {
    console.error('[stock-alerts] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
