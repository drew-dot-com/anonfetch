import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, JsonFileChannelStore } from '@toon-protocol/client'
import { clientConfig } from '../client-config.mjs'

const base = () => ({
  edge: 'https://connector.example',
  secret: randomBytes(32), // a throwaway seed: resolved, never used to sign
  rpc: 'https://rpc.example',
  store: join(mkdtempSync(join(tmpdir(), 'payer-store-')), 'channels.json'),
  deposit: 500000n,
})

test('the sidecar config resolves under @toon-protocol/client 4.x', () => {
  const o = base()
  const r = resolveConfig(clientConfig(o))
  assert.equal(r.connector, 'https://connector.example')
  assert.equal(r.chain, 'solana')
  assert.equal(r.transport, 'http')
  assert.equal(r.rpcUrls.solana, 'https://rpc.example')
  assert.equal(r.deposit, 500000n)
  assert.equal(r.autoOpenChannel, true)
  assert.ok(r.identity.solana, 'pays from the Solana key')
  assert.equal(r.identity.evm, undefined, 'holds no EVM key')
})

test('the channel store is a durable file, never memory', () => {
  const r = resolveConfig(clientConfig(base()))
  assert.equal(r.channelStoreIsEphemeral, false)
  assert.ok(r.channelStore instanceof JsonFileChannelStore)
})

test('no 3.x toon-channel options survive', () => {
  const c = clientConfig(base())
  for (const k of ['batchSettlement', 'settlementTimeout', 'evmPrivateKey']) assert.equal(k in c, false, k)
})
