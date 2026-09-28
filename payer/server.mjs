// anonfetch payer: a local sidecar that pays a TOON node per fetch.
//
// An agent runtime (Hermes, or anything that can GET a localhost URL) asks
//   GET /extract?url=<absolute url>
// and gets the page back as markdown with its content hash (wuzzy/crawl v1),
// fetched by the node over the Anyone network. Each answer cost one ILP
// packet: this process holds the payment channel, signs the cumulative claim,
// and enforces a daily cap, a per-fetch price ceiling and an origin allowlist
// BEFORE a packet is built. Nothing here runs unless a URL is asked for; the
// only money that can move is what the cap allows.
//
// The HTTP contract (paths, query, JSON keys) is the seam a future native
// payer keeps: a plugin talks to this shape, not to the TOON client.
//
// Env:
//   PAYER_PORT              default 3502          PAYER_BIND   default 127.0.0.1
//   TOON_EDGE               the node's client edge, default Drew's node
//   TOON_DESTINATION        the fetch route, default g.drew.anon
//   SOLANA_KEYPAIR          keypair JSON path (solana-keygen format), default ~/.config/solana/id.json
//   SOLANA_KEYPAIR_JSON     the 64-byte array inline, for a container that mounts no file
//   SOLANA_RPC              default https://api.mainnet-beta.solana.com
//   PAYER_HOME              channel store + budget ledger, default ~/.anonfetch-payer
//   PAYER_CHANNEL_STORE     the channel store file itself, default <PAYER_HOME>/channel-store.json
//   PAYER_CHANNEL_DEPOSIT   base units locked when a channel is opened, default 500000 (0.50 USDC)
//   PAYER_DAILY_CAP         base units per UTC day, default 100000 (0.10 USDC = 100 fetches at 1000)
//   PAYER_MAX_PRICE         refuse a route priced above this per fetch, default 5000
//   PAYER_ALLOWED_ORIGINS   comma-separated origins; EMPTY MEANS ANY ORIGIN (disclosed in README)
//   PAYER_JOB_TIMEOUT_MS    default 60000
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ToonClient, buildJobEvent, sendJob, chargeFor } from '@toon-protocol/client'
import { Budget } from './budget.mjs'

const env = (k, d) => process.env[k] ?? d
const PORT = Number(env('PAYER_PORT', 3502))
const BIND = env('PAYER_BIND', '127.0.0.1')
const EDGE = env('TOON_EDGE', 'https://connector.167-233-221-236.sslip.io')
const DEST = env('TOON_DESTINATION', 'g.drew.anon')
const HOME = env('PAYER_HOME', path.join(os.homedir(), '.anonfetch-payer'))
const RPC = env('SOLANA_RPC', 'https://api.mainnet-beta.solana.com')
const DEPOSIT = BigInt(env('PAYER_CHANNEL_DEPOSIT', '500000'))
const JOB_TIMEOUT_MS = Number(env('PAYER_JOB_TIMEOUT_MS', 60000))
const JOB_KIND = 5301
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

const log = (...a) => console.log('[payer]', new Date().toISOString(), ...a)

const budget = new Budget({
  file: path.join(HOME, 'budget.json'),
  dailyCap: BigInt(env('PAYER_DAILY_CAP', '100000')),
  maxPrice: BigInt(env('PAYER_MAX_PRICE', '5000')),
  allowedOrigins: env('PAYER_ALLOWED_ORIGINS', '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
})

// ── The channel: one ToonClient, opened on first use ────────────────────────
let clientP = null
function client() {
  if (!clientP) {
    fs.mkdirSync(HOME, { recursive: true })
    const secret = process.env.SOLANA_KEYPAIR_JSON
      ? Uint8Array.from(JSON.parse(process.env.SOLANA_KEYPAIR_JSON))
      : Uint8Array.from(JSON.parse(fs.readFileSync(env('SOLANA_KEYPAIR', path.join(os.homedir(), '.config/solana/id.json')), 'utf8')))
    clientP = ToonClient.create({
      connector: EDGE,
      solanaSecretKey: secret,
      evmPrivateKey: '0x' + crypto.randomBytes(32).toString('hex'), // unused; the SDK wants one
      chain: 'solana',
      rpcUrl: RPC,
      transport: 'http',
      channelStore: env('PAYER_CHANNEL_STORE', path.join(HOME, 'channel-store.json')),
      autoOpenChannel: true,
      deposit: DEPOSIT,
    }).catch((e) => { clientP = null; throw e })
  }
  return clientP
}

let termsCache = null
async function routeTerms() {
  if (termsCache && Date.now() - termsCache.at < 60_000) return termsCache.terms
  const c = await client()
  const terms = await c.routePrice(DEST).catch(() => null)
  termsCache = { at: Date.now(), terms }
  return terms
}

/** What the route will charge for this event: the ADR 0065 schedule over the payload, or the flat price. */
async function priceFor(event) {
  const terms = await routeTerms()
  if (!terms) throw Object.assign(new Error(`route ${DEST} is not priced at ${EDGE}`), { code: 'route_unpriced' })
  try { return chargeFor(terms, Buffer.byteLength(JSON.stringify({ event }))) } catch { return (await client()).price(DEST) }
}

// One channel, cumulative claims: jobs go one at a time.
let chain = Promise.resolve()
const serialize = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p }

