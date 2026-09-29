// Pay a TOON node for one anonymous fetch over the Anyone network.
//
//   node fetch.mjs <url> [GET|HEAD] [raw|extract]
//
// `extract` (2026-09-28) answers with the page as markdown under wuzzy/crawl v1
// plus its content hash, instead of the raw body. Payment is an x402
// batch-settlement voucher (@toon-protocol/client 4.x, connector ADR 0075);
// the node refuses the older toon-channel claims.
//
// Env (all optional):
//   TOON_EDGE        the node's client edge, default Drew's node
//   TOON_DESTINATION the route, default g.drew.anon
//   SOLANA_KEYPAIR   path to a Solana keypair JSON (solana-keygen format),
//                    default ~/.config/solana/id.json. Mainnet, holding USDC
//                    in its token account for the channel deposit. No SOL is
//                    needed to open: the connector sponsors the open.
//   SOLANA_RPC       default https://api.mainnet-beta.solana.com
//
// First run opens an x402 batch-settlement channel to the node: the client
// signs the payment-channels open and the connector co-signs, submits and pays
// for it, with USDC deposited into the channel. Every run after that is a
// signed off-chain voucher for the running total: no tx, ~1 s round trip.
// Channel state lives in ./channels.json (and ./channels.peers.json, the
// channel's config) next to this file. Keep both: without the config the
// channel cannot be found again or left, and its deposit stays locked.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToonClient, buildJobEvent, sendJob } from '@toon-protocol/client'

const url = process.argv[2]
if (!url) {
  console.error('usage: node fetch.mjs <url> [GET|HEAD] [raw|extract]')
  process.exit(2)
}
const method = (process.argv[3] ?? 'GET').toUpperCase()
const mode = (process.argv[4] ?? 'raw').toLowerCase()
const EDGE = process.env.TOON_EDGE ?? 'https://connector.167-233-221-236.sslip.io'
const DEST = process.env.TOON_DESTINATION ?? 'g.drew.anon'
const keyPath = process.env.SOLANA_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json')
const rpcUrl = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'
const storePath = new URL('./channels.json', import.meta.url).pathname

const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8')))
const client = await ToonClient.create({
  connector: EDGE,
  solanaSecretKey: secret,
  chain: 'solana',
  rpcUrl,
  transport: 'http',
  channelStore: storePath,
  autoOpenChannel: true,
})
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)

const event = buildJobEvent({ kind: 5301, params: { url, method, mode } })
const t0 = Date.now()
const answer = await sendJob({ client, destination: DEST, timeoutMs: 60_000 }, event)
console.error(`round trip ${Date.now() - t0} ms`)

if (!answer.accepted) {
  console.error(j(answer))
  await client.close?.()
  process.exit(1)
}
const { body_b64, content, ...receipt } = answer.receipt
console.error(j(receipt))
process.stdout.write(mode === 'extract' ? content ?? '' : Buffer.from(body_b64 ?? '', 'base64'))
const ch = await client.channel.current().catch(() => undefined)
if (ch) console.error('channel:', j({ id: ch.channel.channelId, deposit: ch.depositTotal, signed: ch.signed }))
await client.close?.()
