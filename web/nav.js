"use strict";

// Shared navbar: the animated mobile menu, and smooth scrolling for same-page links.
(() => {
  const nav = document.querySelector("[data-nav]");
  if (!nav) return;
  const burger = nav.querySelector(".burger");
  const menu = nav.querySelector(".nav-links");

  // A scrim behind the open menu: dims the page and closes the menu when tapped.
  const scrim = document.createElement("div");
  scrim.className = "nav-scrim";
  nav.after(scrim);

  const setOpen = (open) => {
    nav.classList.toggle("open", open);
    document.documentElement.classList.toggle("menu-open", open);
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  burger.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
  scrim.addEventListener("click", () => setOpen(false));
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("open")) { setOpen(false); burger.focus(); }
  });
  matchMedia("(min-width: 861px)").addEventListener("change", (m) => { if (m.matches) setOpen(false); });

  // Same-page links glide to their section instead of jumping. The glide eases in and out,
  // takes longer for longer distances, and stops the moment the visitor scrolls themselves.
  document.addEventListener("click", (e) => {
    const link = e.target.closest('a[href*="#"]');
    if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const url = new URL(link.href, location.href);
    if (url.pathname !== location.pathname || !url.hash) return;
    const target = document.querySelector(url.hash);
    if (!target) return;
    e.preventDefault();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const y = target.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(target).scrollMarginTop) || 0);
    if (window.gsap && window.ScrollToPlugin && !reduce) {
      gsap.registerPlugin(ScrollToPlugin);
      const duration = Math.min(1.8, 0.7 + Math.abs(y - scrollY) / 2600);
      gsap.to(window, { duration, ease: "power3.inOut", scrollTo: { y, autoKill: true } });
    } else {
      window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
    }
    history.pushState(null, "", url.hash);
  });
})();
