"use strict";

// Shared navbar: mobile menu, scrolled state, and the live gateway readout.
(() => {
  const nav = document.querySelector("[data-nav]");
  if (!nav) return;
  const burger = nav.querySelector(".burger");
  const menu = nav.querySelector(".nav-links");

  const setOpen = (open) => {
    nav.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  burger.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("open")) { setOpen(false); burger.focus(); }
  });
  matchMedia("(min-width: 941px)").addEventListener("change", (m) => { if (m.matches) setOpen(false); });

  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Live readout. "live" = both sides have liquidity, "low" = one side is empty.
  const status = nav.querySelector("[data-status]");
  const rate = status.querySelector(".rate");
  const label = status.querySelector(".net");
  async function refresh() {
    try {
      const res = await fetch("/api/info", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const info = await res.json();
      const ln = info.liquidity.lightning_sats;
      const zec = info.liquidity.zec_zat / 1e8;
      status.dataset.state = ln > 0 && zec > 0 ? "live" : "low";
      label.textContent = "Mainnet";
      rate.textContent = `1 sat = ${info.rate.zat_per_sat.toFixed(1)} zat`;
      status.title = `Gateway is up. Ready to pay out ${ln.toLocaleString("en-US")} sats over Lightning and ${zec.toFixed(5)} ZEC shielded.`;
    } catch {
      status.dataset.state = "down";
      label.textContent = "Offline";
      rate.textContent = "";
      status.title = "The gateway is not reachable right now.";
    }
  }
  refresh();
  setInterval(refresh, 60000);
})();
