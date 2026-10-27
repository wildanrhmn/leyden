# Mainnet runs

Every swap below ran on Zcash mainnet and Bitcoin Lightning mainnet, through the
gateway in this repository. Amounts are deliberately small. The project was called
Shieldbolt when these ran, which is why that name appears in the memos below.

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

## 2. Lightning → ZEC (2026-10-26)

A Lightning wallet pays 500 sats; the recipient gets shielded ZEC with an encrypted memo.

| Step | Evidence |
|---|---|
| Quote | 500 sats → 0.00017883 ZEC (after the 1% fee and the Zcash network fee) |
| Lightning payer pays the gateway's invoice | Spark send request `TRANSFER_COMPLETED` |
| Gateway sends shielded ZEC, 16 s after the invoice was paid | Zcash tx `91601ee802b41b36046aabc4d3814b00eb386931c6830aef07a22d2cbadc2c8f`, mined at 3,530,999 |
| Recipient wallet | Ironwood output 0.00017883 ZEC, memo `first Lightning -> shielded ZEC on mainnet — via Shieldbolt ⚡` |

Together with run 1 this is a full round trip: shielded ZEC → Lightning → shielded ZEC,
with no transparent address and no on-chain Bitcoin transaction at any point.

## 3. Production deployment (https://43-134-116-188.sslip.io)

| Run | Evidence |
|---|---|
| ZEC → Lightning, 1,500 sats | Zcash tx `d23d08c04902193c0d34640296d58e4954923d51df71e555a52fc89de10c62e4`; preimage `fd108747d87ca637678be2b00acd56d3385a7ffd9c628c4f71aa6be5c7242e59`; ~40 s from broadcast to preimage |
| Lightning address `demo@43-134-116-188.sslip.io`, 600 sats with a comment | LNURL-pay invoice `description_hash` = `sha256(metadata)` = `00f801e8…9555ce`; payout Zcash tx `f2686336e1035405c777722f308cd573fa576a952517f9a66b740bbb6158b465`, mined at 3,531,010 |
| Payer's comment, as received | Encrypted memo in the recipient's wallet: `zap from a Lightning wallet, landing shielded — via Shieldbolt ⚡` |

## 4. Through the restyled app (2026-10-26)

| Run | Evidence |
|---|---|
| Lightning → ZEC, 600 sats with a memo, created in the new `/app/` | Paid from a separate Spark wallet; payout Zcash tx `8cb94b4618c1159b1656b1cbe0d50b5b2f955e96c1a5d4fcf95a66256da13462` for 0.00023753 ZEC |

## 5. Refund: an underpaid swap (2026-10-26, https://leydenpay.xyz)

A ZEC → Lightning quote for a 1,000-sat invoice, deliberately paid short.

| Step | Evidence |
|---|---|
| Quote, created in the live app | 1,000 sats for 0.00065599 ZEC, swap `9cf3d93e…` |
| Customer sends only 0.0003 ZEC | Zcash tx `07c245e0fbd48380e88a08d1462c17cb2f6a46095972f216b6edb4327b2a57d1` |
| Gateway detects the shortfall, does not pay the invoice | state `refunding`: "underpaid: received 30000 zat, quote was 65599 zat" |
| Refund, 24 s later | Zcash tx `d0ee5ca35bbda1e0f14493c98b238b26c69e378d0377d8fb38d4cba511dcf9ed`, mined at 3,531,392: 0.00015 ZEC (what arrived, minus the 0.00015 ZEC network fee), memo `Leyden refund, swap 9cf3d93e` |

## 6. Lightning → ZEC with a hold invoice (2026-10-26, https://leydenpay.xyz)

The payer's sats are held, not taken, until the shielded ZEC has been sent.

| Step | Evidence |
|---|---|
| Quote | 500 sats → 0.00016837 ZEC, swap `99f96476…`; the invoice is a hold invoice for a payment hash only the gateway knows |
| Payment arrives and is held (16:14:54 UTC) | the payer's send stays `LIGHTNING_PAYMENT_INITIATED`; the gateway sees a held transfer |
| Gateway sends the ZEC first (16:15:03) | Zcash tx `bae01061fac67226cb2196d9170a944b1d147f864f6de724d6239bd135b93a55` |
| Gateway reveals the preimage and takes the held payment (16:15:07) | the payer's send turns `TRANSFER_COMPLETED` with preimage `9d8f6bde…0da382`; `sha256(preimage)` = the invoice's payment hash `ee8c91be…122eb7` |

## 7. Both directions from a phone (2026-10-27, https://leydenpay.xyz)

The demo video's swaps, made with two ordinary phone wallets: Wallet of Satoshi for
Lightning and Zodl (formerly Zashi) for shielded ZEC. The phone's screen recording is in
the video.

| Step | Evidence |
|---|---|
| Get paid: quote | 1,000 sats → 0.00046087 ZEC to the Zodl wallet, memo "Logo design", swap `abb4b354…` |
| Wallet of Satoshi pays the hold invoice (17:41:29 UTC) | the wallet shows "₿1,000 on the way" for about 20 s while the payment is held |
| Gateway sends the ZEC first, then takes the payment (17:41:50) | Zcash tx `a072a55ddea38570868e00b3d754ba1fc15fe78af7729417ed04665c8c5ef64a`; the wallet then shows "Payment Sent" |
| Pay: quote for a 400-sat Wallet of Satoshi invoice | 0.00025359 ZEC to a one-time address, swap `146b5a8f…` |
| Zodl sends the quoted amount | Zcash tx `d9d011c40960570dd860b2e1c73c3c03f64d3ec9aaa37122ae1a44e2596b8947` |
| Gateway pays the invoice once the deposit is mined | preimage `170c2fd758ced960c2f5c8b3c6a4b51f59a4e9ec7024fbc3f6f9c7b18c0711ae`; the 400 sats arrive in Wallet of Satoshi |

## Funding (for reference)

The gateway and test wallets were funded from ~$12 of ETH on Base through NEAR Intents:

- ETH → shielded ZEC, paid by NEAR straight to an Orchard-only unified address; it landed
  in the Ironwood pool (Zcash tx `3a1bc25994587eced601d5a49c35943b5cfe853e89f8ec02c2402e5c64f1371b`).
- ETH → BTC to the Spark wallet's static deposit address (Bitcoin tx
  `edf1677350c84ca55b8152828be740b4a7977ec6cab728a7bbea88e6cc774724`), claimed as 7,923 sats.
