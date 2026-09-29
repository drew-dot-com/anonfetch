# anonfetch

A paid, anonymous HTTP fetch behind a TOON node.

An agent pays one ILP packet to a TOON node. The node fetches the URL over the
[Anyone network](https://anyone.io) and returns the response. The destination
sees an Anyone exit, never the node's IP. The node sees a channel key, never a
person. This is Anyone's "charge for exits" idea with TOON as the payment rail,
built without touching the connector.

**Want to run it against the live node? [DEMO.md](DEMO.md).**
**Want an agent to pay for it without holding a channel? [payer/](payer/), and
the [hermes-toon](https://github.com/drew-dot-com/hermes-toon) plugin for Hermes Agent.**

## How it fits

```
agent  --ILP packet (kind 5301 job, paid)-->  TOON connector  --POST /fetch-->  anonfetch  --SOCKS 9050-->  anon client  --circuit-->  exit  -->  destination
```

The connector terminates a `[[routes]]` entry at `POST /fetch` and states the
verified payment in `X-TOON-Payer` / `X-TOON-Amount` / `X-TOON-Chain` (ADR 0040).
This service holds no payment logic. It runs the `anon` binary from
`@anyone-protocol/anyone-client` in the same container.

## Job

NIP-90 event, kind `5301`:

| tag | value |
| --- | --- |
| `param url` | absolute http(s) URL (private and loopback hosts refused) |
| `param method` | `GET` (default) or `HEAD` |
| `param mode` | `raw` (default) or `extract` (GET only) |

`raw` receipt (base64 JSON in `data`, also in `result`):

```json
{ "via": "anyone", "mode": "raw", "url": "...", "final_url": "...", "method": "GET", "status": 200,
  "headers": { "content-type": "...", "content-length": "..." },
  "bytes": 176952, "returned_bytes": 24576, "truncated": true, "max_body_bytes": 24576,
  "raw_hash": "<sha256 of the bytes>", "body_b64": "...",
  "fetched_at": "...", "elapsed_ms": 238, "job_id": "..." }
```

`extract` receipt: the page as markdown under
[wuzzy/crawl v1](https://github.com/memetic-block/wuzzy/blob/main/VERIFY.md)
(Readability, Turndown, a pinned normalization; `canonicalize.mjs` is a port
checked against Wuzzy's own conformance vectors in `test/fixtures`), with the
content hash that procedure yields. A 177 KB Wikipedia article is 23 KB of
markdown, so most pages fit the cap that raw HTML does not.

```json
{ "via": "anyone", "mode": "extract", "url": "...", "final_url": "...", "status": 200, "headers": { "...": "..." },
  "bytes": 177065, "raw_hash": "<sha256 of the bytes>",
  "protocol": "wuzzy/crawl-experimental", "protocol_version": 1, "format": "html",
  "title": "Onion routing - Wikipedia", "content": "## markdown ...",
  "content_bytes": 23022, "returned_bytes": 23022, "truncated": false, "max_body_bytes": 24576,
  "thin": false, "content_hash": "<sha256 of the whole canonical markdown>",
  "fetched_at": "...", "elapsed_ms": 292, "job_id": "..." }
```

`content_hash` always covers the whole document, cut or not, so it is the hash
an independent fetch of the same URL reproduces (when the origin serves the same
content: Wikipedia, for one, varies a notice image by the exit's region). A page
whose canonical markdown is under 80 characters is `thin: true` with no hash.

## Run

```bash
docker compose up -d --build
```

`GET /health` answers 503 until the Anyone client has bootstrapped, then reports
the exit IP it saw at boot. Env: `PORT` (3500), `JOB_KIND` (5301),
`MAX_BODY_BYTES` (24576), `FETCH_TIMEOUT_MS` (25000), `ANON_SOCKS_PORT` (9050).

Connector side, one route:

```toml
[[routes]]
prefix = "g.drew.anon"
handler_url = "http://anonfetch:3500/fetch"
price = 1000
```

Client side, with `@toon-protocol/client`:

```js
const event = buildJobEvent({ kind: 5301, params: { url, method: 'GET', mode: 'extract' } })
const answer = await sendJob({ client, destination: 'g.drew.anon', timeoutMs: 60_000 }, event)
```

The node accepts only x402 `batch-settlement` vouchers (connector ADR 0075), so
the client must be `@toon-protocol/client` 4.x; older clients' `toon-channel`
claims are refused. `npm test` checks the receipt shapes and the
canonicalization vectors without the Anyone client running.

## Paying for it from an agent

[payer/](payer/) is a local sidecar that holds one channel, a daily cap and an
origin allowlist and answers `GET /extract?url=` and `GET /fetch?url=` on
localhost, so a runtime that can GET a URL pays per fetch without embedding a
TOON client. [hermes-toon](https://github.com/drew-dot-com/hermes-toon) wires it
into Hermes Agent as the `toon` web-extract provider.

## Gotcha

`Process.start()` in the Anyone library refuses to start if `ps aux | grep anon`
matches anything in the container, including your own script's argv. Keep the
word out of the entrypoint's command line (this image uses `node server.mjs`).
