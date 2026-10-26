"use strict";

// "How it works". The steps scroll normally down a single line. On wide screens the
// screen rides a sticky track and its position follows the scroll: it starts on the
// left, flows to the right for step 02 and back to the left for step 03, so the step
// text zig-zags on the opposite side. Scenes use real data from the recorded mainnet
// runs (docs/mainnet-runs.md).
(() => {
  const stage = document.querySelector(".hiw-stage");
  if (!stage) return;
  const visual = stage.querySelector(".hiw-visual");
  const list = stage.querySelector(".hiw-steps");
  const steps = [...stage.querySelectorAll(".step")];
  const toggle = document.querySelector(".hiw .dir-toggle");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = !!window.gsap;
  if (hasGsap) gsap.registerPlugin(ScrollTrigger, ScrambleTextPlugin);

  let dir = "pay";
  let step = -1;
  let scene = null;
  let arrived = false;

  steps.forEach((s, i) => { s.dataset.side = i % 2 === 0 ? "right" : "left"; });

  for (const el of stage.querySelectorAll("[data-qr]")) {
    if (!window.qrcode) break;
    const q = qrcode(0, "L");
    q.addData(el.dataset.qr);
    q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }

  const visFor = (d, i) => stage.querySelector(`.vis[data-dir="${d}"][data-step="${i}"]`);

  function show(i, force) {
    if (!arrived || (i === step && !force)) return;
    const prev = step >= 0 ? visFor(dir, step) : null;
    step = i;
    steps.forEach((s, k) => s.classList.toggle("on", k === i));
    const next = visFor(dir, i);
    if (scene) { scene.kill(); scene = null; }

    const screen = visual.querySelector(".screen");
    const h0 = screen.offsetHeight;
    stage.querySelectorAll(".vis.cur").forEach((v) => v.classList.remove("cur"));
    next.classList.add("cur");

    if (!hasGsap || reduce) {
      stage.querySelectorAll(".vis").forEach((v) => v.classList.toggle("on", v === next));
      settle(next);
      return;
    }
    // The screen eases to the new scene's height instead of jumping.
    next.classList.add("on");
    const h1 = screen.offsetHeight;
    if (h0 && h0 !== h1) gsap.fromTo(screen, { height: h0 }, { height: h1, duration: 0.6, ease: "power3.inOut", clearProps: "height" });
    if (prev && prev !== next) {
      gsap.to(prev, { opacity: 0, y: -8, duration: 0.3, ease: "power2.in", onComplete: () => { prev.classList.remove("on"); gsap.set(prev, { clearProps: "all" }); } });
    }
    stage.querySelectorAll(".vis.on").forEach((v) => { if (v !== prev && v !== next) v.classList.remove("on"); });
    next.classList.add("on");
    gsap.fromTo(next, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6, delay: prev ? 0.25 : 0, ease: "power3.out" });
    scene = play(next, prev ? 0.35 : 0.1);
  }

  // Count a number up (tweened as an integer: GSAP rounds fractional tween values).
  function count(tl, el, at, dur = 1.1) {
    const to = Number(el.dataset.count), dec = Number(el.dataset.decimals || 0), sign = el.dataset.sign || "";
    const fmt = (v) => sign + (dec ? (Math.round(v) / 10 ** dec).toFixed(dec) : Math.round(v).toLocaleString("en-US"));
    const o = { v: 0 };
    el.textContent = fmt(0);
    tl.to(o, { v: to, duration: dur, ease: "expo.out", onUpdate: () => { el.textContent = fmt(o.v); } }, at);
  }

  // Wrap each character in a span, for the hash comparison.
  function chars(el) {
    if (!el.dataset.text) el.dataset.text = el.textContent;
    el.innerHTML = [...el.dataset.text].map((c) => `<span class="ch">${c}</span>`).join("");
    return [...el.querySelectorAll(".ch")];
  }

  function play(v, delay) {
    const tl = gsap.timeline({ delay });
    const key = `${v.dataset.dir}-${v.dataset.step}`;
    const q = (sel) => [...v.querySelectorAll(sel)];
    const one = (sel) => v.querySelector(sel);
    const HEX = "0123456789abcdef";

    if (key === "pay-0") {
      const code = one(".s-code");
      tl.fromTo(code, { scrambleText: { text: code.dataset.scramble, chars: HEX + "lnpu", speed: 1 } },
        { duration: 0.9, scrambleText: { text: code.dataset.scramble, chars: HEX + "lnpu", revealDelay: 0.2, speed: 0.8 } }, 0)
        .from(q(".s-rows div"), { opacity: 0, y: 6, stagger: 0.09, duration: 0.5, ease: "power2.out" }, 0.35)
        .from(one(".s-total"), { opacity: 0, duration: 0.5 }, 0.8)
        .from(one(".s-note"), { opacity: 0, duration: 0.6 }, 1.3);
      count(tl, one(".s-total b"), 0.8, 1.2);
    } else if (key === "pay-1") {
      q("[data-redact]").forEach((dd) => { dd.textContent = dd.dataset.redact; dd.classList.remove("redacted"); });
      tl.from(q(".s-rows div"), { opacity: 0, y: 6, stagger: 0.08, duration: 0.45, ease: "power2.out" }, 0);
      q("[data-redact]").forEach((dd, k) => {
        tl.to(dd, { duration: 0.7, ease: "none", onStart: () => dd.classList.add("redacted"),
          scrambleText: { text: "█".repeat(Math.min(16, dd.dataset.redact.length)), chars: "█▓▒░", speed: 0.6 } }, 0.8 + k * 0.18);
      });
      tl.from(one(".s-line"), { opacity: 0, duration: 0.6 }, 1.6);
    } else if (key === "pay-2") {
      count(tl, one(".s-total b"), 0, 1.1);
      const a = chars(one(".h-a")), b = chars(one(".h-b"));
      tl.from(q(".s-rows div"), { opacity: 0, y: 6, stagger: 0.09, duration: 0.45 }, 0.3);
      // Compare the two hashes, character by character.
      a.forEach((c, k) => {
        tl.add(() => { c.classList.add("ok"); b[k].classList.add("ok"); }, 1.0 + k * 0.035);
      });
      tl.from(one(".s-verdict"), { opacity: 0, y: 4, duration: 0.5 }, 1.0 + a.length * 0.035)
        .from(one(".s-line"), { opacity: 0, duration: 0.6 }, ">0.1");
    } else if (key === "get-0") {
      tl.from(one(".s-code"), { opacity: 0, duration: 0.5 }, 0)
        .from(one(".s-invoice"), { opacity: 0, y: 10, duration: 0.6, ease: "power3.out" }, 0.3)
        .from(one(".qr-mini"), { opacity: 0, scale: 0.94, duration: 0.6, ease: "power3.out" }, 0.4)
        .from(one(".s-note"), { opacity: 0, duration: 0.6 }, 1.0);
      count(tl, one(".s-total b"), 0.5, 1);
    } else if (key === "get-1") {
      const hop = one(".hop"), route = one(".route");
      tl.from(q(".s-rows div"), { opacity: 0, y: 6, stagger: 0.09, duration: 0.45 }, 0)
        .from(one(".s-note"), { opacity: 0, duration: 0.6 }, 0.7);
      // The payment hops node to node, then starts over.
      const run = gsap.timeline({ repeat: -1, repeatDelay: 0.7 });
      const span = () => route.clientWidth - hop.offsetWidth;
      run.set(hop, { x: 0, opacity: 1 });
      for (let k = 1; k <= 3; k++) run.to(hop, { x: () => (span() * k) / 3, duration: 0.45, ease: "power2.inOut" }, ">0.15");
      run.to(hop, { opacity: 0, duration: 0.3 }, ">0.2");
      tl.add(run, 0.6);
    } else if (key === "get-2") {
      const memo = one("[data-decrypt]");
      count(tl, one(".s-total b"), 0, 1.1);
      tl.from(q(".s-rows div"), { opacity: 0, y: 6, stagger: 0.09, duration: 0.45 }, 0.3)
        .fromTo(memo, { scrambleText: { text: "█".repeat(24), chars: "█▓▒░" } },
          { duration: 1.5, scrambleText: { text: memo.dataset.decrypt, chars: "█▓▒░", revealDelay: 0.3, speed: 0.5 } }, 0.6)
        .from(one(".s-note"), { opacity: 0, duration: 0.6 }, 1.4);
    }
    return tl;
  }

  // End state without animation (reduced motion, no GSAP).
  function settle(v) {
    if (!v) return;
    v.querySelectorAll("[data-redact]").forEach((el) => { el.textContent = "█".repeat(Math.min(16, el.dataset.redact.length)); el.classList.add("redacted"); });
    v.querySelectorAll(".h-a, .h-b").forEach((el) => chars(el).forEach((c) => c.classList.add("ok")));
  }

  function setDir(d) {
    if (d === dir) return;
    dir = d;
    stage.dataset.dir = d;
    toggle.dataset.active = d;
    toggle.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.dir === d)));
    stage.querySelectorAll(".vis.on, .vis.cur").forEach((v) => { v.classList.remove("on", "cur"); if (hasGsap) gsap.set(v, { clearProps: "all" }); });
    const cur = Math.max(step, 0);
    step = -1;
    show(cur, true);
  }
  toggle.addEventListener("click", (e) => { const b = e.target.closest("button[data-dir]"); if (b) setDir(b.dataset.dir); });

  if (!hasGsap) { arrived = true; show(0, true); return; }

  gsap.from(".hiw .sec-head > *", { opacity: 0, y: 24, filter: "blur(8px)", stagger: 0.12, duration: 1.1, ease: "expo.out", clearProps: "filter",
    scrollTrigger: { trigger: ".hiw .sec-head", start: "top 85%" } });

  // The screen stays empty and hidden until the section arrives; then it rises in and
  // step 01 plays. (Fixes seeing the finished scene before reaching the section.)
  gsap.set(visual, { autoAlpha: 0, y: 40 });
  ScrollTrigger.create({
    trigger: stage, start: "top 62%", once: true,
    onEnter: () => {
      arrived = true;
      gsap.to(visual, { autoAlpha: 1, y: 0, duration: reduce ? 0 : 1, ease: "expo.out" });
      show(0, true);
    },
  });

  // Steps become active as they cross the reading line.
  const mm = gsap.matchMedia();
  const stepTriggers = (line) => steps.map((s, i) => ScrollTrigger.create({
    trigger: s, start: `top ${line}`, end: `bottom ${line}`,
    onToggle: (self) => { if (self.isActive) show(i); },
  }));

  mm.add("(min-width: 901px)", () => {
    const triggers = stepTriggers("55%");
    const rightX = () => stage.clientWidth - visual.offsetWidth;
    // The path: hold left through 01, glide right into 02, glide back left into 03.
    // A slight arc, tilt and depth while it travels; scrubbed to the scroll with a little lag.
    const path = gsap.timeline({
      defaults: { ease: "power2.inOut" },
      scrollTrigger: { trigger: list, start: "top 55%", end: "bottom 55%", scrub: reduce ? true : 1.2, invalidateOnRefresh: true,
        onUpdate: (self) => list.style.setProperty("--fill", self.progress.toFixed(4)) },
    });
    path.set(visual, { x: 0 }, 0)
      .to(visual, { x: rightX, duration: 1 }, 0.5)
      .to(visual, { keyframes: { y: [0, -26, 0], rotation: [0, -1.2, 0], scale: [1, 0.965, 1] }, duration: 1, ease: "none" }, 0.5)
      .to(visual, { x: 0, duration: 1 }, 1.5)
      .to(visual, { keyframes: { y: [0, -26, 0], rotation: [0, 1.2, 0], scale: [1, 0.965, 1] }, duration: 1, ease: "none" }, 1.5)
      .to({}, { duration: 0.5 }, 2.5);
    return () => { triggers.forEach((t) => t.kill()); gsap.set(visual, { x: 0, rotation: 0, scale: 1 }); };
  });

  mm.add("(max-width: 900px)", () => {
    const triggers = stepTriggers("78%");
    const fill = ScrollTrigger.create({ trigger: list, start: "top 78%", end: "bottom 78%", scrub: true,
      onUpdate: (self) => list.style.setProperty("--fill", self.progress.toFixed(4)) });
    return () => { triggers.forEach((t) => t.kill()); fill.kill(); };
  });
})();
