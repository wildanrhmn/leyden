"use strict";

// Footer: a charge of amber light passes over the wordmark once when it scrolls in, then
// follows the cursor (mouse only) while it is over the footer.
(() => {
  const foot = document.querySelector(".foot");
  const lit = foot && foot.querySelector(".foot-mark .lit");
  if (!lit || !window.gsap || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  gsap.registerPlugin(ScrollTrigger);

  // x and y are percentages of the wordmark's box; a is the glow's opacity.
  const glow = { x: -25, y: 45, a: 0 };
  const apply = () => {
    lit.style.setProperty("--x", `${glow.x}%`);
    lit.style.setProperty("--y", `${glow.y}%`);
    lit.style.setProperty("--glow", glow.a);
  };
  const size = () => lit.style.setProperty("--r", `${Math.round(lit.offsetHeight * 0.75)}px`);
  size();
  addEventListener("resize", size);

  gsap.from(".foot-cta > *", { opacity: 0, y: 24, filter: "blur(8px)", stagger: 0.12, duration: 1.1, ease: "expo.out", clearProps: "filter",
    scrollTrigger: { trigger: ".foot-cta", start: "top 85%", once: true } });

  ScrollTrigger.create({
    trigger: ".foot-mark", start: "top 98%", once: true,
    onEnter: () => gsap.timeline({ onUpdate: apply })
      .to(glow, { a: 1, duration: 0.5, ease: "power1.out" }, 0)
      .fromTo(glow, { x: -25 }, { x: 125, duration: 2.6, ease: "power2.inOut" }, 0)
      .to(glow, { a: 0, duration: 0.6, ease: "power1.in" }, 2.1),
  });

  foot.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    const r = lit.getBoundingClientRect();
    gsap.to(glow, { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, a: 1,
      duration: 0.7, ease: "power3.out", overwrite: "auto", onUpdate: apply });
  });
  foot.addEventListener("pointerleave", () => {
    gsap.to(glow, { a: 0, duration: 0.9, ease: "power2.out", overwrite: "auto", onUpdate: apply });
  });
})();
