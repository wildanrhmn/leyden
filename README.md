# Leyden

**Pay any Lightning invoice from shielded ZEC. Receive Lightning payments as shielded ZEC.**

Named after the Leyden jar, the first device to hold lightning: a charge kept sealed in
glass and foil.

Live: **https://43-134-116-188.sslip.io** (Zcash mainnet, Bitcoin Lightning mainnet, small limits)

Leyden is a swap gateway between the Zcash shielded pool and the Bitcoin Lightning
Network. Neither leg touches a transparent address or a public Bitcoin transaction:

- **ZEC → Lightning.** Paste a Lightning invoice. Pay the quoted amount from any shielded
  wallet (Zodl, Zkool, zcash-devtool…) to a one-time shielded address. The gateway pays the
  invoice and shows you the Lightning preimage, which is cryptographic proof of payment.
- **Lightning → ZEC.** Enter your shielded address and an amount. Pay the Lightning invoice
  from any Lightning wallet; shielded ZEC arrives with an encrypted memo.
- **Lightning addresses.** Claim `you@<gateway>`. Anyone with a Lightning wallet can pay it,
  and the money lands in your shielded address. The payer's comment arrives as an encrypted memo.

Why this matters: Lightning is accepted by far more merchants and wallets than shielded ZEC,
and existing ZEC↔BTC routes (exchanges, NEAR Intents, instant-swap services) take ZEC
deposits on transparent addresses or settle BTC on-chain, which publishes the amount and
links the two sides. Here, a chain observer sees one shielded Zcash transaction and nothing
at all on Bitcoin.

## It runs on mainnet

Every flow has been exercised on mainnet with real money. Transaction IDs, preimages and
hashes are in [docs/mainnet-runs.md](docs/mainnet-runs.md):

1. ZEC → Lightning: a 1,000-sat invoice paid from shielded ZEC; `sha256(preimage)` matches the invoice's payment hash.
2. Lightning → ZEC: 500 sats in, 0.00017883 ZEC out to an Ironwood note, with its memo.
3. Production deployment: ZEC → Lightning in ~40 s, and a Lightning-address payment whose comment arrived as an encrypted memo.

## Why it does not leak

| Party | Learns | Never learns |
|---|---|---|
| Zcash chain observers | That a shielded transaction happened | Sender, recipient, amount, memo, that Lightning was involved |
| Bitcoin chain observers | Nothing: Lightning payments are off-chain | Everything about the payment |
| Lightning routing nodes | The amount passing through them | Who paid and who was paid (onion routing) |
| The payee | That the gateway's node paid their invoice | The payer's Zcash address, wallet or balance |
| The lightwalletd server | That the gateway downloads every block | Which outputs are the gateway's |
| **The gateway** | The invoice it pays or issues, the ZEC amount, the refund or payout address, the visitor's IP (use Tor to hide it) | The user's other transactions or balance |

Design decisions behind that table:

- **One fresh shielded address per quote.** Each ZEC → Lightning quote gets its own
  Orchard-only diversified address (`zcash_keys` diversifier index 2³² + n). Payments are
  matched to quotes by diversifier, so the gateway needs no memo and no account. Two
  payments cannot be linked by address, even by someone who saw both quotes.
- **No transaction lookups.** The gateway syncs from compact blocks and trial-decrypts
  locally (`zcash_client_backend::sync`). It never calls `GetTransaction(txid)`, the request
  that tells a lightwalletd operator which transactions a wallet cares about.
- **Shielded only, enforced.** Refund and payout addresses must carry an Orchard or Sapling
  receiver; transparent and TEX addresses are refused. The gateway never pays in the clear.
- **Records are erased.** 24 hours after a swap finishes, every field that links the two
  legs is wiped: invoice, addresses, txids, preimage. What stays is amount, direction, state and time.
- **No logs, no third parties.** Caddy logs are discarded entirely (error logs included, since
  they contain IPs). The web app loads nothing from other origins: fonts and the QR library
  are self-hosted, and a strict Content-Security-Policy enforces it.
