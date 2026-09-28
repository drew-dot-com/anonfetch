// anonfetch: a paid, anonymous HTTP fetch behind a TOON node.
//
// The connector terminates a [[routes]] entry (g.drew.anon) at POST /fetch on
// this service, exactly the way it fronts the store's POST /store: payment is
// already verified by the time a request lands here, and the three
// connector-stated headers (X-TOON-Payer / X-TOON-Amount / X-TOON-Chain,
// ADR 0040) say who paid and how much. This service holds NO payment logic.
//
// The job is a NIP-90 event, kind 5301 (chosen outside the org's 5094-5098
// block): `param url`, optional `param method` (GET | HEAD). The fetch leaves
// through the Anyone network via the anon client this same container runs, so
// the destination sees an Anyone exit, never this node's IP, and the payer's
// identity is a channel key, never an IP. The receipt is the same
// base64(JSON) `data` shape the store answers with, so `sendJob` decodes it.
//
// 2026-09-28: `param mode` (raw | extract). `extract` runs the page through
// wuzzy/crawl v1 (Readability + Turndown + a pinned normalization, see
// canonicalize.mjs) and answers with markdown and the content hash that
// procedure yields, so a page that does not fit the 24 KiB body cap as HTML
// mostly does as markdown, and the hash is one a third party can reproduce.
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { verifyEvent } from 'nostr-tools/pure'
import { MODES, rawReceipt, extractReceipt } from './receipt.mjs'

const require = createRequire(import.meta.url)
const { Process, Socks } = require('@anyone-protocol/anyone-client')

const PORT = Number(process.env.PORT ?? 3500)
const SOCKS_PORT = Number(process.env.ANON_SOCKS_PORT ?? 9050)
const CONTROL_PORT = Number(process.env.ANON_CONTROL_PORT ?? 9051)
const JOB_KIND = Number(process.env.JOB_KIND ?? 5301)
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 24576)
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 25000)
const MAX_REQUEST_BYTES = 256 * 1024
const DEV_MODE = process.env.DEV_MODE === 'true'
const IP_CHECK_URL = process.env.IP_CHECK_URL ?? 'https://api.ipify.org?format=json'
const ALLOWED_METHODS = new Set(['GET', 'HEAD'])

const log = (...a) => console.log('[anonfetch]', ...a)

// ── Anyone client ───────────────────────────────────────────────────────────
const anon = new Process({ displayLog: false, autoTermsAgreement: true, socksPort: SOCKS_PORT, controlPort: CONTROL_PORT })
let bootstrapped = false
let bootMs = null
let exitIpAtBoot = null
let socks = null

async function startAnon() {
  const t0 = Date.now()
  await anon.start()
  bootMs = Date.now() - t0
  socks = new Socks(anon)
  bootstrapped = true
  log(`anon bootstrapped in ${bootMs} ms, socks 127.0.0.1:${SOCKS_PORT}`)
  try {
    const r = await socks.get(IP_CHECK_URL, { timeout: FETCH_TIMEOUT_MS })
    exitIpAtBoot = r.data?.ip ?? String(r.data)
    log(`exit seen by ${new URL(IP_CHECK_URL).host} at boot: ${exitIpAtBoot}`)
  } catch (e) {
    log(`exit check at boot failed: ${e.message}`)
  }
}

// ── Request validation ──────────────────────────────────────────────────────
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase()
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:')
  }
  return false
}

function validateTarget(raw) {
  let u
  try { u = new URL(raw) } catch { return { err: 'url is not a valid absolute URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { err: 'url must be http or https' }
  if (u.username || u.password) return { err: 'url must not carry credentials' }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { err: 'url host is not routable' }
  if (net.isIP(host) && isPrivateIp(host)) return { err: 'url host is a private address' }
  return { url: u.toString() }
}

function paramOf(event, key) {
  for (const t of event.tags ?? []) if (t[0] === 'param' && t[1] === key) return t[2]
  return undefined
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > MAX_REQUEST_BYTES) { reject(new Error('request body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('body is not JSON')) }
    })
    req.on('error', reject)
  })
}

