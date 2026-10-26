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
  let current = null;

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
    current = next;
    // Revert (not just kill) an interrupted scene: from() tweens would otherwise leave
    // its elements stuck at their invisible start state, and the next replay animates from 0 to 0.
    if (scene) { scene.revert(); scene = null; }

    const screen = visual.querySelector(".screen");
    // Measure where the height is right now (possibly mid-animation), then drop any
    // running height tween and its inline leftover before laying out the next scene.
    const h0 = screen.offsetHeight;
    if (hasGsap) { gsap.killTweensOf(screen); gsap.set(screen, { clearProps: "height" }); }
    stage.querySelectorAll(".vis.cur").forEach((v) => v.classList.remove("cur"));
    next.classList.add("cur");

    if (!hasGsap || reduce) {
      stage.querySelectorAll(".vis").forEach((v) => v.classList.toggle("on", v === next));
      settle(next);
      return;
    }
    // Cancel anything still fading this scene out (scrolling back quickly must not blank it).
    gsap.killTweensOf(next);
    next.classList.add("on");
    // The screen eases to the new scene's height instead of jumping.
    const h1 = screen.offsetHeight;
    if (h0 > 40 && Math.abs(h0 - h1) > 1) gsap.fromTo(screen, { height: h0 }, { height: h1, duration: 0.6, ease: "power3.inOut", clearProps: "height" });
    // Every other scene fades out; only a scene that is no longer current may hide itself.
    stage.querySelectorAll(".vis.on").forEach((v) => {
      if (v === next) return;
      gsap.killTweensOf(v);
      gsap.to(v, { opacity: 0, y: -8, duration: 0.3, ease: "power2.in", onComplete: () => {
        if (v !== current) { v.classList.remove("on"); gsap.set(v, { clearProps: "opacity,transform" }); }
      } });
    });
    gsap.fromTo(next, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6, delay: prev && prev !== next ? 0.25 : 0, ease: "power3.out" });
    scene = play(next, prev && prev !== next ? 0.35 : 0.1);
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
    const nums = q("[data-count]");

    if (key === "pay-0") {
      // 1,000 sat appears, a line draws down, and the ZEC amount counts up beneath it.
      const [top, bottom] = q(".conv");
      tl.from(top, { opacity: 0, y: 10, duration: 0.6, ease: "power3.out" }, 0)
        .fromTo(one(".conv-link i"), { scaleY: 0 }, { scaleY: 1, duration: 0.6, ease: "power2.inOut" }, 0.55)
        .from(bottom, { opacity: 0, y: 10, duration: 0.6, ease: "power3.out" }, 1.0);
      count(tl, nums[0], 0.05, 0.9);
      count(tl, nums[1], 1.05, 1.2);
    } else if (key === "pay-1") {
      // Readable values that then dissolve, character by character, the way the memo in
      // "Get paid" step 03 resolves, only in reverse: all a chain observer is left with.
      q("[data-redact]").forEach((el) => { el.textContent = el.dataset.redact; el.classList.remove("redacted"); });
      tl.from(q(".cv-node"), { opacity: 0, y: 8, stagger: 0.07, duration: 0.4, ease: "power3.out" }, 0)
        .from(q(".cv-wire"), { scaleX: 0, transformOrigin: "left", stagger: 0.07, duration: 0.35 }, 0.1);
      q("[data-redact]").forEach((el, k) => {
        tl.fromTo(el, { scrambleText: { text: el.dataset.redact } },
          { duration: 0.9, ease: "none", onStart: () => el.classList.add("redacted"),
            scrambleText: { text: "█".repeat(el.dataset.redact.length), chars: "█▓▒░", revealDelay: 0.15, speed: 0.5 } }, 0.5 + k * 0.08);
      });
      tl.from(one(".cap"), { opacity: 0, duration: 0.5 }, 1.2);
    } else if (key === "pay-2") {
      // Paid, then the proof: two hashes that match, character by character.
      count(tl, nums[0], 0, 0.9);
      tl.from(one(".paid-word"), { opacity: 0, x: -6, duration: 0.4 }, 0.6)
        .from(q(".hashpair > *"), { opacity: 0, y: 6, stagger: 0.08, duration: 0.45 }, 0.4);
      const a = chars(one(".h-a")), b = chars(one(".h-b"));
      a.forEach((c, k) => tl.add(() => { c.classList.add("ok"); b[k].classList.add("ok"); }, 1.0 + k * 0.05));
    } else if (key === "get-0") {
      tl.from(one(".qr-big"), { opacity: 0, scale: 0.92, duration: 0.7, ease: "power3.out" }, 0)
        .from(one(".big-num"), { opacity: 0, y: 8, duration: 0.5 }, 0.35)
        .from(one(".cap"), { opacity: 0, duration: 0.6 }, 0.8);
      count(tl, nums[0], 0.35, 0.9);
    } else if (key === "get-1") {
      const hop = one(".hop"), hops = one(".hops");
      tl.from(q(".route-wide > *"), { opacity: 0, y: 6, stagger: 0.12, duration: 0.5 }, 0)
        .from(one(".cap"), { opacity: 0, duration: 0.6 }, 0.6);
      // The payment hops node to node, then starts over.
      const span = () => hops.clientWidth - hop.offsetWidth;
      const run = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
      run.set(hop, { x: 0, opacity: 1 });
      for (let k = 1; k <= 3; k++) run.to(hop, { x: () => (span() * k) / 3, duration: 0.5, ease: "power2.inOut" }, ">0.12");
      run.to(hop, { opacity: 0, duration: 0.3 }, ">0.25");
      tl.add(run, 0.5);
    } else if (key === "get-2") {
      const memo = one("[data-decrypt]");
      tl.from(one(".conv"), { opacity: 0, y: 10, duration: 0.6, ease: "power3.out" }, 0)
        .from(memo, { opacity: 0, duration: 0.4 }, 0.5)
        .fromTo(memo, { scrambleText: { text: "█".repeat(memo.dataset.decrypt.length), chars: "█▓▒░" } },
          { duration: 1.6, scrambleText: { text: memo.dataset.decrypt, chars: "█▓▒░", revealDelay: 0.3, speed: 0.5 } }, 0.5);
      count(tl, nums[0], 0.05, 1.1);
    }
    return tl;
  }

  // End state without animation (reduced motion, no GSAP).
  function settle(v) {
    if (!v) return;
    v.querySelectorAll("[data-redact]").forEach((el) => { el.textContent = "█".repeat(el.dataset.redact.length); el.classList.add("redacted"); });
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
