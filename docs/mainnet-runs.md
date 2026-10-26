# Mainnet runs

Every swap below ran on Zcash mainnet and Bitcoin Lightning mainnet, through the
gateway in this repository. Amounts are deliberately small.

## 1. ZEC → Lightning (2026-10-26)

A 1,000-sat Lightning invoice, paid from shielded ZEC.

| Step | Evidence |
|---|---|
| Quote | 1,000 sats for 0.00067778 ZEC, to a one-time Orchard-only address |
| Customer pays (shielded → shielded, Ironwood) | Zcash tx `0c54e2b885e9faa475d89030a7f5e28f22ab7f534d2e57e629e82cf98249a004` |
| Gateway detects the payment from compact blocks, then pays the invoice over Lightning | ~75 s after broadcast |
| Lightning preimage | `2f507d7a6f6a4e8a1b335536695da5e6a9a9a6401dc5497f9be01f7d3e8a7c06` |
| Check | `sha256(preimage) = ccb958e4…76225ab` = the invoice's payment hash |

On the Zcash chain, the payment is one shielded transaction: no transparent input or
output, no visible amount, no visible recipient. On Bitcoin, nothing was written to the chain.

## Funding (for reference)

The gateway and test wallets were funded from ~$12 of ETH on Base through NEAR Intents:

- ETH → shielded ZEC, paid by NEAR straight to an Orchard-only unified address; it landed
  in the Ironwood pool (Zcash tx `3a1bc25994587eced601d5a49c35943b5cfe853e89f8ec02c2402e5c64f1371b`).
- ETH → BTC to the Spark wallet's static deposit address (Bitcoin tx
  `edf1677350c84ca55b8152828be740b4a7977ec6cab728a7bbea88e6cc774724`), claimed as 7,923 sats.
