/** Shared serialized-stone inventory invariants used by server actions. */

export async function syncStoneLotTotals(tx: any, lotId: number) {
  await tx.$queryRaw`SELECT id FROM "StoneLot" WHERE id = ${lotId} FOR UPDATE`
  const [totals, available, allocated] = await Promise.all([
    tx.slab.aggregate({
      where: { lotId },
      _count: { _all: true },
      _sum: { sqft: true },
    }),
    tx.slab.aggregate({
      where: { lotId, status: 'AVAILABLE' },
      _sum: { sqft: true },
    }),
    tx.slab.count({ where: { lotId, status: { in: ['RESERVED', 'IN_PROCESSING'] } } }),
  ])

  const totalSlabs = totals._count._all
  const status = totalSlabs === 0
    ? 'DISCONTINUED'
    : (available._sum.sqft || 0) > 0
      ? 'IN_STOCK'
      : allocated > 0
        ? 'ALLOCATED'
        : 'SOLD_OUT'

  return tx.stoneLot.update({
    where: { id: lotId },
    data: {
      totalSlabs,
      // totalSqft remains the physical lot size; availableSqft is the live
      // sellable balance and is reduced when slabs are allocated/sold/damaged.
      totalSqft: totals._sum.sqft || 0,
      availableSqft: available._sum.sqft || 0,
      status,
    },
  })
}
