// Leyden Lightning sidecar.
//
// A small localhost-only HTTP service that gives the Rust gateway a backend-neutral
// Lightning interface. This implementation uses a self-custodial Spark wallet
// (no channels, no inbound-liquidity purchase). The same endpoints can be served by
// phoenixd or LND without changing the gateway.
//
// Given a paymentHash, /invoice creates a hold invoice: a payment to it is held, not
// taken, until /settle reveals the preimage. If it is never settled, the payer's
// Lightning payment times out and their sats go back to them.
//
//   POST /invoice   {amountSats, memo?, descriptionHash?, expirySecs?, paymentHash?} -> {id, bolt11, paymentHash}
//   GET  /invoice/:id                                               -> {id, paid, held, status}
//   POST /settle    {preimage}                                      -> {transferId}
//   POST /decode    {bolt11}                                        -> {amountMsat, paymentHash, expiresAt, network}
//   POST /fee       {bolt11}                                        -> {feeSats}
//   POST /pay       {bolt11, maxFeeSats}                            -> {id, status}
//   GET  /pay/:id                                                   -> {id, status, done, failed, preimage, feeSats}
//   GET  /balance                                                   -> {sats}
//   POST /claim-deposits                                            -> {claimed: [...]}
//
// Every request must carry `Authorization: Bearer $LEYDEN_LN_TOKEN`.

import http from "node:http";
import fs from "node:fs";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { decode as decodeBolt11 } from "light-bolt11-decoder";

const PORT = Number(process.env.LEYDEN_LN_PORT ?? 9737);
const TOKEN = process.env.LEYDEN_LN_TOKEN;
const MNEMONIC_FILE = process.env.LEYDEN_LN_MNEMONIC;
if (!TOKEN || !MNEMONIC_FILE) {
  console.error("LEYDEN_LN_TOKEN and LEYDEN_LN_MNEMONIC are required");
  process.exit(1);
}

const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: fs.readFileSync(MNEMONIC_FILE, "utf8").trim(),
  options: { network: "MAINNET" },
});
const depositAddress = await wallet.getStaticDepositAddress();
console.log(`spark wallet ready; static deposit address ${depositAddress}`);

const SEND_DONE = new Set(["LIGHTNING_PAYMENT_SUCCEEDED", "PREIMAGE_PROVIDED", "TRANSFER_COMPLETED"]);
const SEND_FAILED = new Set([
  "USER_TRANSFER_VALIDATION_FAILED",
  "LIGHTNING_PAYMENT_FAILED",
  "TRANSFER_FAILED",
  "USER_SWAP_RETURNED",
  "USER_SWAP_RETURN_FAILED",
  "PREIMAGE_PROVIDING_FAILED",
]);
const RECEIVE_PAID = new Set(["LIGHTNING_PAYMENT_RECEIVED", "TRANSFER_COMPLETED", "PAYMENT_PREIMAGE_RECOVERED"]);

