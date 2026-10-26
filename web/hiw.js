"use strict";

// "How it works": a sticky screen plays a short scene for whichever step is in view.
// Scenes use real data from the recorded mainnet runs (docs/mainnet-runs.md).
(() => {
  const stage = document.querySelector(".hiw-stage");
  if (!stage) return;
  const steps = [...stage.querySelectorAll(".step")];
  const list = stage.querySelector(".hiw-steps");
  const toggle = document.querySelector(".dir-toggle");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = !!window.gsap;
  if (hasGsap) gsap.registerPlugin(ScrollTrigger, ScrambleTextPlugin);

  let dir = "pay";
  let step = -1;
  let scene = null;

  // Render the QR in the "get paid" scene (a real invoice from the Lightning-address run).
  for (const el of stage.querySelectorAll("[data-qr]")) {
    if (!window.qrcode) break;
    const q = qrcode(0, "L");
    q.addData(el.dataset.qr);
    q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }

  const visFor = (d, i) => stage.querySelector(`.vis[data-dir="${d}"][data-step="${i}"]`);

  function show(i, force) {
    if (i === step && !force) return;
    const prev = step >= 0 ? visFor(dir, step) : null;
    step = i;
    steps.forEach((s, k) => s.classList.toggle("on", k === i));
    const next = visFor(dir, i);
    if (scene) { scene.kill(); scene = null; }

    if (!hasGsap || reduce) {
      stage.querySelectorAll(".vis").forEach((v) => v.classList.toggle("on", v === next));
      finalState(next);
      return;
    }
    if (prev && prev !== next) {
      gsap.to(prev, { opacity: 0, y: -10, filter: "blur(6px)", duration: 0.35, ease: "power2.in", onComplete: () => prev.classList.remove("on") });
    }
    stage.querySelectorAll(".vis.on").forEach((v) => { if (v !== prev && v !== next) v.classList.remove("on"); });
    next.classList.add("on");
    gsap.fromTo(next, { opacity: 0, y: 14, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.7, delay: prev ? 0.2 : 0, ease: "expo.out", clearProps: "filter" });
    scene = play(next, prev ? 0.35 : 0.1);
  }

  // Typing helper: reveals a field's text character by character.
  function type(tl, el, at, cps = 70) {
    const text = el.dataset.type;
    const o = { n: 0 };
    el.textContent = "";
    tl.to(o, { n: text.length, duration: text.length / cps, ease: "none", onUpdate: () => { el.textContent = text.slice(0, Math.round(o.n)); } }, at);
  }

  function play(v, delay) {
    const tl = gsap.timeline({ delay });
    const key = `${v.dataset.dir}-${v.dataset.step}`;
    const q = (sel) => v.querySelectorAll(sel);

    if (key === "pay-0") {
      type(tl, v.querySelector("[data-type]"), 0);
      tl.from(v.querySelector(".quote"), { opacity: 0, y: 16, duration: 0.7, ease: "expo.out" }, ">0.15")
        .from(q(".quote .row, .quote .tag"), { opacity: 0, y: 8, stagger: 0.08, duration: 0.5, ease: "power2.out" }, "<0.1");
    } else if (key === "pay-1") {
      // Start readable, then watch the chain's view of it disappear.
      q("[data-redact]").forEach((dd) => { dd.textContent = dd.dataset.redact; dd.classList.remove("redacted"); });
      tl.from(q(".ledger div"), { opacity: 0, x: -8, stagger: 0.07, duration: 0.5, ease: "power2.out" }, 0);
      q("[data-redact]").forEach((dd, k) => {
        tl.to(dd, {
          duration: 0.9,
          scrambleText: { text: "█".repeat(Math.min(18, dd.dataset.redact.length)), chars: "█▓▒░", speed: 0.6 },
          ease: "none",
          onStart: () => dd.classList.add("redacted"),
        }, 0.9 + k * 0.18);
      });
      tl.from(v.querySelector(".foot"), { opacity: 0, duration: 0.6 }, ">-0.2");
    } else if (key === "pay-2") {
      tl.fromTo(v.querySelector(".check path"), { strokeDashoffset: 32 }, { strokeDashoffset: 0, duration: 0.7, ease: "power2.out" }, 0)
        .from(v.querySelector(".big-amt"), { opacity: 0, y: 10, duration: 0.6, ease: "expo.out" }, 0.1);
      const pre = v.querySelector("[data-scramble]");
      tl.fromTo(pre, { scrambleText: { text: pre.dataset.scramble, chars: "0123456789abcdef", speed: 1 } },
        { duration: 1.1, scrambleText: { text: pre.dataset.scramble, chars: "0123456789abcdef", revealDelay: 0.3, speed: 0.8 } }, 0.3);
      tl.from(q(".tag, .foot"), { opacity: 0, y: 6, stagger: 0.15, duration: 0.5 }, ">-0.2");
    } else if (key === "get-0") {
      type(tl, v.querySelector("[data-type]"), 0, 80);
      tl.from(v.querySelector(".invoice-row"), { opacity: 0, y: 16, duration: 0.7, ease: "expo.out" }, ">0.1")
        .from(v.querySelector(".qr-mini"), { scale: 0.9, opacity: 0, duration: 0.6, ease: "back.out(1.6)" }, "<0.1");
    } else if (key === "get-1") {
      tl.from(q(".wallets li"), { opacity: 0, y: 10, scale: 0.96, stagger: 0.05, duration: 0.45, ease: "power2.out" }, 0)
        .fromTo(v.querySelector(".bolt-line i"), { x: -120 }, { x: () => v.querySelector(".bolt-line").offsetWidth, duration: 1.1, ease: "power2.inOut", repeat: -1, repeatDelay: 0.6 }, 0.4)
        .from(v.querySelector(".foot"), { opacity: 0, duration: 0.6 }, 0.6);
    } else if (key === "get-2") {
      const memo = v.querySelector("[data-decrypt]");
      tl.from(v.querySelector(".big-amt"), { opacity: 0, y: 10, duration: 0.6, ease: "expo.out" }, 0)
        .fromTo(memo, { scrambleText: { text: "█".repeat(24), chars: "█▓▒░" } },
          { duration: 1.6, scrambleText: { text: memo.dataset.decrypt, chars: "█▓▒░", revealDelay: 0.4, speed: 0.5 } }, 0.4)
        .from(v.querySelector(".foot"), { opacity: 0, duration: 0.6 }, ">-0.3");
    }
    return tl;
  }

  // Without animation, show each scene's end state.
  function finalState(v) {
    if (!v) return;
    v.querySelectorAll("[data-type]").forEach((el) => { el.textContent = el.dataset.type; });
    v.querySelectorAll("[data-redact]").forEach((el) => { el.textContent = "█".repeat(Math.min(18, el.dataset.redact.length)); el.classList.add("redacted"); });
  }

  function setDir(d) {
    if (d === dir) return;
    dir = d;
    stage.dataset.dir = d;
    toggle.dataset.active = d;
    toggle.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.dir === d)));
    stage.querySelectorAll(".vis.on").forEach((v) => { v.classList.remove("on"); if (hasGsap) gsap.set(v, { clearProps: "all" }); });
    const cur = Math.max(step, 0);
    step = -1;
    show(cur, true);
    if (hasGsap) ScrollTrigger.refresh();
  }
  toggle.addEventListener("click", (e) => { const b = e.target.closest("button[data-dir]"); if (b) setDir(b.dataset.dir); });

  // Steps become active as they cross the middle of the viewport.
  if (hasGsap) {
    steps.forEach((s, i) => ScrollTrigger.create({
      // On phones the sticky screen covers the top half, so a step activates lower down.
      trigger: s, start: () => (innerWidth <= 900 ? "top 78%" : "top 58%"), end: () => (innerWidth <= 900 ? "bottom 78%" : "bottom 58%"),
      invalidateOnRefresh: true,
      onToggle: (self) => { if (self.isActive) show(i); },
    }));
    ScrollTrigger.create({
      trigger: list, start: "top 60%", end: "bottom 60%", scrub: true,
      onUpdate: (self) => list.style.setProperty("--fill", self.progress.toFixed(4)),
    });
    gsap.from(".hiw .sec-head > *", { opacity: 0, y: 24, filter: "blur(8px)", stagger: 0.12, duration: 1.1, ease: "expo.out", clearProps: "filter",
      scrollTrigger: { trigger: ".hiw .sec-head", start: "top 80%" } });
  }
  if (hasGsap && !reduce) {
    // Visible from the start in its finished state; the scene plays when the step scrolls into view.
    const v0 = visFor(dir, 0);
    v0.classList.add("on");
    finalState(v0);
    steps[0].classList.add("on");
  } else {
    show(0, true);
  }
})();
