"use strict";

// Ambient fluid behind the landing page and the app, on a fixed full-screen canvas.
//
// This follows the approach of React Bits' LiquidEther (the effect on katana.network), ported
// to plain WebGL2: a stable-fluids velocity solver (BFECC advection, a soft circular force
// brush, Jacobi pressure projection) where each pixel is coloured by how fast the fluid moves
// there, mapped onto a short blue palette. There is no dye: the streaks are the flow itself,
// which is why they stretch tall and change width as they curl.
//
// The cursor drives the brush. 350 ms after it stops, an auto-pilot takes over: one point
// gliding at constant speed, turning smoothly toward random targets. Moving the mouse again
// eases control back over 0.25 s. Without WebGL2, the hero keeps a static CSS glow.
(() => {
  const canvas = document.getElementById("fluid");
  const hero = document.querySelector(".hero"); // landing page only
  if (!canvas) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gl = !reduce && canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) { hero?.classList.add("no-fluid"); return; }

  // Katana's settings, kept as-is.
  const CFG = {
    resolution: 0.5,        // simulation grid, as a fraction of the canvas's CSS size
    mouseForce: 15,
    cursorSize: 300,        // brush size, in simulation cells
    dt: 0.011,
    iterationsPoisson: 38,
    dissipation: 0.992,
    autoSpeed: 0.28,        // auto-pilot speed, in screen-widths (NDC) per second
    autoIntensity: 6.4,     // how much harder the auto-pilot pushes than the same mouse motion
    takeoverDuration: 0.25,
    autoResumeDelay: 350,
    autoRampDuration: 1.4,
  };
  // Speed is mapped onto this gradient (slow → fast): Katana's own indigo-to-blue.
  const PALETTE = ["#1b2fbf", "#1b2fbf", "#0059bf"];
  const BG = [5 / 255, 6 / 255, 10 / 255];

  // --- Shaders -------------------------------------------------------------------------
  const FULL_VS = `#version 300 es
in vec2 aPos; out vec2 uv;
void main(){ uv = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }`;
  const BRUSH_VS = `#version 300 es
in vec2 aPos; uniform vec2 center, scale, px; out vec2 vUv;
void main(){ vec2 pos = aPos * .5 * scale * 2. * px + center; vUv = aPos * .5 + .5; gl_Position = vec4(pos, 0., 1.); }`;
  const FS = (body) => `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 uv; in vec2 vUv; out vec4 o;
${body}`;

  const SRC = {
    // BFECC advection: trace back, forward again, correct half the error, trace back once more.
    advect: [FULL_VS, FS(`uniform sampler2D velocity; uniform float dt, dissipation; uniform vec2 fboSize;
void main(){
  vec2 ratio = max(fboSize.x, fboSize.y) / fboSize;
  vec2 v0 = texture(velocity, uv).xy;
  vec2 back = uv - v0 * dt * ratio;
  vec2 v1 = texture(velocity, back).xy;
  vec2 err = (back + v1 * dt * ratio) - uv;
  vec2 fixedUv = uv - err / 2.;
  vec2 v2 = texture(velocity, fixedUv).xy;
  o = vec4(texture(velocity, fixedUv - v2 * dt * ratio).xy * dissipation, 0., 0.);
}`)],
    // The brush: a soft disc of force, (1 - r)², added on top of the velocity.
    brush: [BRUSH_VS, FS(`uniform vec2 force;
void main(){ vec2 c = (vUv - .5) * 2.; float d = 1. - min(length(c), 1.); d *= d; o = vec4(force * d, 0., 1.); }`)],
    divergence: [FULL_VS, FS(`uniform sampler2D velocity; uniform vec2 px; uniform float dt;
void main(){
  float x0 = texture(velocity, uv - vec2(px.x, 0.)).x, x1 = texture(velocity, uv + vec2(px.x, 0.)).x;
  float y0 = texture(velocity, uv - vec2(0., px.y)).y, y1 = texture(velocity, uv + vec2(0., px.y)).y;
  o = vec4((x1 - x0 + y1 - y0) / 2. / dt);
}`)],
    poisson: [FULL_VS, FS(`uniform sampler2D pressure, divergence; uniform vec2 px;
void main(){
  float p0 = texture(pressure, uv + vec2(px.x * 2., 0.)).r, p1 = texture(pressure, uv - vec2(px.x * 2., 0.)).r;
  float p2 = texture(pressure, uv + vec2(0., px.y * 2.)).r, p3 = texture(pressure, uv - vec2(0., px.y * 2.)).r;
  o = vec4((p0 + p1 + p2 + p3) / 4. - texture(divergence, uv).r);
}`)],
    project: [FULL_VS, FS(`uniform sampler2D pressure, velocity; uniform vec2 px; uniform float dt;
void main(){
  float p0 = texture(pressure, uv + vec2(px.x, 0.)).r, p1 = texture(pressure, uv - vec2(px.x, 0.)).r;
  float p2 = texture(pressure, uv + vec2(0., px.y)).r, p3 = texture(pressure, uv - vec2(0., px.y)).r;
  o = vec4(texture(velocity, uv).xy - vec2(p0 - p1, p2 - p3) * .5 * dt, 0., 1.);
}`)],
    // Colour by speed. A touch of noise keeps the dark gradients from banding.
    display: [FULL_VS, FS(`uniform sampler2D velocity, palette; uniform vec3 bg; uniform float time;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  float l = clamp(length(texture(velocity, uv).xy), 0., 1.);
  vec3 c = mix(bg, texture(palette, vec2(l, .5)).rgb, l);
  c += (h(gl_FragCoord.xy + fract(time)) - .5) * (2. / 255.);
  o = vec4(c, 1.);
}`)],
  };

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const programs = {};
  for (const [name, [vs, fs]] of Object.entries(SRC)) {
    const p = gl.createProgram();
    // Each fragment shader keeps only the varying its vertex shader writes (uv or vUv).
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, vs === FULL_VS ? fs.replace(" in vec2 vUv;", "") : fs.replace("in vec2 uv; ", "")));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const n = gl.getActiveUniform(p, i).name;
      u[n] = gl.getUniformLocation(p, n);
    }
    programs[name] = { p, u };
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // The palette as a 1-pixel-high texture, sampled with linear filtering like LiquidEther's.
  const paletteTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, paletteTex);
  const pal = new Uint8Array(PALETTE.flatMap((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255)));
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb };
  }

  // vel0 holds the velocity between frames; vel1 is the advected + forced copy.
  let W = 1, H = 1, px = [1, 1], fbo = null;
  function init() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    W = Math.max(1, Math.round(canvas.clientWidth * CFG.resolution));
    H = Math.max(1, Math.round(canvas.clientHeight * CFG.resolution));
    px = [1 / W, 1 / H];
    if (fbo) Object.values(fbo).forEach((t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); });
    fbo = { vel0: target(W, H), vel1: target(W, H), div: target(W, H), p0: target(W, H), p1: target(W, H) };
  }

  let unit = 0;
  function use(name, dst) {
    const prog = programs[name];
    gl.useProgram(prog.p);
    unit = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    if (dst) gl.viewport(0, 0, W, H); else gl.viewport(0, 0, canvas.width, canvas.height);
    return prog.u;
  }
  function tex(loc, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc, unit++);
  }

  // Add one brush stroke of force into vel1 (additive blending), centred in NDC.
  function brush(cx, cy, fx, fy, size = CFG.cursorSize) {
    const rx = size * px[0], ry = size * px[1];
    const x = Math.min(Math.max(cx, -1 + rx + px[0] * 2), 1 - rx - px[0] * 2);
    const y = Math.min(Math.max(cy, -1 + ry + px[1] * 2), 1 - ry - px[1] * 2);
    const u = use("brush", fbo.vel1);
    gl.uniform2f(u.force, fx, fy);
    gl.uniform2f(u.center, x, y);
    gl.uniform2f(u.scale, size, size);
    gl.uniform2fv(u.px, px);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    draw();
    gl.disable(gl.BLEND);
  }

  function step(force) {
    let u = use("advect", fbo.vel1);
    tex(u.velocity, fbo.vel0.tex);
    gl.uniform1f(u.dt, CFG.dt);
    gl.uniform1f(u.dissipation, CFG.dissipation);
    gl.uniform2f(u.fboSize, W, H);
    draw();

    if (force) brush(mouse.x, mouse.y, force[0], force[1]);
    for (const b of bursts.splice(0)) brush(...b);

    u = use("divergence", fbo.div);
    tex(u.velocity, fbo.vel1.tex);
    gl.uniform2fv(u.px, px);
    gl.uniform1f(u.dt, CFG.dt);
    draw();

    // Jacobi iterations, warm-started from last frame's pressure; an even count ends in p0.
    for (let i = 0; i < CFG.iterationsPoisson; i++) {
      const [src, dst] = i % 2 === 0 ? [fbo.p0, fbo.p1] : [fbo.p1, fbo.p0];
      u = use("poisson", dst);
      tex(u.pressure, src.tex);
      tex(u.divergence, fbo.div.tex);
      gl.uniform2fv(u.px, px);
      draw();
    }

    u = use("project", fbo.vel0);
    tex(u.pressure, fbo.p0.tex);
    tex(u.velocity, fbo.vel1.tex);
    gl.uniform2fv(u.px, px);
    gl.uniform1f(u.dt, CFG.dt);
    draw();
  }

  function render(t) {
    const u = use("display", null);
    tex(u.velocity, fbo.vel0.tex);
    tex(u.palette, paletteTex);
    gl.uniform3fv(u.bg, BG);
    gl.uniform1f(u.time, t * 0.001);
    draw();
  }

  // --- The brush position: the cursor, or the auto-pilot -----------------------------
  // All positions are NDC (-1..1, y up), like LiquidEther's.
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, ox: 0, oy: 0, auto: false, take: null };
  let lastUser = performance.now() - CFG.autoResumeDelay;

  addEventListener("pointermove", (e) => {
    const nx = (e.clientX / innerWidth) * 2 - 1, ny = -((e.clientY / innerHeight) * 2 - 1);
    lastUser = performance.now();
    pilot.active = false;
    if (mouse.auto && !mouse.take) {
      // Ease from wherever the auto-pilot was to the cursor, instead of jumping.
      mouse.take = { fx: mouse.x, fy: mouse.y, tx: nx, ty: ny, start: performance.now() };
      mouse.auto = false;
      return;
    }
    mouse.tx = nx;
    mouse.ty = ny;
  }, { passive: true });

  const pilot = { active: false, x: 0, y: 0, tx: 0, ty: 0, hx: 1, hy: 0, last: 0, since: 0 };
  const pickTarget = () => { pilot.tx = (Math.random() * 2 - 1) * 0.8; pilot.ty = (Math.random() * 2 - 1) * 0.8; };
  pickTarget();

  function updatePilot(now) {
    if (now - lastUser < CFG.autoResumeDelay) { pilot.active = false; mouse.auto = false; return; }
    if (!pilot.active) {
      pilot.active = true;
      pilot.x = mouse.x; pilot.y = mouse.y;
      pilot.last = now; pilot.since = now;
      const l = Math.hypot(pilot.tx - pilot.x, pilot.ty - pilot.y) || 1;
      pilot.hx = (pilot.tx - pilot.x) / l; pilot.hy = (pilot.ty - pilot.y) / l;
    }
    mouse.auto = true;
    let dt = (now - pilot.last) / 1000;
    pilot.last = now;
    if (dt > 0.2) dt = 0.016;
    let dx = pilot.tx - pilot.x, dy = pilot.ty - pilot.y;
    if (Math.hypot(dx, dy) < 0.25) { pickTarget(); dx = pilot.tx - pilot.x; dy = pilot.ty - pilot.y; }
    const dl = Math.hypot(dx, dy) || 1;
    // Turn the heading gradually toward the target, so the path curves instead of zig-zagging.
    const k = 1 - Math.exp(-0.8 * dt);
    pilot.hx += (dx / dl - pilot.hx) * k;
    pilot.hy += (dy / dl - pilot.hy) * k;
    const hl = Math.hypot(pilot.hx, pilot.hy) || 1;
    pilot.hx /= hl; pilot.hy /= hl;
    const r = Math.min(1, (now - pilot.since) / (CFG.autoRampDuration * 1000));
    const ramp = r * r * (3 - 2 * r);
    pilot.x = Math.max(-1, Math.min(1, pilot.x + pilot.hx * CFG.autoSpeed * dt * ramp));
    pilot.y = Math.max(-1, Math.min(1, pilot.y + pilot.hy * CFG.autoSpeed * dt * ramp));
    mouse.x = mouse.tx = pilot.x;
    mouse.y = mouse.ty = pilot.y;
  }

  // Returns this frame's force, or null when the brush hasn't moved.
  function updateMouse(now, dt) {
    if (mouse.take) {
      const e = (now - mouse.take.start) / (CFG.takeoverDuration * 1000);
      if (e >= 1) {
        mouse.x = mouse.tx = mouse.take.tx; mouse.y = mouse.ty = mouse.take.ty;
        mouse.ox = mouse.x; mouse.oy = mouse.y;
        mouse.take = null;
        return null;
      }
      const s = e * e * (3 - 2 * e);
      mouse.x = mouse.tx = mouse.take.fx + (mouse.take.tx - mouse.take.fx) * s;
      mouse.y = mouse.ty = mouse.take.fy + (mouse.take.ty - mouse.take.fy) * s;
    } else if (!mouse.auto) {
      const k = 1 - Math.exp(-6 * Math.min(0.05, dt));
      mouse.x += (mouse.tx - mouse.x) * k;
      mouse.y += (mouse.ty - mouse.y) * k;
    }
    let dx = mouse.x - mouse.ox, dy = mouse.y - mouse.oy;
    mouse.ox = mouse.x; mouse.oy = mouse.y;
    if (mouse.auto && !mouse.take) { dx *= CFG.autoIntensity; dy *= CFG.autoIntensity; }
    if (dx === 0 && dy === 0) return null;
    return [(dx / 2) * CFG.mouseForce, (dy / 2) * CFG.mouseForce];
  }

  // A burst from the swap card when the direction flips (the hero card, or the app's card).
  const bursts = [];
  addEventListener("leyden:flip", () => {
    const card = document.getElementById("swapcard") || document.getElementById("card");
    if (!card) return;
    const c = card.getBoundingClientRect();
    const cx = ((c.left + c.width / 2) / innerWidth) * 2 - 1, cy = -(((c.top + c.height / 2) / innerHeight) * 2 - 1);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      bursts.push([cx + Math.cos(a) * 0.08, cy + Math.sin(a) * 0.12, Math.cos(a) * 0.35, Math.sin(a) * 0.35, 90]);
    }
  });

  // --- Loop -----------------------------------------------------------------------------
  let running = false, last = 0;
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
    last = t;
    updatePilot(performance.now());
    step(updateMouse(performance.now(), dt));
    render(t);
    requestAnimationFrame(frame);
  }
  const start = () => { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } };
  const stop = () => { running = false; };

  init();
  let resizeTimer;
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(init, 150); }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();
  hero?.classList.add("has-fluid");
  document.documentElement.classList.add("has-fluid");
})();
