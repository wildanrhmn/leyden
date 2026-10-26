// One-off: create (or load) a mainnet Spark wallet and print its static BTC deposit address.
import { SparkWallet } from "@buildonspark/spark-sdk";
import fs from "node:fs";

const [, , mnemonicFile] = process.argv;
const existing = fs.existsSync(mnemonicFile) ? fs.readFileSync(mnemonicFile, "utf8").trim() : undefined;
const { wallet, mnemonic } = await SparkWallet.initialize({
  mnemonicOrSeed: existing,
  options: { network: "MAINNET" },
});
if (!existing) fs.writeFileSync(mnemonicFile, mnemonic + "\n", { mode: 0o600 });
console.log("static deposit address:", await wallet.getStaticDepositAddress());
console.log("balance:", await wallet.getBalance());
await wallet.cleanupConnections();
