# anonfetch payer

A local sidecar that pays a TOON node per fetch, so an agent runtime that can
GET a localhost URL gets paid anonymous fetch without holding a payment channel
itself. Built for [hermes-toon](https://github.com/drew-dot-com/hermes-toon);
any client of the HTTP contract below works.

```
GET /extract?url=<absolute url>          the page as markdown + content hash (wuzzy/crawl v1)
GET /fetch?url=<absolute url>[&method=HEAD]   the raw body, base64, 24 KiB cap
GET /health                              node, route price, today's budget
GET /budget                              today's budget only
```

Every `/extract` and `/fetch` is one ILP packet carrying a signed x402
`batch-settlement` voucher for the channel's running total, paid to the node's
fetch route (`@toon-protocol/client` 4.x; the node refuses the older
`toon-channel` claims). The node fetches the
page over the Anyone network and answers inside the FULFILL.

> **Disclosure.** With this running, anything that can reach the port can spend
> from the channel with no per-call confirmation, up to `PAYER_DAILY_CAP` per
> UTC day and only for `PAYER_ALLOWED_ORIGINS` when that is set. It binds to
> `127.0.0.1` by default. Fund it with a small dedicated wallet.

## Run

```sh
npm install
SOLANA_KEYPAIR=/path/to/keypair.json node server.mjs
curl 'localhost:3502/extract?url=https://en.wikipedia.org/wiki/Onion_routing'
```

The keypair is a Solana mainnet wallet in `solana-keygen` JSON format holding
USDC in its token account for the channel deposit (`PAYER_CHANNEL_DEPOSIT`,
default 0.50, raised to the node's published `minDeposit` if lower). Opening
needs no SOL: on the first fetch the client signs a `payment-channels` open
and the connector co-signs it, submits it and pays the fee and rent. When the deposit
runs short, a fresh sponsored channel replaces the old one.

State lives in `PAYER_HOME` (default `~/.anonfetch-payer`):

- `channels.json` is the cumulative amount signed per channel, and
  `channels.peers.json` beside it is each channel's config. Keep both. There is
  no nonce: if the local figure and the node's disagree, the client asks the
  node's `POST /ilp/claim-state` and resumes from its answer. What cannot be
  rebuilt is the config, and without it the channel can be neither found nor
  left, so its deposit stays locked.
- `budget.json` is the ledger.

Leaving a channel (`client.channel.close()`, then `settle()` after the grace
period, with the same keypair and store) is the one step that costs SOL.

Docker: `docker build -t anonfetch-payer . && docker run -p 127.0.0.1:3502:3502 -v payer:/data -e SOLANA_KEYPAIR_JSON="$(cat keypair.json)" anonfetch-payer`.

## Options

| env | default | what |
| --- | --- | --- |
| `PAYER_PORT` / `PAYER_BIND` | `3502` / `127.0.0.1` | where to listen |
| `TOON_EDGE` | Drew's node | the connector's client edge |
| `TOON_DESTINATION` | `g.drew.anon` | the fetch route |
| `SOLANA_KEYPAIR` / `SOLANA_KEYPAIR_JSON` | `~/.config/solana/id.json` | the payer wallet |
| `SOLANA_RPC` | `https://api.mainnet-beta.solana.com` | |
| `PAYER_HOME` | `~/.anonfetch-payer` | channel store + ledger |
| `PAYER_CHANNEL_STORE` | `<PAYER_HOME>/channels.json` | reuse an existing 4.x store for the same wallet |
| `PAYER_CHANNEL_DEPOSIT` | `500000` (0.50 USDC) | collateral locked on open (never below the node's `minDeposit`) |
| `PAYER_DAILY_CAP` | `100000` (0.10 USDC) | spend ceiling per UTC day |
| `PAYER_MAX_PRICE` | `5000` | refuse a route priced above this per fetch |
| `PAYER_ALLOWED_ORIGINS` | empty = any | comma-separated origins, e.g. `https://docs.example,https://api.example` |
| `PAYER_JOB_TIMEOUT_MS` | `60000` | |

## Answers

`/extract` 200:

```json
{ "ok": true, "url": "...", "final_url": "...", "status": 200, "title": "...",
  "content": "## markdown ...", "content_hash": "<sha256>", "raw_hash": "<sha256>",
  "protocol": "wuzzy/crawl-experimental", "protocol_version": 1, "format": "html",
  "thin": false, "truncated": false, "content_bytes": 12345, "returned_bytes": 12345,
  "exit": "anyone", "fetched_at": "...", "elapsed_ms": 900, "job_id": "<event id>",
  "price": { "units": "1000", "asset": "USDC", "decimals": 6, "chain": "solana" },
  "node": { "edge": "...", "destination": "g.drew.anon" },
  "budget": { "day": "2026-09-28", "spent": "1000", "cap": "100000", "remaining": "99000", "count": 1 } }
```

Refusals are `{ "ok": false, "code": ..., "error": ... }`: `bad_url` (400),
`origin_not_allowed` (403), `budget_exhausted` and `price_too_high` (402, nothing
was sent), `node_refused` (502, with the ILP code; a refused packet costs
nothing), `route_unpriced` (502).

`content_hash` covers the whole canonical markdown even when `truncated` is
true, so it stays comparable with an independent fetch of the same URL.

## The contract is the seam

The move from `toon-channel` claims to x402 vouchers (client 4.x) kept these
paths and keys, and so will any later payer; a plugin written against them
does not change.
