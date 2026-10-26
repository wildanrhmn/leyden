"use strict";

// Landing page: the quick-quote card and the live rate.
(() => {
  const $ = (id) => document.getElementById(id);
  const card = $("swapcard");
  const amount = $("q-amount");
  const zecOut = $("q-zec");
  let info = null;
  let dir = "pay"; // "pay": ZEC → Lightning, "receive": Lightning → ZEC

  const SHIELD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 2.5 3.8v3.7c0 3.2 2.3 5.9 5.5 7 3.2-1.1 5.5-3.8 5.5-7V3.8z" fill="currentColor"/></svg>';
  const BOLT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1 3.5 9.2h3.9L6.6 15l5.9-8.4H8.6z" fill="currentColor"/></svg>';
  // Real asset marks, each with a small badge for how it moves: shielded, or over Lightning.
  const ZEC = `<span class="ico"><img src="/brand/tokens/zec.svg" alt="" width="26" height="26"><span class="badge badge-shield">${SHIELD}</span></span>ZEC<small>shielded</small>`;
  const LN = `<span class="ico"><img src="/brand/tokens/btc.svg" alt="" width="26" height="26"><span class="badge badge-bolt">${BOLT}</span></span>BTC<small>Lightning</small>`;

  const fmtZec = (zat) => (zat / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  const fmtUsd = (usd) => `≈ $${usd < 1 ? usd.toFixed(2) : usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  function render() {
    const sats = Math.max(0, Math.floor(Number(amount.value) || 0));
    const pay = dir === "pay";
    card.classList.toggle("flipped", !pay);
    $("leg-from").querySelector(".leg-label").textContent = pay ? "You pay" : "They pay";
    $("leg-to").querySelector(".leg-label").textContent = pay ? "They receive" : "You receive";
    $("q-from-token").innerHTML = pay ? ZEC : LN;
    $("q-to-token").innerHTML = pay ? LN : ZEC;
    // The sats field always sits in the Lightning leg; the ZEC figure in the other.
    const lnSlot = $(pay ? "q-to-slot" : "q-from-slot");
    const zecSlot = $(pay ? "q-from-slot" : "q-to-slot");
    if (amount.parentElement !== lnSlot) { lnSlot.append(amount); zecSlot.append(zecOut); }

    if (!info) return;
    const rate = info.rate.zat_per_sat;
    const fee = info.fee_bps / 10000;
    const satsUsd = (sats * info.rate.btc_usd) / 1e8;
    // Mirrors the gateway's pricing: Lightning routing allowance + margin, or margin + Zcash network fee.
    const zat = pay
      ? Math.ceil((sats + Math.max(3, Math.floor(sats / 200)) + 1) * rate * (1 + fee))
      : Math.floor(sats * rate * (1 - fee)) - info.zec_network_fee_zat;
    const zecText = zat > 0 ? fmtZec(zat) : "0";
    const zecUsd = fmtUsd((Math.max(zat, 0) / 1e8) * info.rate.zec_usd);

    zecOut.textContent = zecText;
    $("q-from-foot").textContent = pay ? zecUsd : fmtUsd(satsUsd);
    $("q-to-foot").textContent = pay ? fmtUsd(satsUsd) : zecUsd;

    const tooSmall = !pay && zat <= 10000;
    const outOfRange = sats < info.min_sats || sats > info.max_sats;
    const go = $("q-go");
    go.disabled = tooSmall || outOfRange;
    go.textContent = outOfRange
      ? `Enter ${info.min_sats.toLocaleString("en-US")}–${info.max_sats.toLocaleString("en-US")} sats`
      : tooSmall ? "Too small to cover the network fee" : pay ? "Pay a Lightning invoice" : "Get paid over Lightning";
  }

  async function load() {
    try {
      const res = await fetch("/api/info", { cache: "no-store" });
      info = await res.json();
      $("stat-rate").textContent = `${info.rate.zat_per_sat.toFixed(1)} zat/sat`;
      amount.max = info.max_sats;
      amount.min = info.min_sats;
    } catch {
      $("stat-rate").textContent = "offline";
    }
    render();
  }

  amount.addEventListener("input", () => { render(); dispatchEvent(new Event("shieldbolt:pulse")); });
  $("q-flip").addEventListener("click", () => { dir = dir === "pay" ? "receive" : "pay"; render(); dispatchEvent(new Event("shieldbolt:flip")); });
  card.addEventListener("submit", (e) => {
    e.preventDefault();
    location.href = `/app/?dir=${dir}&sats=${Math.floor(Number(amount.value) || 0)}`;
  });

  render();
  load();
  setInterval(load, 60000);
})();
