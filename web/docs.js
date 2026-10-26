"use strict";

// Docs: highlight the section you're reading in the side list, and fill in live numbers
// (fee, limits, rate, how large a swap can be right now) from the gateway.
(() => {
  const links = [...document.querySelectorAll(".toc a")];
  const sections = links.map((a) => document.querySelector(a.hash)).filter(Boolean);

  // The current section is the last one whose top has passed a line a third down the screen.
  function mark() {
    const line = innerHeight / 3;
    let current = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top - line <= 0) current = s;
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1];
    links.forEach((a) => a.classList.toggle("on", a.hash === `#${current.id}`));
    const on = links.find((a) => a.classList.contains("on"));
    // Keep the active chip visible in the scrollable strip on phones.
    if (on && on.parentElement.scrollWidth > on.parentElement.clientWidth) {
      on.parentElement.scrollTo({ left: on.offsetLeft - 24, behavior: "smooth" });
    }
  }
  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { mark(); ticking = false; });
  }, { passive: true });
  mark();

  const n = (v) => Number(v).toLocaleString("en-US");
  const set = (key, text) => document.querySelectorAll(`[data-info="${key}"]`).forEach((el) => { el.textContent = text; });
  fetch("/api/info", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      const r = d.rate.zat_per_sat, fee = d.fee_bps / 10000;
      set("domain", d.lightning_address_domain);
      set("fee", `${n(d.fee_bps / 100)}%`);
      set("range", `${n(d.min_sats)} – ${n(d.max_sats)} sats`);
      set("netfee", `${(d.zec_network_fee_zat / 1e8).toFixed(5).replace(/0+$/, "")} ZEC per payout or refund`);
      set("rate", `1 sat ≈ ${r.toFixed(1)} zats, from NEAR Intents`);
      // Pay is limited by the gateway's Lightning balance; Get paid by its ZEC.
      const maxPay = Math.min(d.max_sats, Math.max(0, d.liquidity.lightning_sats - Math.max(3, Math.floor(d.liquidity.lightning_sats / 200)) - 1));
      const maxGet = Math.min(d.max_sats, Math.max(0, Math.floor((d.liquidity.zec_zat) / (r * (1 - fee)))));
      set("maxpay", `${n(maxPay)} sats`);
      set("maxget", `${n(maxGet)} sats`);
    })
    .catch(() => { set("maxpay", "unavailable"); set("maxget", "unavailable"); });
})();
