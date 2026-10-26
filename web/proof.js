"use strict";

// Proof: the first four mainnet swaps (docs/mainnet-runs.md), printed as receipts that feed
// out of the slot once, on scroll. The two Lightning receipts can be checked on the page:
// the payment hash is read out of the BOLT11 invoice (bolt11.js) and compared with SHA-256(preimage).
(() => {
  const root = document.querySelector(".proof");
  if (!root) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = !!window.gsap && !reduce;
  if (animate) gsap.registerPlugin(ScrollTrigger, ScrambleTextPlugin);

  async function sha256(hex) {
    const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function fillChars(el, text) {
    el.replaceChildren(...[...text].map((c) => Object.assign(document.createElement("b"), { textContent: c })));
    return [...el.children];
  }
  function verdict(el, match) {
    const strong = document.createElement("strong");
    strong.textContent = match ? "Match." : "No match.";
    el.replaceChildren(strong, match
      ? " Only a paid invoice gives up its preimage."
      : " This preimage does not belong to this invoice.");
  }

  root.querySelectorAll(".rcpt[data-bolt11]").forEach((rcpt) => {
    const btn = rcpt.querySelector(".r-check");
    const panel = rcpt.querySelector(".r-proof");
    const invEl = panel.querySelector('[data-k="inv"]');
    const shaEl = panel.querySelector('[data-k="sha"]');
    const ok = panel.querySelector(".r-ok");
    let started = false;

    btn.addEventListener("click", async () => {
      if (started) return;
      started = true;
      let fromInvoice, computed;
      try {
        fromInvoice = bolt11.decode(rcpt.dataset.bolt11).paymentHash;
        computed = await sha256(rcpt.dataset.preimage);
      } catch (e) {
        ok.textContent = `This browser couldn't run the check (${e.message}).`;
      }
      btn.hidden = true;
      btn.setAttribute("aria-expanded", "true");
      panel.hidden = false;
      if (!computed) return;
      const match = fromInvoice === computed;
      const invChars = fillChars(invEl, fromInvoice);

      const finish = () => {
        const shaChars = fillChars(shaEl, computed);
        invChars.forEach((b, k) => { if (b.textContent === shaChars[k].textContent) { b.classList.add("m"); shaChars[k].classList.add("m"); } });
        verdict(ok, match);
      };
      if (!animate) { finish(); return; }

      // The receipt prints a little more: the invoice's hash, then the computed one, then
      // a sweep that lights up every character that agrees.
      const tl = gsap.timeline({ onComplete: () => ScrollTrigger.refresh() });
      tl.from(panel, { height: 0, duration: 0.6, ease: "power2.inOut", clearProps: "height" })
        .from(invChars, { opacity: 0, duration: 0.2, stagger: 0.006 }, 0.35)
        .to(shaEl, { duration: 0.9, ease: "none", scrambleText: { text: computed, chars: "0123456789abcdef", revealDelay: 0.2, speed: 0.6 } }, 0.8)
        .add(() => {
          const shaChars = fillChars(shaEl, computed);
          invChars.forEach((b, k) => {
            if (b.textContent !== shaChars[k].textContent) return;
            gsap.delayedCall(k * 0.012, () => { b.classList.add("m"); shaChars[k].classList.add("m"); });
          });
        })
        .add(() => verdict(ok, match), "+=0.85")
        .from(ok, { opacity: 0, y: 6, duration: 0.5, ease: "power3.out" });
    });

    panel.querySelectorAll("[data-copy]").forEach((b) => {
      b.addEventListener("click", async () => {
        const label = b.textContent;
        try {
          await navigator.clipboard.writeText(rcpt.dataset[b.dataset.copy]);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed";
        }
        setTimeout(() => { b.textContent = label; }, 1500);
      });
    });
  });

  if (!animate) return;

  gsap.from(".proof .sec-head > *", { opacity: 0, y: 24, filter: "blur(8px)", stagger: 0.12, duration: 1.1, ease: "expo.out", clearProps: "filter",
    scrollTrigger: { trigger: ".proof .sec-head", start: "top 85%", once: true } });

  // The slot lights up, then each receipt feeds out from behind it.
  const print = gsap.timeline({ paused: true });
  print.fromTo(".slot", { "--lit": 0 }, { "--lit": 1, duration: 1, ease: "power2.out" }, 0)
    .from(".rcpt", { yPercent: -101, duration: 2, ease: "expo.out", stagger: 0.18 }, 0.25)
    .from(".proof-note", { opacity: 0, duration: 0.8 }, 1.2);
  ScrollTrigger.create({ trigger: ".rail", start: "top 75%", once: true, onEnter: () => print.play() });
})();
