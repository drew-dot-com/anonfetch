# Try it: pay for one anonymous fetch

This runs against a live TOON node on Solana mainnet. One fetch costs
1000 base units of USDC, which is $0.001. The first run also opens an x402
payment channel to the node with 0.10 USDC of collateral; the node sponsors
that open, so you pay no SOL for it. Every run after that is an off-chain
signed voucher: no transaction, about one second round trip.

## You need

- Node 22+ (the client is `@toon-protocol/client` 4.x; the node accepts only
  x402 `batch-settlement` vouchers and refuses older clients)
- A Solana mainnet keypair file in `solana-keygen` JSON format, holding
  about **0.5 USDC** in its USDC token account. No SOL is needed to open;
  SOL is only needed later, to leave the channel.

## Run

```bash
git clone https://github.com/drew-dot-com/anonfetch
cd anonfetch/client
npm install
SOLANA_KEYPAIR=/path/to/keypair.json node fetch.mjs 'https://api.ipify.org?format=json'
```

The body goes to stdout, the receipt to stderr. You should see an IP that is
not the node's (the node is `167.233.221.236`) and not yours: it is the Anyone
exit the node's circuit used.

```
round trip 810 ms
{
  "via": "anyone",
  "url": "https://api.ipify.org/?format=json",
  "status": 200,
  "bytes": 21,
  "truncated": false,
  "elapsed_ms": 209,
  ...
}
{"ip":"138.68.98.89"}
```

Try a page, a HEAD, and the page as markdown with its content hash:

```bash
node fetch.mjs 'https://en.wikipedia.org/wiki/Onion_routing' > page.html
node fetch.mjs 'https://www.anyone.io/' HEAD
node fetch.mjs 'https://en.wikipedia.org/wiki/Onion_routing' GET extract > page.md
```

Bodies are capped at 24 KiB (`truncated: true` tells you); `extract` mode
returns markdown, which usually fits where the HTML did not, plus
`content_hash` (wuzzy/crawl v1) and `raw_hash`. The node runs the
stock `anon` client from `@anyone-protocol/anyone-client`; nothing about the
Anyone side is modified.

## What just happened

```
you  --ILP PREPARE, kind 5301 job, 1000 units-->  TOON connector  --POST /fetch-->  anonfetch  --SOCKS-->  anon  --circuit-->  exit  -->  destination
you  <--ILP FULFILL, receipt + body-----------------  connector  <--200 JSON-------  anonfetch  <----------------------------------------------
```

- The node verified your voucher itself and told the app who paid, as a
  channel key, not an IP or a person. The destination saw an Anyone exit.
- The node's public self-description lists the route and its price:
  `https://connector.167-233-221-236.sslip.io/ilp`
- Your channel state is in `client/channels.json` (the running total you
  have signed) and `client/channels.peers.json` (the channel's config). Keep
  both. The total can be recovered from the node, but the config cannot:
  without it the channel cannot be found again or left, and re-running opens
  a new channel with a fresh deposit.

## Point it somewhere else

`TOON_EDGE` and `TOON_DESTINATION` override the node and route, so the same
client works against any TOON node that serves this job kind. The server is
in the repo root: `docker compose up -d --build` runs the anon client and the
`POST /fetch` handler in one container, and one `[[routes]]` entry in the
connector config prices it. See [README.md](README.md).
