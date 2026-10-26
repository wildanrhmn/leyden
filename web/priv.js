"use strict";

// Privacy: the same real swap (docs/mainnet-runs.md, run 1), seen by six observers.
// Fields an observer cannot see dissolve into blocks; fields they can see resolve back.
(() => {
  const root = document.querySelector(".priv");
  if (!root) return;
  const tabs = [...root.querySelectorAll(".observers button")];
  const stage = root.querySelector(".lens-stage");
  const spot = root.querySelector(".spot");
  const nodes = [...root.querySelectorAll(".pnode")];
  const fields = [...root.querySelectorAll(".field")];
  const countEl = root.querySelector(".count");
  const countNum = countEl.querySelector("b");
  const verdict = root.querySelector(".verdict");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = !!window.gsap;
  if (hasGsap) gsap.registerPlugin(ScrollTrigger, ScrambleTextPlugin);

  // at: where on the path the observer sits (node index; halves sit between nodes).
  const OBSERVERS = [
    { at: 1, sees: [], verdict: "That a shielded transaction happened. Not who sent it, not how much, not where it went." },
    { at: 1.5, sees: [], verdict: "That the gateway downloads every block. Never which outputs are its own: it never asks for a transaction by ID." },
    { at: 3, sees: [], verdict: "Nothing. A Lightning payment writes no Bitcoin transaction." },
    { at: 3, sees: ["sats"], verdict: "An amount passing through. Onion routing keeps both ends from every hop." },
    { at: 4, sees: ["sats", "invoice"], verdict: "That their invoice was paid. Nothing about you, your wallet or your Zcash." },
    { at: 2, sees: ["ip", "zaddr", "zec", "link", "sats", "invoice"], verdict: "The swap itself, while it runs. The link between both sides is erased 24 hours after it finishes. Connect over Tor and your IP stays hidden too." },
  ];

  let current = -1;
  let anim = null;
  let auto = null;
  let userPicked = false;

  const blocks = (f) => "█".repeat(Math.max(4, Math.min(14, f.dataset.v.length)));

  function spotPos(at) {
    const a = nodes[Math.floor(at)], b = nodes[Math.ceil(at)];
    const sr = stage.getBoundingClientRect(), ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    const t = at - Math.floor(at);
    const x = (ar.left + ar.width / 2) * (1 - t) + (br.left + br.width / 2) * t - sr.left;
    const y = (ar.top + ar.height / 2) * (1 - t) + (br.top + br.height / 2) * t - sr.top;
    return { x, y };
  }

  function select(i, instant) {
    if (i === current) return;
    current = i;
    const o = OBSERVERS[i];
    tabs.forEach((t, k) => t.setAttribute("aria-selected", String(k === i)));
    // An observer between two points watches both.
    nodes.forEach((n, k) => n.classList.toggle("watched", k === Math.floor(o.at) || k === Math.ceil(o.at)));
    const visible = new Set(o.sees);
    const narrow = innerWidth <= 860;
    // On phones the observer row scrolls sideways; keep the active one in view.
    if (narrow) {
      const row = tabs[i].parentElement;
      row.scrollTo({ left: tabs[i].offsetLeft - row.clientWidth / 2 + tabs[i].offsetWidth / 2, behavior: instant || reduce ? "auto" : "smooth" });
    }

    // Finish (not revert) a running change, so text and classes always agree.
    if (anim) { anim.progress(1).kill(); anim = null; }
    if (!hasGsap || reduce || instant) {
      fields.forEach((f) => { const show = visible.has(f.dataset.f); f.textContent = show ? f.dataset.v : blocks(f); f.classList.toggle("hidden", !show); });
      countNum.textContent = o.sees.length;
      countEl.classList.toggle("all", o.sees.length === 6);
      verdict.textContent = o.verdict;
      if (hasGsap) { const p = spotPos(o.at); gsap.set(spot, narrow ? { y: p.y, x: 0, opacity: 1 } : { x: p.x, y: 0, opacity: 1 }); }
      return;
    }

    const tl = gsap.timeline();
    const p = spotPos(o.at);
    tl.to(spot, narrow ? { y: p.y, x: 0, opacity: 1, duration: 0.8, ease: "expo.inOut" } : { x: p.x, y: 0, opacity: 1, duration: 0.8, ease: "expo.inOut" }, 0);
    fields.forEach((f) => {
      const show = visible.has(f.dataset.f);
      const isHidden = f.classList.contains("hidden");
      if (show && isHidden) {
        tl.add(() => f.classList.remove("hidden"), 0.2)
          .fromTo(f, { scrambleText: { text: f.textContent } },
            { duration: 0.8, ease: "none", scrambleText: { text: f.dataset.v, chars: "█▓▒░", revealDelay: 0.15, speed: 0.5 } }, 0.2);
      } else if (!show && !isHidden) {
        tl.add(() => f.classList.add("hidden"), 0.15)
          .fromTo(f, { scrambleText: { text: f.dataset.v } },
            { duration: 0.7, ease: "none", scrambleText: { text: blocks(f), chars: "█▓▒░", revealDelay: 0.1, speed: 0.5 } }, 0.15);
      }
    });
    const c = { v: Number(countNum.textContent) || 0 };
    tl.to(c, { v: o.sees.length, duration: 0.7, ease: "power2.out", onUpdate: () => { countNum.textContent = Math.round(c.v); } }, 0.2)
      .add(() => countEl.classList.toggle("all", o.sees.length === 6), 0.5)
      .to(verdict, { opacity: 0, y: -4, duration: 0.2, ease: "power2.in" }, 0)
      .add(() => { verdict.textContent = o.verdict; }, 0.2)
      .fromTo(verdict, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, 0.22);
    anim = tl;
  }

  // Auto-cycle while the section is in view, until the visitor picks an observer.
  function startAuto() {
    if (auto || userPicked || reduce) return;
    auto = setInterval(() => select((current + 1) % OBSERVERS.length), 4200);
  }
  function stopAuto() { clearInterval(auto); auto = null; }

  tabs.forEach((t, k) => t.addEventListener("click", () => { userPicked = true; stopAuto(); select(k); }));
  addEventListener("resize", () => { if (current >= 0 && hasGsap) { const p = spotPos(OBSERVERS[current].at); gsap.set(spot, innerWidth <= 860 ? { y: p.y, x: 0 } : { x: p.x, y: 0 }); } });

  // Starting state: everything hidden, as the Zcash chain sees it.
  select(0, true);

  if (!hasGsap) return;
  gsap.from(".priv .sec-head > *", { opacity: 0, y: 24, filter: "blur(8px)", duration: 1.1, ease: "expo.out", clearProps: "filter",
    scrollTrigger: { trigger: ".priv .sec-head", start: "top 85%" } });
  gsap.timeline({ scrollTrigger: { trigger: ".lens", start: "top 75%" } })
    .from(tabs, { opacity: 0, y: 10, stagger: 0.05, duration: 0.6, ease: "power3.out" }, 0)
    .from(nodes, { opacity: 0, y: 14, stagger: 0.08, duration: 0.7, ease: "power3.out" }, 0.2)
    .from(".lens-foot > *, .promises", { opacity: 0, y: 10, stagger: 0.1, duration: 0.7, ease: "power3.out" }, 0.5);
  ScrollTrigger.create({ trigger: root, start: "top 60%", end: "bottom 30%", onToggle: (self) => (self.isActive ? startAuto() : stopAuto()) });
})();