class Refusal extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra } }

/** Pay for one job and return its receipt plus what it cost. */
async function paidJob(url, method, mode) {
  const origin = budget.originCheck(url)
  if (origin) throw new Refusal(403, origin.code, origin.error)
  const event = buildJobEvent({ kind: JOB_KIND, params: { url, method, mode } })
  const price = await priceFor(event)
  const p = budget.priceCheck(price)
  if (p) throw new Refusal(402, p.code, p.error)
  const t0 = Date.now()
  const c = await client()
  const answer = await sendJob({ client: c, destination: DEST, timeoutMs: JOB_TIMEOUT_MS }, event)
  if (!answer.accepted) throw new Refusal(502, 'node_refused', `${answer.code} ${answer.message}`, { ilp_code: answer.code })
  budget.record(price)
  log(`${mode} ${method} ${url} -> ${answer.receipt.status} price=${price} ms=${Date.now() - t0} spent_today=${budget.view().spent}`)
  return { receipt: answer.receipt, price }
}

// ── HTTP surface ────────────────────────────────────────────────────────────
const send = (res, status, obj) => {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
const refuse = (res, status, code, error, extra = {}) => send(res, status, { ok: false, code, error, ...extra })

function targetOf(q) {
  const raw = q.get('url')
  if (!raw) throw new Refusal(400, 'bad_url', 'url query parameter is required')
  let u
  try { u = new URL(raw) } catch { throw new Refusal(400, 'bad_url', 'url is not an absolute URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Refusal(400, 'bad_url', 'url must be http or https')
  return u.toString()
}

const price = (units) => ({ units: units.toString(), asset: 'USDC', decimals: 6, chain: 'solana' })
const node = () => ({ edge: EDGE, destination: DEST })

async function handle(req, res) {
  const u = new URL(req.url, 'http://x')
  if (req.method !== 'GET') return refuse(res, 405, 'method', 'GET only')

  if (u.pathname === '/health') {
    const terms = await routeTerms().catch(() => null)
    return send(res, 200, { ok: true, version: VERSION, node: node(), route_priced: !!terms, route_terms: terms, budget: budget.view() })
  }
  if (u.pathname === '/budget') return send(res, 200, { ok: true, budget: budget.view() })

  if (u.pathname === '/extract') {
    const url = targetOf(u.searchParams)
    const { receipt: r, price: paid } = await serialize(() => paidJob(url, 'GET', 'extract'))
    return send(res, 200, {
      ok: true,
      url: r.url, final_url: r.final_url, status: r.status, headers: r.headers,
      title: r.title, content: r.content, content_hash: r.content_hash, raw_hash: r.raw_hash,
      protocol: r.protocol, protocol_version: r.protocol_version, format: r.format,
      thin: r.thin, truncated: r.truncated, content_bytes: r.content_bytes, returned_bytes: r.returned_bytes, bytes: r.bytes,
      exit: r.via, fetched_at: r.fetched_at, elapsed_ms: r.elapsed_ms, job_id: r.job_id,
      price: price(paid), node: node(), budget: budget.view(),
    })
  }
  if (u.pathname === '/fetch') {
    const url = targetOf(u.searchParams)
    const method = (u.searchParams.get('method') ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') throw new Refusal(400, 'bad_method', 'method must be GET or HEAD')
    const { receipt: r, price: paid } = await serialize(() => paidJob(url, method, 'raw'))
    return send(res, 200, { ok: true, ...r, exit: r.via, price: price(paid), node: node(), budget: budget.view() })
  }
  return refuse(res, 404, 'not_found', 'GET /extract?url=  GET /fetch?url=[&method=HEAD]  GET /health  GET /budget')
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof Refusal) return refuse(res, e.status, e.code, e.message, e.extra)
    log('error', e?.code ?? '', e?.message ?? e)
    if (!res.headersSent) refuse(res, 502, e?.code ?? 'error', String(e?.message ?? e))
  })
})

server.listen(PORT, BIND, () => log(`v${VERSION} listening on http://${BIND}:${PORT} paying ${DEST} at ${EDGE}; daily cap ${budget.dailyCap} units, max price ${budget.maxPrice}, origins ${budget.allowedOrigins.length ? budget.allowedOrigins.join(',') : 'ANY'}`))

const shutdown = async () => { log('stopping'); server.close(); try { await (await clientP)?.close?.() } catch {} ; process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
