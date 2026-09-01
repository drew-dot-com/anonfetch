# anonfetch

A paid, anonymous HTTP fetch behind a TOON node.

An agent pays one ILP packet to a TOON node. The node fetches the URL over the
[Anyone network](https://anyone.io) and returns the response. The destination
sees an Anyone exit, never the node's IP. The node sees a channel key, never a
person. This is Anyone's "charge for exits" idea with TOON as the payment rail,
built without touching the connector.

**Want to run it against the live node? [DEMO.md](DEMO.md).**

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

Receipt (base64 JSON in `data`, also in `result`):

```json
{ "via": "anyone", "url": "...", "method": "GET", "status": 200,
  "headers": { "content-type": "...", "content-length": "..." },
  "bytes": 176952, "returned_bytes": 24576, "truncated": true,
  "max_body_bytes": 24576, "body_b64": "...", "elapsed_ms": 238, "job_id": "..." }
```

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
const event = buildJobEvent({ kind: 5301, params: { url, method: 'GET' } })
const answer = await sendJob({ client, destination: 'g.drew.anon', timeoutMs: 60_000 }, event)
```

## Gotcha

`Process.start()` in the Anyone library refuses to start if `ps aux | grep anon`
matches anything in the container, including your own script's argv. Keep the
word out of the entrypoint's command line (this image uses `node server.mjs`).
