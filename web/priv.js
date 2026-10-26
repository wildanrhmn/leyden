"use strict";

// Privacy: what the public chains recorded for two real cross-chain moves (both on
// 2026-10-26, see docs/mainnet-runs.md), then a grid of who sees what during a swap.
// Everything plays once, on scroll; nothing changes by itself afterwards.
(() => {
  const root = document.querySelector(".priv");
  if (!root) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = !!window.gsap;
  const publics = [...root.querySelectorAll(".rec-open dd[data-public]")];
  const sealed = [...root.querySelectorAll(".rec-sealed dd[data-sealed]")];
  const blocks = (el) => "█".repeat(Math.max(6, Math.min(16, el.dataset.sealed.length)));

  // Phones show the grid as one card per party; each mark carries its column's name.
  const heads = [...root.querySelectorAll(".sees-head span")].slice(1).map((h) => h.textContent);
  root.querySelectorAll(".sees-row:not(.sees-head)").forEach((row) => {
    row.querySelectorAll("i").forEach((cell, k) => {
      cell.dataset.label = heads[k];
      cell.setAttribute("role", "cell");
      cell.setAttribute("aria-label", `${heads[k]}: ${{ 0: "no", 1: "yes", t: "yes, unless you use Tor", d: "yes, erased after 24 hours" }[cell.dataset.v]}`);
    });
  });

  function finalState() {
    publics.forEach((el) => el.style.setProperty("--mark", "100%"));
    sealed.forEach((el) => { el.textContent = blocks(el); el.classList.add("sealed"); });
  }

  if (!hasGsap || reduce) { finalState(); return; }
  gsap.registerPlugin(ScrollTrigger, ScrambleTextPlugin);

  gsap.from(".priv .sec-head > *", { opacity: 0, y: 24, filter: "blur(8px)", stagger: 0.12, duration: 1.1, ease: "expo.out", clearProps: "filter",
    scrollTrigger: { trigger: ".priv .sec-head", start: "top 85%", once: true } });

  // The two records.
  const rec = gsap.timeline({ paused: true });
  rec.from(".rec", { opacity: 0, y: 40, stagger: 0.12, duration: 1, ease: "expo.out" }, 0)
    .from(".rec .xcard", { opacity: 0, y: 14, stagger: 0.08, duration: 0.7, ease: "power3.out" }, 0.25);
  publics.forEach((el, k) => {
    const o = { m: 0 };
    rec.to(o, { m: 100, duration: 0.5, ease: "power2.out", onUpdate: () => el.style.setProperty("--mark", o.m + "%") }, 0.8 + k * 0.07);
  });
  sealed.forEach((el, k) => {
    rec.to(el, { duration: 0.9, ease: "none", onStart: () => el.classList.add("sealed"),
      scrambleText: { text: blocks(el), chars: "█▓▒░", revealDelay: 0.15, speed: 0.5 } }, 0.9 + k * 0.1);
  });
  rec.from(".x-none, .x-none-sub", { opacity: 0, y: 8, stagger: 0.1, duration: 0.6, ease: "power3.out" }, 1.3)
    .from(".rec-foot", { opacity: 0, duration: 0.6 }, 1.6);
  ScrollTrigger.create({ trigger: ".record", start: "top 72%", once: true, onEnter: () => rec.play() });

  // The grid.
  const grid = gsap.timeline({ paused: true });
  grid.from(".grid-title", { opacity: 0, y: 14, duration: 0.7, ease: "power3.out" }, 0)
    .from(".sees-row", { opacity: 0, y: 10, stagger: 0.06, duration: 0.5, ease: "power3.out" }, 0.1)
    .from(".sees-row:not(.sees-head) i", { scale: 0, opacity: 0, stagger: { each: 0.018, from: "start" }, duration: 0.35, ease: "back.out(2.5)" }, 0.35)
    .from(".grid-note, .promises", { opacity: 0, duration: 0.6, stagger: 0.15 }, 0.9);
  ScrollTrigger.create({ trigger: ".grid-wrap", start: "top 78%", once: true, onEnter: () => grid.play() });
})();
