// The two receipt shapes the kind 5301 job answers with. Pure: a fetched
// response in, a JSON-able receipt out, so the shapes are tested without the
// Anyone client running. `raw` is the 2026-09-01 shape plus `raw_hash` and
// `fetched_at`; `extract` is new (2026-09-28): the page as canonical markdown
// under wuzzy/crawl v1, with the content hash that procedure produces, sized
// to ride home in one FULFILL.
import { canonicalize, rawHash, PROTOCOL, PROTOCOL_VERSION } from './canonicalize.mjs'

export const MODES = new Set(['raw', 'extract'])
const RECEIPT_HEADERS = ['content-type', 'content-length', 'server', 'date', 'location', 'cache-control']

export function pickHeaders(headers) {
  const out = {}
  for (const h of RECEIPT_HEADERS) if (headers?.[h] !== undefined) out[h] = String(headers[h])
  return out
}

/** Cut a UTF-8 string to at most `max` bytes without splitting a code point. */
export function cutUtf8(text, max) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return { text, bytes: buf.length, truncated: false }
  let end = max
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8'), bytes: end, truncated: true }
}

/** What the bytes are, for the canonicalization step: markdown skips extraction. */
export function formatOf(contentType, url) {
  const ct = String(contentType ?? '').toLowerCase()
  if (ct.startsWith('text/markdown') || ct.startsWith('text/x-markdown')) return 'markdown'
  if (ct.startsWith('text/html') || ct.startsWith('application/xhtml')) return 'html'
  if (!ct && /\.md(\?|#|$)/i.test(url)) return 'markdown'
  if (!ct) return 'html'
  // Plain text, JSON and the rest: no extraction, normalized and hashed as-is.
  return 'markdown'
}

const common = (o) => ({
  via: 'anyone',
  mode: o.mode,
  url: o.url,
  final_url: o.finalUrl ?? o.url,
  method: o.method,
  status: o.status,
  headers: pickHeaders(o.headers),
  bytes: o.body.length,
  raw_hash: rawHash(o.body),
  fetched_at: new Date(o.fetchedAt).toISOString(),
  elapsed_ms: o.elapsedMs,
  job_id: o.jobId,
})

/** @param o {{url, finalUrl?, method, status, headers, body: Buffer, fetchedAt, elapsedMs, jobId, maxBodyBytes}} */
export function rawReceipt(o) {
  const truncated = o.body.length > o.maxBodyBytes
  const slice = truncated ? o.body.subarray(0, o.maxBodyBytes) : o.body
  return { ...common({ ...o, mode: 'raw' }), returned_bytes: slice.length, truncated, max_body_bytes: o.maxBodyBytes, body_b64: slice.toString('base64') }
}

/** Same input; the body goes through wuzzy/crawl v1 and comes back as markdown plus its content hash. */
export function extractReceipt(o) {
  const format = formatOf(o.headers?.['content-type'], o.finalUrl ?? o.url)
  const canon = canonicalize({ source: o.body, url: o.finalUrl ?? o.url, format })
  const base = { ...common({ ...o, mode: 'extract' }), protocol: PROTOCOL, protocol_version: PROTOCOL_VERSION, format, max_body_bytes: o.maxBodyBytes }
  if (canon.skipped) return { ...base, thin: true, title: null, content: '', content_bytes: 0, returned_bytes: 0, truncated: false, content_hash: null }
  const cut = cutUtf8(canon.markdown, o.maxBodyBytes)
  return {
    ...base,
    thin: false,
    title: canon.title,
    content: cut.text,
    content_bytes: Buffer.byteLength(canon.markdown, 'utf8'),
    returned_bytes: cut.bytes,
    truncated: cut.truncated,
    // Over the whole canonical markdown, cut or not: the hash a verifier reproduces from its own fetch.
    content_hash: canon.contentHash,
  }
}
