// Runs before first paint: hide the hero pieces that the intro animation reveals,
// unless the visitor prefers reduced motion. landing.css has a timed fallback.
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) document.documentElement.classList.add("motion");
