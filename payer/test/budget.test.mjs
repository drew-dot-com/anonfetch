import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Budget } from '../budget.mjs'

const fresh = (o = {}) => new Budget({ file: join(mkdtempSync(join(tmpdir(), 'budget-')), 'b.json'), dailyCap: 3000n, maxPrice: 2000n, allowedOrigins: [], ...o })

test('cap is enforced before the packet, and rolls at midnight UTC', () => {
  let t = Date.UTC(2026, 8, 28, 23, 59)
  const b = fresh({ now: () => t })
  assert.equal(b.priceCheck(1000n), null); b.record(1000n)
  assert.equal(b.priceCheck(1000n), null); b.record(1000n)
  assert.equal(b.priceCheck(1000n), null); b.record(1000n)
  assert.equal(b.priceCheck(1000n)?.code, 'budget_exhausted')
  t += 2 * 60_000
  assert.equal(b.priceCheck(1000n), null)
  assert.equal(b.view().spent, '0')
  assert.equal(b.view().total_count, 3)
})

test('a price above the ceiling is refused', () => {
  assert.equal(fresh().priceCheck(2001n)?.code, 'price_too_high')
})

test('allowlist by origin; empty means any', () => {
  assert.equal(fresh().originCheck('https://a.example/x'), null)
  const b = fresh({ allowedOrigins: ['https://a.example'] })
  assert.equal(b.originCheck('https://a.example/x?y'), null)
  assert.equal(b.originCheck('https://b.example/x')?.code, 'origin_not_allowed')
  assert.equal(b.originCheck('http://a.example/x')?.code, 'origin_not_allowed')
})

test('state survives a restart', () => {
  const b = fresh(); b.record(700n)
  const again = new Budget({ file: b.file, dailyCap: 3000n, maxPrice: 2000n, allowedOrigins: [] })
  assert.equal(again.view().spent, '700')
})
