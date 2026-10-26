"use strict";

// The hero: "the crossing". Shielded value converges into the swap card from the
// left as many faint particles; what leaves on the right is a single clean beam of
// Lightning, with nothing to trace back. Plus the GSAP intro and scroll motion.
(() => {
  const hero = document.querySelector(".hero");
  const canvas = document.getElementById("beam");
  const card = document.getElementById("swapcard");
  const flip = document.getElementById("q-flip");
  if (!hero || !canvas || !card) return;

  const ctx = canvas.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // ignite: how far the beams have extended (0..1); intensity: dims while scrolling away.
  const state = { ignite: reduce ? 1 : 0, intensity: 1, flash: 0 };

  let W = 0, H = 0, y0 = 0, left = 0, right = 0;
  let lanes = [], particles = [], pulses = [];
  let nextPulse = 0, last = 0, running = false;

  const rand = (a, b) => a + Math.random() * (b - a);

  // Geometry from offsets (not bounding boxes), so intro transforms on the card don't move the beam.
  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const shift = (W - hero.clientWidth) / 2; // canvas is 100vw, centred on the hero
    left = card.offsetLeft + shift;
    right = card.offsetLeft + card.offsetWidth + shift;
    y0 = card.offsetTop + flip.offsetTop + flip.offsetHeight / 2;

    const spread = Math.min(H * 0.95, 900);
    lanes = Array.from({ length: 30 }, (_, i) => {
      const t = i / 29 - 0.5;
      return { y: y0 + t * spread, a: 0.035 + (1 - Math.abs(t) * 2) * 0.07 + Math.random() * 0.02 };
    });
    const n = Math.round(Math.min(170, Math.max(40, left / 5)));
    particles = Array.from({ length: n }, () => spawn(true));
  }

  function spawn(anywhere) {
    const lane = lanes[(Math.random() * lanes.length) | 0];
    return { lane, p: anywhere ? Math.random() : 0, v: rand(0.06, 0.16), r: rand(0.5, 1.4), a: rand(0.35, 0.9) };
  }

  // Point along a lane: starts at the left edge on the lane's height, eases into the beam.
  function lanePoint(lane, p) {
    const x = p * left;
    const k = p * p * (3 - 2 * p); // smoothstep
    return [x, lane.y + (y0 - lane.y) * k];
  }

  function draw(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0);
    last = t;
    ctx.clearRect(0, 0, W, H);
    const ig = state.ignite, I = state.intensity * (1 + state.flash * 0.6);
    if (ig <= 0) return;
    ctx.globalCompositeOperation = "lighter";

    // Left: the shielded pool. Faint converging lanes.
    const reach = left * ig;
    for (const lane of lanes) {
      ctx.beginPath();
      ctx.moveTo(left - reach, lanePoint(lane, 1 - ig)[1]);
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        const p = 1 - ig + (ig * i) / steps;
        const [x, y] = lanePoint(lane, p);
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(124, 132, 255, ${lane.a * I})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Particles riding the lanes into the card.
    for (const pt of particles) {
      if (!reduce) {
        pt.p += pt.v * dt;
        if (pt.p >= 1) Object.assign(pt, spawn(false));
      }
      if (pt.p < 1 - ig) continue;
      const [x, y] = lanePoint(pt.lane, pt.p);
      const near = Math.max(0, (pt.p - 0.6) / 0.4); // brighter as it nears the card
      ctx.fillStyle = `rgba(${170 + near * 60}, ${176 + near * 50}, 255, ${pt.a * (0.35 + near * 0.65) * I})`;
      ctx.beginPath();
      ctx.arc(x, y, pt.r * (1 + near * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    // Halo where the shielded side meets the card.
    halo(left, y0, 160, `rgba(110, 120, 255, ${0.22 * I})`);

    // Right: Lightning. One clean beam, no particles.
    const end = right + (W - right) * ig;
    beam(right, end, 18, `rgba(255, 194, 26, ${0.05 * I})`);
    beam(right, end, 6, `rgba(255, 200, 60, ${0.18 * I})`);
    beam(right, end, 1.4, `rgba(255, 228, 150, ${0.9 * I})`);
    halo(right, y0, 150, `rgba(255, 190, 40, ${0.25 * I})`);

    // Pulses: a bright head with a tail, running out along the beam.
    if (!reduce && t > nextPulse && ig > 0.95) {
      pulses.push({ x: right, v: rand(0.9, 1.3) * (W - right) });
      nextPulse = t + rand(1400, 2600);
    }
    for (const pu of pulses) {
      pu.x += pu.v * dt;
      const len = 140;
      const g = ctx.createLinearGradient(pu.x - len, 0, pu.x, 0);
      g.addColorStop(0, "rgba(255, 200, 60, 0)");
      g.addColorStop(1, `rgba(255, 245, 210, ${0.95 * I})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(Math.max(right, pu.x - len), y0);
      ctx.lineTo(Math.min(end, pu.x), y0);
      ctx.stroke();
    }
    pulses = pulses.filter((pu) => pu.x - 140 < W);
    ctx.globalCompositeOperation = "source-over";
  }

  function beam(x1, x2, width, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y0);
    ctx.lineTo(x2, y0);
    ctx.stroke();
  }

  function halo(x, y, r, color) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function loop(t) {
    if (!running) return;
    draw(t);
    requestAnimationFrame(loop);
  }
  function start() {
    if (running || reduce) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
  const stop = () => { running = false; };

  layout();
  if (reduce) draw(0);
  new ResizeObserver(() => { layout(); if (reduce) draw(0); }).observe(hero);
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(hero);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

  // The quote card nudges the beam when you interact with it.
  addEventListener("shieldbolt:pulse", () => { if (!reduce) nextPulse = 0; });
  addEventListener("shieldbolt:flip", () => {
    if (reduce || !window.gsap) return;
    gsap.fromTo(state, { flash: 1 }, { flash: 0, duration: 0.9, ease: "power2.out" });
    nextPulse = 0;
  });

  // --- Intro and scroll ---------------------------------------------------------
  if (reduce || !window.gsap) {
    document.documentElement.classList.add("intro-ready");
    return;
  }
  gsap.registerPlugin(SplitText, ScrollTrigger);

  document.fonts.ready.then(() => {
    const h1 = document.getElementById("hero-title");
    const split = SplitText.create(h1.querySelectorAll(".h-line"), { type: "words,chars" });
    document.documentElement.classList.add("intro-ready");
    gsap.set("[data-reveal]", { opacity: 1 });

    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.to("#fluid", { opacity: 1, duration: 2.4, ease: "power2.inOut" }, 0)
      .to(canvas, { opacity: 1, duration: 1.4, ease: "power2.out" }, 0)
      .to(state, { ignite: 1, duration: 2.4, ease: "expo.inOut" }, 0.15)
      .from(split.chars, { opacity: 0, yPercent: 35, filter: "blur(16px)", duration: 1.5, stagger: 0.024 }, 0.35)
      .from(".hero-sub", { opacity: 0, y: 18, filter: "blur(8px)", duration: 1.3 }, 1.05)
      .from(card, { opacity: 0, y: 56, scale: 0.97, filter: "blur(10px)", duration: 1.7 }, 1.3)
      .from(".proof-link", { opacity: 0, duration: 1.2, ease: "power2.out" }, 1.9)
      .from(".stats > div", { opacity: 0, y: 18, duration: 1.1, stagger: 0.08 }, 1.7)
      .add(() => gsap.set(split.chars, { clearProps: "filter" }));

    // As the hero scrolls away: the copy drifts up and the light dims.
    gsap.timeline({ scrollTrigger: { trigger: hero, start: "top top", end: "bottom 30%", scrub: 0.6 } })
      .to(".hero-copy", { y: -90, opacity: 0.2, ease: "none" }, 0)
      .to(state, { intensity: 0.35, ease: "none" }, 0);
  });
})();
