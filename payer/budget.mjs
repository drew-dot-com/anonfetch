// The sidecar's spending rules, pure and on disk: a daily cap in base units,
// a per-fetch price ceiling, and an origin allowlist. Every paid job goes
// through `charge`, which refuses before the packet is built, never after.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

export class Budget {
  /** @param o {{file: string, dailyCap: bigint, maxPrice: bigint, allowedOrigins: string[], now?: () => number}} */
  constructor(o) {
    this.file = o.file
    this.dailyCap = o.dailyCap
    this.maxPrice = o.maxPrice
    this.allowedOrigins = o.allowedOrigins
    this.now = o.now ?? Date.now
    this.state = { day: dayOf(this.now()), spent: '0', count: 0, total_spent: '0', total_count: 0 }
    if (existsSync(this.file)) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, 'utf8')) } } catch { /* a bad file starts a fresh day */ }
    }
    this.roll()
  }

  roll() {
    const day = dayOf(this.now())
    if (this.state.day !== day) this.state = { ...this.state, day, spent: '0', count: 0 }
  }

  get spent() { return BigInt(this.state.spent) }
  get remaining() { const r = this.dailyCap - this.spent; return r < 0n ? 0n : r }

  /** null when the origin may be paid for, else the refusal. */
  originCheck(url) {
    if (this.allowedOrigins.length === 0) return null
    const origin = new URL(url).origin
    return this.allowedOrigins.includes(origin) ? null : { code: 'origin_not_allowed', error: `${origin} is not in PAYER_ALLOWED_ORIGINS` }
  }

  /** null when `price` may be spent now, else the refusal. */
  priceCheck(price) {
    this.roll()
    if (price > this.maxPrice) return { code: 'price_too_high', error: `route price ${price} exceeds PAYER_MAX_PRICE ${this.maxPrice}` }
    if (this.spent + price > this.dailyCap) return { code: 'budget_exhausted', error: `daily cap ${this.dailyCap} reached (${this.spent} spent today, ${price} asked)` }
    return null
  }

  /** Record a paid job. Called after the FULFILL, with what the route charged. */
  record(price) {
    this.roll()
    this.state.spent = (this.spent + price).toString()
    this.state.count += 1
    this.state.total_spent = (BigInt(this.state.total_spent) + price).toString()
    this.state.total_count += 1
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }

  view() {
    this.roll()
    return { day: this.state.day, spent: this.state.spent, cap: this.dailyCap.toString(), remaining: this.remaining.toString(), count: this.state.count, total_spent: this.state.total_spent, total_count: this.state.total_count, max_price: this.maxPrice.toString(), allowed_origins: this.allowedOrigins }
  }
}
