import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Every exported server action in app/actions is callable from any browser,
// so each one must check the session (or be deliberately public, below).
// This test fails when a new unguarded action is added.

const AUTH_CALL = /require(Auth|Role|Actor|StaffScope)\s*\(|currentActor\s*\(|await actor\s*\(\)/

// Deliberately public, with the reason.
const PUBLIC_ACTIONS: Record<string, string> = {
  'settings.ts:getPublicBranding': 'login screen shows store name and logo',
  'staff.ts:getStaffLoginOptions': 'login screen lists staff names (id, name, role only)',
  'indiamart.js:syncIndiaMartPullLeadsCron': 'cron entry, checks CRM_API_SECRET itself',
  'godowns.ts:updateGodownStock': 'delegates to products.updateStock, which checks roles',
}

function unguardedActions() {
  const dir = path.join(process.cwd(), 'app', 'actions')
  const found: string[] = []
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(ts|js)$/.test(file) || file.includes('.test.')) continue
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    if (!/^['"]use server['"]/m.test(src)) continue
    const marks = [...src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm)]
    marks.forEach((mark, index) => {
      const body = src.slice(mark.index, index + 1 < marks.length ? marks[index + 1].index : src.length)
      if (!AUTH_CALL.test(body)) found.push(`${file}:${mark[1]}`)
    })
  }
  return found
}

describe('server action access checks', () => {
  it('every exported server action checks the session or is listed as public', () => {
    const unexpected = unguardedActions().filter(name => !(name in PUBLIC_ACTIONS))
    expect(unexpected).toEqual([])
  })

  it('the public list has no stale entries', () => {
    const unguarded = new Set(unguardedActions())
    expect(Object.keys(PUBLIC_ACTIONS).filter(name => !unguarded.has(name))).toEqual([])
  })
})
