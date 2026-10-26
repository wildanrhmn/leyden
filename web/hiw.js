"use strict";

// "How it works". On wide screens the section pins while you scroll: the screen glides
// left, right, left and each step's text takes the opposite side. On phones the screen
// sticks at the top and steps scroll beneath it. Scenes use real data from the
// recorded mainnet runs (docs/mainnet-runs.md).
(() => {
  const section = document.querySelector(".hiw");
  const stage = section && section.querySelector(".hiw-stage");
  if (!stage) return;
  const pinEl = section.querySelector(".hiw-pin");
  const visual = stage.querySelector(".hiw-visual");
  const steps = [...stage.querySelectorAll(".step")];
  const dots = [...stage.querySelectorAll(".hiw-dots button")];
  const toggle = section.querySelector(".dir-toggle");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = !!window.gsap;
  if (hasGsap) gsap.registerPlugin(ScrollTrigger, ScrambleTextPlugin);

  let dir = "pay";
  let step = -1;
  let scene = null;
  let wide = false;
  let pinST = null;

  // Text sits opposite the screen: screen left on 01 and 03, right on 02.
  steps.forEach((s, i) => { s.dataset.side = i % 2 === 0 ? "right" : "left"; });

  for (const el of stage.querySelectorAll("[data-qr]")) {
    if (!window.qrcode) break;
    const q = qrcode(0, "L");
    q.addData(el.dataset.qr);
    q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }

  const visFor = (d, i) => stage.querySelector(`.vis[data-dir="${d}"][data-step="${i}"]`);
  const screenX = (i) => (i % 2 === 0 ? 0 : stage.clientWidth - visual.offsetWidth);

  function show(i, force) {
    if (i === step && !force) return;
    const prevStep = step;
    const prev = prevStep >= 0 ? visFor(dir, prevStep) : null;
    step = i;
    const next = visFor(dir, i);
    if (scene) { scene.kill(); scene = null; }
    dots.forEach((d, k) => d.classList.toggle("on", k === i));

    if (!hasGsap || reduce) {
      steps.forEach((s, k) => s.classList.toggle("on", k === i));
      stage.querySelectorAll(".vis").forEach((v) => v.classList.toggle("on", v === next));
      if (wide && hasGsap) gsap.set(visual, { x: screenX(i) });
      finalState(next);
      return;
    }

    // Step text: the new one slides in from its own side.
    steps.forEach((s, k) => {
      if (k === i) {
        s.classList.add("on");
        if (wide) {
          const from = s.dataset.side === "right" ? 48 : -48;
          gsap.fromTo(s, { x: from, opacity: 0, filter: "blur(10px)" }, { x: 0, opacity: 1, filter: "blur(0px)", duration: 0.9, delay: prevStep < 0 ? 0 : 0.35, ease: "expo.out", clearProps: "filter" });
        }
      } else if (s.classList.contains("on")) {
        if (wide) gsap.to(s, { opacity: 0, duration: 0.3, onComplete: () => s.classList.remove("on") });
        else s.classList.remove("on");
      }
    });

    // The screen glides to its side.
    if (wide) gsap.to(visual, { x: screenX(i), duration: prevStep < 0 ? 0 : 1.1, ease: "expo.inOut" });

    // Scene crossfade.
    if (prev && prev !== next) {
      gsap.to(prev, { opacity: 0, scale: 0.98, filter: "blur(6px)", duration: 0.35, ease: "power2.in", onComplete: () => { prev.classList.remove("on"); gsap.set(prev, { clearProps: "all" }); } });
    }
    stage.querySelectorAll(".vis.on").forEach((v) => { if (v !== prev && v !== next) v.classList.remove("on"); });
    next.classList.add("on");
    gsap.fromTo(next, { opacity: 0, scale: 0.98, filter: "blur(8px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.7, delay: prev ? 0.3 : 0, ease: "expo.out", clearProps: "filter,scale" });
    scene = play(next, prev ? 0.4 : 0.15);
  }

  // Counts a number up inside an element, keeping its <small> unit. Values are tweened as
  // integers (zatoshis or sats) because GSAP rounds fractional tween values.
  function count(tl, el, toInt, decimals, at, dur = 1.1) {
    const o = { v: 0 };
    const fmt = (v) => (decimals ? (Math.round(v) / 10 ** decimals).toFixed(decimals) : Math.round(v).toLocaleString("en-US"));
    const prefix = el.firstChild.nodeValue.trim().startsWith("+") ? "+" : "";
    el.firstChild.nodeValue = prefix + fmt(0) + " ";
    tl.to(o, { v: toInt, duration: dur, ease: "expo.out", onUpdate: () => { el.firstChild.nodeValue = prefix + fmt(o.v) + " "; } }, at);
  }

  function play(v, delay) {
    const tl = gsap.timeline({ delay });
    const key = `${v.dataset.dir}-${v.dataset.step}`;
    const q = (sel) => [...v.querySelectorAll(sel)];
    const one = (sel) => v.querySelector(sel);

    if (key === "pay-0") {
      const panels = q(".panel");
      const inv = one(".inv-str");
      inv.dataset.text ||= inv.textContent;
      tl.from(panels[0], { opacity: 0, y: -14, scale: 1.03, filter: "blur(6px)", duration: 0.7, ease: "expo.out", clearProps: "filter" }, 0)
        .fromTo(inv, { scrambleText: { text: inv.dataset.text, chars: "0123456789abcdefghijklmnopqrstuvwxyz", speed: 1 } },
          { duration: 0.8, scrambleText: { text: inv.dataset.text, chars: "0123456789abcdefghijklmnopqrstuvwxyz", revealDelay: 0.2, speed: 0.9 } }, 0.1)
        .from(q(".kv div"), { opacity: 0, y: 8, stagger: 0.08, duration: 0.5, ease: "power2.out" }, 0.5)
        .from(one(".flow-arrow"), { opacity: 0, scale: 0.6, duration: 0.45, ease: "back.out(2)" }, 0.85)
        .from(panels[1], { opacity: 0, y: 18, duration: 0.8, ease: "expo.out" }, 1.0)
        .from(q(".quote-panel .to > *"), { opacity: 0, y: 6, stagger: 0.07, duration: 0.45 }, 1.4);
      count(tl, one(".quote-panel .amt"), 67778, 8, 1.05);
    } else if (key === "pay-1") {
      q("[data-redact]").forEach((dd) => { dd.textContent = dd.dataset.redact; dd.classList.remove("redacted"); });
      tl.from(one(".tx-head"), { opacity: 0, y: 10, duration: 0.6, ease: "expo.out" }, 0)
        .from(q(".ledger div"), { opacity: 0, x: -10, stagger: 0.07, duration: 0.5, ease: "power2.out" }, 0.15);
      q("[data-redact]").forEach((dd, k) => {
        tl.to(dd, {
          duration: 0.8,
          scrambleText: { text: "█".repeat(Math.min(16, dd.dataset.redact.length)), chars: "█▓▒░", speed: 0.6 },
          ease: "none",
          onStart: () => dd.classList.add("redacted"),
        }, 0.9 + k * 0.16);
      });
      tl.from(q(".tiles div"), { opacity: 0, y: 12, stagger: 0.09, duration: 0.6, ease: "expo.out" }, 1.5);
    } else if (key === "pay-2") {
      tl.fromTo(one(".ring-fg"), { strokeDashoffset: 183 }, { strokeDashoffset: 0, duration: 0.9, ease: "power3.inOut" }, 0)
        .fromTo(one(".ring-check"), { strokeDashoffset: 36 }, { strokeDashoffset: 0, duration: 0.45, ease: "power2.out" }, 0.75)
        .from(one(".paid-hero .lbl"), { opacity: 0, x: -8, duration: 0.5 }, 0.2)
        .from(one(".proof"), { opacity: 0, y: 14, duration: 0.7, ease: "expo.out" }, 0.7);
      count(tl, one(".paid-hero .amt"), 1000, 0, 0.25);
      const pre = one("[data-scramble]");
      tl.fromTo(pre, { scrambleText: { text: pre.dataset.scramble, chars: "0123456789abcdef", speed: 1 } },
        { duration: 1, scrambleText: { text: pre.dataset.scramble, chars: "0123456789abcdef", revealDelay: 0.25, speed: 0.8 } }, 0.8)
        .from(one(".verified"), { opacity: 0, x: -6, duration: 0.5 }, 1.7)
        .from(q(".tiles div"), { opacity: 0, y: 12, stagger: 0.1, duration: 0.6, ease: "expo.out" }, 1.4);
    } else if (key === "get-0") {
      tl.from(one(".addr-row"), { opacity: 0, y: -12, duration: 0.7, ease: "expo.out" }, 0)
        .from(one(".inv-card"), { opacity: 0, y: 16, duration: 0.8, ease: "expo.out" }, 0.4)
        .from(one(".qr-mini"), { scale: 0.85, opacity: 0, duration: 0.7, ease: "back.out(1.7)" }, 0.55)
        .from(q(".inv-meta > *"), { opacity: 0, x: 8, stagger: 0.07, duration: 0.45 }, 0.7);
      count(tl, one(".inv-meta .amt"), 600, 0, 0.7, 0.9);
    } else if (key === "get-1") {
      const lines = q(".fan-lines path");
      lines.forEach((p) => { const L = p.getTotalLength(); gsap.set(p, { strokeDasharray: L, strokeDashoffset: L }); });
      tl.from(q(".fan-wallets rect, .fan-wallets text"), { opacity: 0, x: -10, stagger: 0.05, duration: 0.45 }, 0)
        .to(lines, { strokeDashoffset: 0, stagger: 0.08, duration: 0.8, ease: "power2.inOut" }, 0.3)
        .from(one(".fan-node"), { opacity: 0, scale: 0.7, transformOrigin: "50% 50%", duration: 0.6, ease: "back.out(2)" }, 0.8);
      q(".fan-pulses path").forEach((p, k) => {
        const L = p.getTotalLength();
        tl.fromTo(p, { strokeDashoffset: 22 }, { strokeDashoffset: -L, duration: 1.3, ease: "power1.in", repeat: -1, repeatDelay: 1.2 }, 1 + k * 0.35);
      });
      tl.from(one(".foot"), { opacity: 0, duration: 0.6 }, 0.9);
    } else if (key === "get-2") {
      const memo = one("[data-decrypt]");
      tl.from(one(".notif"), { opacity: 0, y: -22, scale: 0.97, duration: 0.8, ease: "expo.out" }, 0)
        .from(one(".memo"), { opacity: 0, y: 12, duration: 0.7, ease: "expo.out" }, 0.45)
        .fromTo(memo, { scrambleText: { text: "█".repeat(26), chars: "█▓▒░" } },
          { duration: 1.6, scrambleText: { text: memo.dataset.decrypt, chars: "█▓▒░", revealDelay: 0.35, speed: 0.5 } }, 0.7)
        .from(q(".tiles div"), { opacity: 0, y: 12, stagger: 0.1, duration: 0.6, ease: "expo.out" }, 1.2)
        .from(one(".foot"), { opacity: 0, duration: 0.6 }, 1.6);
      count(tl, one(".notif .amt"), 24321, 8, 0.15);
    }
    return tl;
  }

  function finalState(v) {
    if (!v) return;
    v.querySelectorAll("[data-redact]").forEach((el) => { el.textContent = "█".repeat(Math.min(16, el.dataset.redact.length)); el.classList.add("redacted"); });
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
  }
  toggle.addEventListener("click", (e) => { const b = e.target.closest("button[data-dir]"); if (b) setDir(b.dataset.dir); });

  // Dots jump to a step within the pinned scroll range.
  dots.forEach((d, k) => d.addEventListener("click", () => {
    if (!pinST) return show(k);
    const y = pinST.start + ((k + 0.15) / 3) * (pinST.end - pinST.start);
    window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
  }));

  if (!hasGsap) { show(0, true); return; }

  gsap.from(".hiw .sec-head > *", { opacity: 0, y: 24, filter: "blur(8px)", stagger: 0.12, duration: 1.1, ease: "expo.out", clearProps: "filter",
    scrollTrigger: { trigger: ".hiw .sec-head", start: "top 85%" } });

  const mm = gsap.matchMedia();
  mm.add("(min-width: 901px)", () => {
    wide = true;
    step = -1;
    steps.forEach((s) => s.classList.remove("on"));
    show(0, true);
    pinST = ScrollTrigger.create({
      trigger: pinEl, start: "top top", end: () => "+=" + Math.round(innerHeight * 2.4), pin: true, anticipatePin: 1,
      onEnter: () => { if (step === 0 && !reduce) show(0, true); }, // replay 01 when the section arrives
      onUpdate: (self) => {
        const p = self.progress * 3;
        show(Math.min(2, Math.floor(p * 0.9999)));
        dots.forEach((d, k) => d.querySelector("i").style.setProperty("--p", Math.max(0, Math.min(1, p - k)).toFixed(3)));
      },
    });
    const onResize = () => { if (step >= 0) gsap.set(visual, { x: screenX(step) }); };
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      wide = false;
      pinST = null;
      gsap.set([visual, ...steps], { clearProps: "all" });
      step = -1;
    };
  });
  mm.add("(max-width: 900px)", () => {
    wide = false;
    const triggers = steps.map((s, i) => ScrollTrigger.create({
      trigger: s, start: "top 78%", end: "bottom 78%",
      onToggle: (self) => { if (self.isActive) show(i); },
    }));
    // Visible from the start in its finished state; the scene plays when step 01 scrolls into view.
    const v0 = visFor(dir, 0);
    v0.classList.add("on");
    finalState(v0);
    steps[0].classList.add("on");
    return () => triggers.forEach((t) => t.kill());
  });
})();
