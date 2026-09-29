// The ToonClient config the sidecar pays with, kept apart from server.mjs so a
// test can resolve it against the installed @toon-protocol/client without a
// network or a wallet.
//
// 4.x (connector ADR 0075): every payment is an x402 batch-settlement voucher.
// On Solana the connector sponsors the channel open, so the payer needs USDC
// in its token account and no SOL. Only a Solana key is supplied; the client
// holds no EVM identity and pays on no EVM chain.

/**
 * @param o {{ edge: string, secret: Uint8Array, rpc: string, store: string, deposit: bigint }}
 */
export function clientConfig({ edge, secret, rpc, store, deposit }) {
  return {
    connector: edge,
    solanaSecretKey: secret,
    chain: 'solana',
    rpcUrl: rpc,
    transport: 'http',
    // channels.json holds the cumulative total per channel; the sibling
    // channels.peers.json holds each channel's config. No nonce: a watermark
    // that drifts is recovered from the connector's POST /ilp/claim-state.
    channelStore: store,
    autoOpenChannel: true,
    deposit,
  }
}
