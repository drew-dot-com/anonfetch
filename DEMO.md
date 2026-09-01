# Try it: pay for one anonymous fetch

This runs against a live TOON node on Solana mainnet. One fetch costs
1000 base units of USDC, which is $0.001. The first run also opens a payment
channel to the node with 0.10 USDC of collateral, in one on-chain transaction.
Every run after that is an off-chain signed claim: no transaction, about one
second round trip.

## You need

- Node 22+
- A Solana mainnet keypair file in `solana-keygen` JSON format, holding
  about **0.5 USDC** and **0.01 SOL** (the SOL pays for the one channel-open tx)

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

Try a page and a HEAD:

```bash
node fetch.mjs 'https://en.wikipedia.org/wiki/Onion_routing' > page.html
node fetch.mjs 'https://www.anyone.io/' HEAD
```

Bodies are capped at 24 KiB (`truncated: true` tells you). The node runs the
stock `anon` client from `@anyone-protocol/anyone-client`; nothing about the
Anyone side is modified.

## What just happened

```
you  --ILP PREPARE, kind 5301 job, 1000 units-->  TOON connector  --POST /fetch-->  anonfetch  --SOCKS-->  anon  --circuit-->  exit  -->  destination
you  <--ILP FULFILL, receipt + body-----------------  connector  <--200 JSON-------  anonfetch  <----------------------------------------------
```

- The node verified your claim itself and told the app who paid, as a
  channel key, not an IP or a person. The destination saw an Anyone exit.
- The node's public self-description lists the route and its price:
  `https://connector.167-233-221-236.sslip.io/ilp`
- Your channel state is in `client/channel-store.json`. Keep it: it is the
  watermark of what you have signed. Deleting it and re-running opens a new
  channel.

## Point it somewhere else

`TOON_EDGE` and `TOON_DESTINATION` override the node and route, so the same
client works against any TOON node that serves this job kind. The server is
in the repo root: `docker compose up -d --build` runs the anon client and the
`POST /fetch` handler in one container, and one `[[routes]]` entry in the
connector config prices it. See [README.md](README.md).
