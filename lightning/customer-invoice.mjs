// Test helper: a second, independent Spark wallet acting as "some Lightning user".
// Usage: node customer-invoice.mjs <mnemonic-file> invoice <sats> | pay <bolt11> | balance | status <id>
import { SparkWallet } from "@buildonspark/spark-sdk";
import fs from "node:fs";
const [, , file, cmd, arg] = process.argv;
const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : undefined;
const { wallet, mnemonic } = await SparkWallet.initialize({ mnemonicOrSeed: existing, options: { network: "MAINNET" } });
if (!existing) fs.writeFileSync(file, mnemonic + "\n", { mode: 0o600 });
const out = (o) => console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 1));
if (cmd === "invoice") {
  const r = await wallet.createLightningInvoice({ amountSats: Number(arg), memo: "coffee", expirySeconds: 3600 });
  out({ id: r.id, bolt11: r.invoice.encodedInvoice });
} else if (cmd === "pay") {
  const r = await wallet.payLightningInvoice({ invoice: arg, maxFeeSats: 50, preferSpark: false });
  out({ id: r.id, status: r.status });
} else if (cmd === "status") {
  const r = await wallet.getLightningReceiveRequest(arg);
  out({ status: r?.status });
} else {
  out(await wallet.getBalance());
}
await wallet.cleanupConnections();
process.exit(0);
