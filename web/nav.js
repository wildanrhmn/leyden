"use strict";

// Shared navbar: the mobile menu.
(() => {
  const nav = document.querySelector("[data-nav]");
  if (!nav) return;
  const burger = nav.querySelector(".burger");
  const menu = nav.querySelector(".nav-links");

  const setOpen = (open) => {
    nav.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  burger.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("open")) { setOpen(false); burger.focus(); }
  });
  matchMedia("(min-width: 861px)").addEventListener("change", (m) => { if (m.matches) setOpen(false); });
})();
