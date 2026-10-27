// Provisions a disposable schema and runs the inventory regressions against
// real PostgreSQL. Existing CRM tables and credentials are never printed/touched.
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const dotenv = require('dotenv')
const pg = require('pg')

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Test command failed (${signal || code})`)))
  })
}

async function main() {
  const localEnv = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {}
  const source = process.env.INVENTORY_TEST_DATABASE_URL || process.env.DATABASE_URL || localEnv.DATABASE_URL
  if (!source) throw new Error('Set DATABASE_URL or INVENTORY_TEST_DATABASE_URL to a PostgreSQL database')
  const schema = `inventory_test_${randomUUID().replaceAll('-', '')}`
  if (!/^inventory_test_[a-f0-9]+$/.test(schema)) throw new Error('Invalid disposable schema name')
  const url = new URL(source)
  url.searchParams.set('schema', schema)
  const pool = new pg.Pool({ connectionString: source })
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await run(['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { ...process.env, DATABASE_URL: url.toString() })
    await run(['node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', 'lib/inventory-stock.test.ts', 'lib/inventory.integration.test.ts', 'lib/erp/erp-math.test.ts', 'lib/erp.integration.test.ts'], { ...process.env, INVENTORY_TEST_DATABASE_URL: url.toString() })
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await pool.end()
    console.log('Disposable inventory test schema removed.')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