- **No transparent hop to fund it.** The operator funds and rebalances inventory outside the
  user flow, so user payments are never batched or forwarded through transparent addresses.

### Trust model and limits

This is a custodial-for-seconds swap, the same trust you give any instant-swap service or
NEAR Intents solver. The gateway holds the ZEC between "payment confirmed" and "invoice paid"
(or the sats between "invoice paid" and "ZEC sent"). To keep that exposure small:

- Amounts are capped (100–5,000 sats on the demo).
- Quotes are priced from the public NEAR Intents price feed, with a 1% fee.
- State is persisted before any payment is sent, so a crash can never pay twice.
  An unclear Lightning result is held for manual review, never auto-refunded.

Lightning cannot make this trustless today. A shielded Zcash note cannot be locked to a SHA-256
preimage, and point-time-locked contracts are not deployed on Lightning, so an atomic swap over
standard invoices isn't possible. The mitigation available today is that anyone can run their
own gateway: it is a single Rust binary and a small Node process.

The Lightning backend in the demo is a self-custodial [Spark](https://spark.money) wallet
(no channels, no liquidity purchase), which adds Spark's operator trust assumptions. The
gateway talks to it through a five-endpoint sidecar, so phoenixd or LND can be swapped in.

Other honest limits: incoming ZEC is acted on after 1 confirmation (75 s blocks today, 25 s
after NU7); invoices without an amount are not supported; the gateway sees the visitor's IP
unless they use Tor.

## What is real and what is a mock

Everything in the demo is real: mainnet Zcash, mainnet Lightning, real funds. Nothing is
mocked. The only test-only code is `lightning/customer-invoice.mjs`, a second independent
Lightning wallet used to play "some Lightning user" in the recorded runs.

## Architecture

```
   any shielded wallet                                       any Lightning wallet
          │  shielded tx (Ironwood)                                  ▲  │  Lightning
          ▼                                                          │  ▼
 ┌────────────────────────────────── leyden (Rust) ─────────────────────────────────┐
 │ wallet.rs   compact-block sync + trial decryption, per-quote Orchard addresses,  │
 │             shielded sends (zcash_client_backend / zcash_client_sqlite)           │
 │ engine.rs   quotes, pricing, state machine, refunds, 24 h erasure                 │
 │ api.rs      JSON API, LNURL-pay (Lightning addresses), static web app             │
 └───────────────┬───────────────────────────────────────────────┬──────────────────┘
                 │ gRPC (compact blocks, send)                    │ localhost HTTP
                 ▼                                                ▼
          lightwalletd (zec.rocks)                     lightning/server.mjs (Spark wallet)
```

Swap states: `awaiting_zec → paying_ln → complete` (or `refunding → refunded`) and
`awaiting_ln → paying_zec → complete`; quotes that are never paid end `expired`.

## Run your own

Requirements: Rust 1.89+, Node 22+.

```sh
# Lightning sidecar
cd lightning && npm ci
node init-wallet.mjs ~/.leyden/spark.mnemonic     # prints a BTC deposit address to fund it
LEYDEN_LN_TOKEN=$(openssl rand -hex 24) LEYDEN_LN_MNEMONIC=~/.leyden/spark.mnemonic node server.mjs

# Gateway (creates its ZEC wallet on first run)
cd gateway && cargo build --release
./target/release/leyden --zec-mnemonic ~/.leyden/zec.mnemonic status        # shows the wallet
LEYDEN_LN_TOKEN=… ./target/release/leyden --zec-mnemonic ~/.leyden/zec.mnemonic serve --web ../web
```

`deploy/` has the systemd units, the Caddyfile and an environment template used for the live instance.

## Built for ZECATHON

All code was written during the build window (October 2026). It builds on
`librustzcash` (`zcash_client_backend`, `zcash_client_sqlite`, `zcash_keys`), the Spark SDK,
`light-bolt11-decoder` and `qrcode-generator`, and uses `zcash-devtool` as the shielded test wallet.

License: MIT.
