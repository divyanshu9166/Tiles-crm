'use server'

import { guarded } from '@/lib/action-guard'

import { prisma } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { requireAuth } from '@/lib/auth-helpers'

export async function getReviews(...args: Parameters<typeof _getReviews>): Promise<Awaited<ReturnType<typeof _getReviews>>> {
  return guarded('getReviews', () => _getReviews(...args))
}

async function _getReviews() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const reviews = await prisma.review.findMany({
    include: { contact: true },
    orderBy: { date: 'desc' },
  })

  return {
    success: true,
    data: reviews.map(r => ({
      id: r.id,
      customer: r.customerName,
      rating: r.rating,
      text: r.text,
      date: r.date.toISOString().split('T')[0],
      product: r.product,
      platform: r.platform,
      replied: r.replied,
    })),
  }
}

export async function getReviewStats(...args: Parameters<typeof _getReviewStats>): Promise<Awaited<ReturnType<typeof _getReviewStats>>> {
  return guarded('getReviewStats', () => _getReviewStats(...args))
}

async function _getReviewStats() {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const [total, avgRating, breakdown] = await Promise.all([
    prisma.review.count(),
    prisma.review.aggregate({ _avg: { rating: true } }),
    prisma.review.groupBy({ by: ['rating'], _count: true }),
  ])

  const stars: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const b of breakdown) {
    stars[b.rating] = b._count
  }

  return {
    success: true,
    data: {
      total,
      avgRating: Math.round((avgRating._avg.rating || 0) * 10) / 10,
      breakdown: stars,
    },
  }
}

export async function markReplied(...args: Parameters<typeof _markReplied>): Promise<Awaited<ReturnType<typeof _markReplied>>> {
  return guarded('markReplied', () => _markReplied(...args))
}

async function _markReplied(id: number) {
  try { await requireAuth() } catch { return { success: false, error: 'Please sign in again' } as never }
  const review = await prisma.review.update({
    where: { id },
    data: { replied: true },
  })

  revalidatePath('/reviews')
  return { success: true, data: review }
}
