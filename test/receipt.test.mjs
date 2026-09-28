import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { rawReceipt, extractReceipt, cutUtf8, formatOf } from '../receipt.mjs'

const page = readFileSync(new URL('./fixtures/docs-page.html', import.meta.url))
const hash = readFileSync(new URL('./fixtures/docs-page.hash', import.meta.url), 'utf8').trim()
const base = { url: 'https://docs.base.org/fixtures/docs-page.html', method: 'GET', status: 200, headers: { 'content-type': 'text/html; charset=utf-8', server: 'x', 'set-cookie': 'no' }, body: page, fetchedAt: 1790000000000, elapsedMs: 42, jobId: 'abc', maxBodyBytes: 24576 }

test('raw receipt keeps the 09-01 shape and adds raw_hash', () => {
  const r = rawReceipt(base)
  assert.equal(r.mode, 'raw')
  assert.equal(r.body_b64, page.toString('base64'))
  assert.equal(r.raw_hash, createHash('sha256').update(page).digest('hex'))
  assert.equal(r.truncated, false)
  assert.deepEqual(Object.keys(r.headers), ['content-type', 'server'])
  assert.equal(r.fetched_at, '2026-09-21T14:13:20.000Z')
})

test('extract receipt carries markdown and the Wuzzy content hash', () => {
  const r = extractReceipt(base)
  assert.equal(r.mode, 'extract')
  assert.equal(r.format, 'html')
  assert.equal(r.content_hash, hash)
  assert.equal(r.thin, false)
  assert.equal(r.truncated, false)
  assert.ok(r.title)
  assert.ok(!r.content.includes('Skip to content'))
  assert.equal(r.protocol, 'wuzzy/crawl-experimental')
})

test('extract receipt cuts to the cap on a code point boundary, hash stays whole', () => {
  const r = extractReceipt({ ...base, maxBodyBytes: 301 })
  assert.equal(r.truncated, true)
  assert.ok(Buffer.byteLength(r.content, 'utf8') <= 301)
  assert.equal(r.content_hash, hash)
  assert.ok(r.content_bytes > 301)
})

test('a thin page is reported, not hashed', () => {
  const r = extractReceipt({ ...base, body: Buffer.from('<html><body><p>hi</p></body></html>') })
  assert.equal(r.thin, true)
  assert.equal(r.content_hash, null)
})

test('cutUtf8 never splits a multibyte character', () => {
  const s = 'héllo wörld ✓✓✓'
  for (let n = 1; n <= Buffer.byteLength(s); n++) {
    const c = cutUtf8(s, n)
    assert.ok(!c.text.includes('�'))
    assert.ok(Buffer.byteLength(c.text, 'utf8') <= n)
  }
})

test('formatOf: markdown by type or extension, html by default, other text as-is', () => {
  assert.equal(formatOf('text/html; charset=utf-8', 'https://a/x'), 'html')
  assert.equal(formatOf('text/markdown', 'https://a/x'), 'markdown')
  assert.equal(formatOf(undefined, 'https://a/README.md'), 'markdown')
  assert.equal(formatOf(undefined, 'https://a/'), 'html')
  assert.equal(formatOf('application/json', 'https://a/x'), 'markdown')
})
