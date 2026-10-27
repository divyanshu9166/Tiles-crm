import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // Production connection pool tuning
    max: 20,                  // max open connections (Postgres default is 100, keep headroom)
    idleTimeoutMillis: 30000, // close idle connections after 30s to free resources
    connectionTimeoutMillis: 5000, // fail fast after 5s if no connection available
    keepAlive: true,          // detect dead connections via TCP keepalive
    keepAliveInitialDelayMillis: 10000,
  })
  const adapter = new PrismaPg(pool as any)

  // Safety: log which database this process is connected to (non-production only).
  // Credentials are redacted — only host, port, and database name are printed.
  if (process.env.NODE_ENV !== 'production') {
    try {
      const businessType = process.env.BUSINESS_TYPE || 'furniture'
      const dbUrl = process.env.DATABASE_URL
      if (dbUrl) {
        const parsed = new URL(dbUrl)
        const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
        const dbName = parsed.pathname.replace(/^\//, '')
        console.log(`[db] BUSINESS_TYPE=${businessType} connected to host=${host} db=${dbName}`)
      } else {
        console.log(`[db] BUSINESS_TYPE=${businessType} connected to host=<unknown> db=<DATABASE_URL not set>`)
      }
    } catch {
      // Never let logging/parsing break startup.
      console.log('[db] could not parse DATABASE_URL for startup log (credentials redacted)')
    }
  }

  return new PrismaClient({ adapter })
}

function shouldRefreshPrismaClient(client: PrismaClient | undefined) {
  if (!client) return true

  // In dev, global Prisma instances can survive schema changes.
  // If new models are missing, create a fresh client instance.
  return typeof (client as any).indiaMartConfig === 'undefined' ||
    typeof (client as any).indiaMartLead === 'undefined' ||
    typeof (client as any).scrapInventory === 'undefined' ||
    typeof (client as any).customOrderInventory === 'undefined' ||
    // If production/manufacturing models were added/changed, ensure we recreate the client
    typeof (client as any).productionOrder === 'undefined' ||
    typeof (client as any).customOrder === 'undefined' ||
    typeof (client as any).dealer === 'undefined' ||
    // ERP document models (sales orders, transfers, counts, chatter)
    typeof (client as any).salesOrder === 'undefined' ||
    typeof (client as any).recordActivity === 'undefined'
}

let prismaClient: PrismaClient = globalForPrisma.prisma ?? createPrismaClient()

if (shouldRefreshPrismaClient(prismaClient)) {
  prismaClient = createPrismaClient()
}

export const prisma = prismaClient

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prismaClient
