// Creates/refreshes a local QA admin login for browser testing. The password is
// generated and written to .env.tiles (git-ignored) as QA_LOGIN_EMAIL / QA_LOGIN_PASSWORD.
const fs = require('fs')
const crypto = require('crypto')
const dotenv = require('dotenv')
const bcrypt = require('bcryptjs')
const pg = require('pg')
const envFile = '.env.tiles'
const env = dotenv.parse(fs.readFileSync(envFile))
const url = new URL(env.DATABASE_URL)
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Refusing: QA admin is only for a local database')
const email = env.QA_LOGIN_EMAIL || 'qa.admin@tilescrm.local'
const password = env.QA_LOGIN_PASSWORD || `Qa-${crypto.randomBytes(9).toString('base64url')}`
;(async () => {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL })
  const hash = await bcrypt.hash(password, 12)
  await pool.query(`INSERT INTO "User" (email, name, "hashedPassword", role, "isActive", "createdAt", "updatedAt")
    VALUES ($1, 'QA Admin', $2, 'ADMIN', true, now(), now())
    ON CONFLICT (email) DO UPDATE SET "hashedPassword" = EXCLUDED."hashedPassword", "isActive" = true, role = 'ADMIN'`, [email, hash])
  await pool.end()
  if (!env.QA_LOGIN_EMAIL) fs.appendFileSync(envFile, `\n# Local QA login (scripts/create-qa-admin.cjs)\nQA_LOGIN_EMAIL=${email}\nQA_LOGIN_PASSWORD=${password}\n`)
  console.log(`QA admin ready: ${email} (password stored in ${envFile})`)
})().catch(e => { console.error(e.message); process.exit(1) })