const routes = {
  "POST /invoice": async (b) => {
    const amountSats = Number(b.amountSats);
    if (!Number.isInteger(amountSats) || amountSats <= 0) throw new HttpError(400, "amountSats");
    const params = {
      amountSats,
      memo: b.descriptionHash ? undefined : (b.memo ?? ""),
      descriptionHash: b.descriptionHash,
      expirySeconds: b.expirySecs ?? 900,
    };
    const req = b.paymentHash
      ? await wallet.createLightningHodlInvoice({ ...params, paymentHash: String(b.paymentHash) })
      : await wallet.createLightningInvoice(params);
    return { id: req.id, bolt11: req.invoice.encodedInvoice, paymentHash: req.invoice.paymentHash };
  },
  "GET /invoice": async (_b, id) => {
    const req = await wallet.getLightningReceiveRequest(id);
    if (!req) throw new HttpError(404, "unknown invoice");
    const paid = RECEIVE_PAID.has(req.status);
    // A held payment to a hold invoice shows up as a pending transfer before any status change.
    return { id, status: req.status, paid, held: !paid && Boolean(req.transfer) };
  },
  "POST /settle": async (b) => {
    if (!/^[0-9a-f]{64}$/i.test(String(b.preimage))) throw new HttpError(400, "preimage");
    const t = await wallet.claimHTLC(String(b.preimage).toLowerCase());
    return { transferId: t?.id ?? null };
  },
  "POST /decode": async (b) => {
    let d;
    try {
      d = decodeBolt11(String(b.bolt11).trim().replace(/^lightning:/i, ""));
    } catch {
      throw new HttpError(400, "not a valid BOLT11 invoice");
    }
    const sec = (n) => d.sections.find((s) => s.name === n)?.value;
    const timestamp = Number(sec("timestamp"));
    return {
      amountMsat: sec("amount") ? Number(sec("amount")) : null,
      paymentHash: sec("payment_hash"),
      expiresAt: timestamp + Number(d.expiry ?? 3600),
      network: d.sections.find((s) => s.name === "coin_network")?.value?.bech32 ?? null,
    };
  },
  "POST /fee": async (b) => {
    const feeSats = await wallet.getLightningSendFeeEstimate({ encodedInvoice: b.bolt11 });
    return { feeSats: Number(feeSats) };
  },
  "POST /pay": async (b) => {
    const res = await wallet.payLightningInvoice({
      invoice: b.bolt11,
      maxFeeSats: Number(b.maxFeeSats),
      preferSpark: false,
    });
    return { id: res.id, status: res.status ?? "CREATED" };
  },
  "GET /pay": async (_b, id) => {
    const req = await wallet.getLightningSendRequest(id);
    if (!req) throw new HttpError(404, "unknown payment");
    return {
      id,
      status: req.status,
      done: SEND_DONE.has(req.status),
      failed: SEND_FAILED.has(req.status),
      preimage: req.paymentPreimage ?? null,
      feeSats: req.fee ? Number(req.fee.originalValue) / (req.fee.originalUnit === "MILLISATOSHI" ? 1000 : 1) : null,
    };
  },
  "GET /balance": async () => {
    const bal = await wallet.getBalance();
    return { sats: Number(bal.satsBalance?.available ?? bal.balance) };
  },
  "POST /claim-deposits": async () => {
    const { utxos } = normalizeUtxos(await wallet.getUtxosForDepositAddress(depositAddress, 100, 0, true));
    const claimed = [];
    for (const u of utxos) {
      const quote = await wallet.getClaimStaticDepositQuote(u.txid, u.vout);
      const out = await wallet.claimStaticDeposit({
        transactionId: u.txid,
        outputIndex: u.vout,
        creditAmountSats: quote.creditAmountSats,
        sspSignature: quote.signature,
      });
      claimed.push({ txid: u.txid, vout: u.vout, creditAmountSats: quote.creditAmountSats, out: out ?? null });
    }
    return { depositAddress, claimed };
  },
};

function normalizeUtxos(res) {
  const list = Array.isArray(res) ? res : (res?.utxos ?? []);
  return { utxos: list.map((u) => ({ txid: u.txid, vout: u.vout ?? u.outputIndex ?? 0 })) };
}

class HttpError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

http
  .createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
    };
    try {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) throw new HttpError(401, "unauthorized");
      const [path, id] = req.url.split("/").filter(Boolean);
      const handler = routes[`${req.method} /${path}`];
      if (!handler) throw new HttpError(404, "not found");
      let body = "";
      for await (const chunk of req) body += chunk;
      send(200, await handler(body ? JSON.parse(body) : {}, id));
    } catch (e) {
      console.error(`${req.method} ${req.url}:`, e?.message ?? e);
      send(e instanceof HttpError ? e.code : 500, { error: String(e?.message ?? e) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`listening on 127.0.0.1:${PORT}`));