const send = (res, status, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
const refuse = (res, status, code, message) => send(res, status, { accept: false, code, message })

// ── The job ─────────────────────────────────────────────────────────────────
async function handleFetch(req, res) {
  const payer = req.headers['x-toon-payer']
  const amount = req.headers['x-toon-amount']
  const chain = req.headers['x-toon-chain']

  let body
  try { body = await readJson(req) } catch (e) { return refuse(res, 422, 'F00', e.message) }
  const event = body?.event
  if (!event || typeof event !== 'object') return refuse(res, 422, 'F00', 'Missing required field: event')
  if (!DEV_MODE && !verifyEvent(event)) return refuse(res, 422, 'F00', 'Invalid event signature')
  if (event.kind !== JOB_KIND) return refuse(res, 422, 'F00', `Unsupported kind ${event.kind}; this app serves kind ${JOB_KIND}`)

  const rawUrl = paramOf(event, 'url')
  if (!rawUrl) return refuse(res, 422, 'F00', 'Missing required param: url')
  const method = (paramOf(event, 'method') ?? 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) return refuse(res, 422, 'F00', `method must be one of ${[...ALLOWED_METHODS].join(', ')}`)
  const target = validateTarget(rawUrl)
  if (target.err) return refuse(res, 422, 'F00', target.err)
  const mode = (paramOf(event, 'mode') ?? 'raw').toLowerCase()
  if (!MODES.has(mode)) return refuse(res, 422, 'F00', `mode must be one of ${[...MODES].join(', ')}`)
  if (mode === 'extract' && method !== 'GET') return refuse(res, 422, 'F00', 'mode extract needs method GET')

  if (!bootstrapped || !anon.isRunning()) return refuse(res, 502, 'T00', 'Anyone client is not bootstrapped')

  const t0 = Date.now()
  let r
  try {
    r = await socks.axios.request({
      method,
      url: target.url,
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 3,
      maxContentLength: 4 * 1024 * 1024,
      validateStatus: () => true,
      decompress: true,
      headers: { 'user-agent': 'anonfetch/0.1 (TOON paid fetch over Anyone)', accept: '*/*' },
    })
  } catch (e) {
    const ms = Date.now() - t0
    log(`kind=${event.kind} id=${event.id} payer=${payer ?? '-'} amount=${amount ?? '-'} chain=${chain ?? '-'} ${method} ${target.url} -> ERROR ${e.code ?? ''} ${e.message} ms=${ms}`)
    return refuse(res, 502, 'T00', `fetch over Anyone failed: ${e.code ?? ''} ${e.message}`.trim())
  }
  const ms = Date.now() - t0
  const full = Buffer.from(r.data ?? Buffer.alloc(0))
  const input = {
    url: target.url,
    finalUrl: r.request?.res?.responseUrl ?? target.url,
    method,
    status: r.status,
    headers: r.headers ?? {},
    body: full,
    fetchedAt: t0,
    elapsedMs: ms,
    jobId: event.id,
    maxBodyBytes: MAX_BODY_BYTES,
  }
  let receipt
  try {
    receipt = mode === 'extract' ? extractReceipt(input) : rawReceipt(input)
  } catch (e) {
    log(`kind=${event.kind} id=${event.id} ${mode} ${target.url} -> canonicalize failed: ${e.message}`)
    return refuse(res, 502, 'T00', `extract failed: ${e.message}`)
  }
  const truncated = receipt.truncated
  log(`kind=${event.kind} id=${event.id} payer=${payer ?? '-'} amount=${amount ?? '-'} chain=${chain ?? '-'} ${mode} ${method} ${target.url} -> ${r.status} bytes=${full.length}${mode === 'extract' ? ` md=${receipt.content_bytes} hash=${receipt.content_hash ?? 'thin'}` : ''}${truncated ? ' (truncated)' : ''} ms=${ms}`)
  const data = Buffer.from(JSON.stringify(receipt)).toString('base64')
  return send(res, 200, { accept: true, data, result: receipt, payer, amount, chain })
}

// ── HTTP surface ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, bootstrapped ? 200 : 503, {
        ok: bootstrapped && anon.isRunning(),
        bootstrapped,
        anon_running: anon.isRunning(),
        boot_ms: bootMs,
        exit_ip_at_boot: exitIpAtBoot,
        kind: JOB_KIND,
        max_body_bytes: MAX_BODY_BYTES,
        fetch_timeout_ms: FETCH_TIMEOUT_MS,
        modes: [...MODES],
      })
    }
    if (req.method === 'POST' && req.url === '/fetch') return await handleFetch(req, res)
    return refuse(res, 404, 'F00', 'not found')
  } catch (e) {
    log('unhandled', e)
    if (!res.headersSent) return refuse(res, 500, 'T00', e.message)
  }
})

server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT} (POST /fetch, GET /health), job kind ${JOB_KIND}`))

startAnon().catch((e) => {
  log('anon failed to start:', e.message)
  process.exit(1)
})

const shutdown = async () => { log('stopping'); server.close(); await anon.stop().catch(() => {}); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
