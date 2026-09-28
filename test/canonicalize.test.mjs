// The port reproduces Wuzzy's own conformance vectors (fixtures/canonicalize-v1
// in memetic-block/wuzzy, fetched 2026-09-28). A vector that stops matching
// means the hash we hand a payer is no longer the hash Wuzzy would attest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canonicalize, normalize, contentHash } from '../canonicalize.mjs'

const dir = new URL('./fixtures/', import.meta.url)
const read = (n) => new Uint8Array(readFileSync(new URL(n, dir)))
const text = (n) => readFileSync(new URL(n, dir), 'utf8')
const fixtureUrl = (n) => `https://docs.base.org/fixtures/${n}`

for (const name of ['docs-page', 'code-blocks', 'nested-lists', 'unicode-nfc', 'readability-fallback']) {
  test(`vector ${name} reproduces Wuzzy's content hash`, () => {
    const r = canonicalize({ source: read(`${name}.html`), url: fixtureUrl(`${name}.html`) })
    assert.equal(r.skipped, false)
    assert.equal(r.contentHash, text(`${name}.hash`).trim())
    assert.equal(normalize(r.markdown), r.markdown, 'normalization is idempotent')
    assert.equal(contentHash(normalize(r.markdown)), r.contentHash)
  })
}

test('docs-page markdown matches byte for byte', () => {
  const r = canonicalize({ source: read('docs-page.html'), url: fixtureUrl('docs-page.html') })
  assert.equal(r.markdown, text('docs-page.md'))
})

test('a thin page is skipped, not hashed', () => {
  const r = canonicalize({ source: '<html><body><p>hi</p></body></html>', url: 'https://example.test/' })
  assert.deepEqual({ skipped: r.skipped, reason: r.reason }, { skipped: true, reason: 'thin' })
})
