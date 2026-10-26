"use strict";

// Ambient fluid behind the hero: a small GPU stable-fluids solver (advect, add forces,
// project) in WebGL2. The cursor stirs indigo "smoke"; when the cursor rests, a ghost
// cursor keeps it drifting. Falls back to a static CSS glow without WebGL2.
(() => {
  const canvas = document.getElementById("fluid");
  const hero = document.querySelector(".hero");
  if (!canvas || !hero) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gl = !reduce && canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) { hero.classList.add("no-fluid"); return; }

  const CFG = {
    simRes: 96,          // velocity / pressure grid (short side)
    dyeRes: 224,          // colour grid (short side)
    pressureIters: 22,
    velocityDissipation: 0.972,
    dyeDissipation: 0.986,
    pressureDecay: 0.8,
    splatRadius: 0.024,   // gaussian width, in uv² units
    force: 1700,
    curlStrength: 0,      // left at 0: smooth, Katana-like smoke rather than swirly
    autoSpeed: 0.5,
    idleMs: 1600,
    autoRamp: 1.4,        // seconds for the ghost to fade in after the cursor rests
  };
  // Shield palette: deep indigo, electric blue, a little violet. Scaled down; it accumulates.
  const PALETTE = [[0.16, 0.2, 1.0], [0.08, 0.32, 1.0], [0.34, 0.2, 1.0], [0.12, 0.14, 0.9]];

  // --- GL plumbing -------------------------------------------------------------------
  const VS = `#version 300 es
in vec2 aPos; uniform vec2 texel;
out vec2 vUv, vL, vR, vT, vB;
void main(){ vUv=aPos*.5+.5; vL=vUv-vec2(texel.x,0.); vR=vUv+vec2(texel.x,0.); vT=vUv+vec2(0.,texel.y); vB=vUv-vec2(0.,texel.y); gl_Position=vec4(aPos,0.,1.); }`;
  const FS = (body) => `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB; out vec4 o;
${body}`;

  const SRC = {
    splat: FS(`uniform sampler2D uTarget; uniform float aspect, radius; uniform vec3 color; uniform vec2 point;
void main(){ vec2 p=vUv-point; p.x*=aspect; o=vec4(texture(uTarget,vUv).xyz+exp(-dot(p,p)/radius)*color,1.); }`),
    advect: FS(`uniform sampler2D uVelocity, uSource; uniform vec2 velTexel; uniform float dt, dissipation;
void main(){ vec2 c=vUv-dt*texture(uVelocity,vUv).xy*velTexel; o=vec4(dissipation*texture(uSource,c).xyz,1.); }`),
    divergence: FS(`uniform sampler2D uVelocity;
void main(){ float L=texture(uVelocity,vL).x, R=texture(uVelocity,vR).x, T=texture(uVelocity,vT).y, B=texture(uVelocity,vB).y;
vec2 C=texture(uVelocity,vUv).xy; if(vL.x<0.)L=-C.x; if(vR.x>1.)R=-C.x; if(vT.y>1.)T=-C.y; if(vB.y<0.)B=-C.y;
o=vec4(.5*(R-L+T-B),0.,0.,1.); }`),
    pressure: FS(`uniform sampler2D uPressure, uDivergence;
void main(){ float L=texture(uPressure,vL).x, R=texture(uPressure,vR).x, T=texture(uPressure,vT).x, B=texture(uPressure,vB).x;
o=vec4((L+R+B+T-texture(uDivergence,vUv).x)*.25,0.,0.,1.); }`),
    gradient: FS(`uniform sampler2D uPressure, uVelocity;
void main(){ float L=texture(uPressure,vL).x, R=texture(uPressure,vR).x, T=texture(uPressure,vT).x, B=texture(uPressure,vB).x;
o=vec4(texture(uVelocity,vUv).xy-vec2(R-L,T-B),0.,1.); }`),
    scale: FS(`uniform sampler2D uTexture; uniform float value; void main(){ o=value*texture(uTexture,vUv); }`),
    display: FS(`uniform sampler2D uDye; uniform float time;
float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
void main(){ vec3 c=texture(uDye,vUv).rgb; c=1.-exp(-c*0.9);
vec3 col=vec3(.0196,.0235,.039)+c; col+=(h(gl_FragCoord.xy+fract(time))-.5)*(3./255.);
o=vec4(col,1.); }`),
  };

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, VS);
  const programs = {};
  for (const [name, src] of Object.entries(SRC)) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, src));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    const uniforms = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const n = gl.getActiveUniform(p, i).name;
      uniforms[n] = gl.getUniformLocation(p, n);
    }
    programs[name] = { p, u: uniforms };
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function fbo(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h, texel: [1 / w, 1 / h] };
  }
  function pair(w, h) {
    const p = { read: fbo(w, h), write: fbo(w, h) };
    p.swap = () => { [p.read, p.write] = [p.write, p.read]; };
    return p;
  }
  function size(res) {
    const a = canvas.width / canvas.height;
    return a >= 1 ? [Math.round(res * a), res] : [res, Math.round(res / a)];
  }

  let velocity, dye, pressure, divergence;
  function init() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const [sw, sh] = size(CFG.simRes);
    const [dw, dh] = size(CFG.dyeRes);
    velocity = pair(sw, sh);
    pressure = pair(sw, sh);
    divergence = fbo(sw, sh);
    dye = pair(dw, dh);
  }

  let texUnit = 0;
  function use(name, target, texel) {
    const prog = programs[name];
    gl.useProgram(prog.p);
    texUnit = 0;
    if (prog.u.texel) gl.uniform2fv(prog.u.texel, texel);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    return prog.u;
  }
  function bindTex(loc, tex) {
    gl.activeTexture(gl.TEXTURE0 + texUnit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, texUnit++);
  }
  const blit = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  function splat(x, y, dx, dy, color, radius = CFG.splatRadius) {
    const aspect = canvas.width / canvas.height;
    let u = use("splat", velocity.write, velocity.read.texel);
    bindTex(u.uTarget, velocity.read.tex);
    gl.uniform1f(u.aspect, aspect);
    gl.uniform1f(u.radius, radius);
    gl.uniform2f(u.point, x, y);
    gl.uniform3f(u.color, dx, dy, 0);
    blit();
    velocity.swap();
    u = use("splat", dye.write, dye.read.texel);
    bindTex(u.uTarget, dye.read.tex);
    gl.uniform1f(u.aspect, aspect);
    gl.uniform1f(u.radius, radius);
    gl.uniform2f(u.point, x, y);
    gl.uniform3fv(u.color, color);
    blit();
    dye.swap();
  }

  function step(dt) {
    let u = use("divergence", divergence, velocity.read.texel);
    bindTex(u.uVelocity, velocity.read.tex);
    blit();

    u = use("scale", pressure.write, pressure.read.texel);
    bindTex(u.uTexture, pressure.read.tex);
    gl.uniform1f(u.value, CFG.pressureDecay);
    blit();
    pressure.swap();

    for (let i = 0; i < CFG.pressureIters; i++) {
      u = use("pressure", pressure.write, pressure.read.texel);
      bindTex(u.uPressure, pressure.read.tex);
      bindTex(u.uDivergence, divergence.tex);
      blit();
      pressure.swap();
    }

    u = use("gradient", velocity.write, velocity.read.texel);
    bindTex(u.uPressure, pressure.read.tex);
    bindTex(u.uVelocity, velocity.read.tex);
    blit();
    velocity.swap();

    u = use("advect", velocity.write, velocity.read.texel);
    bindTex(u.uVelocity, velocity.read.tex);
    bindTex(u.uSource, velocity.read.tex);
    gl.uniform2fv(u.velTexel, velocity.read.texel);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, CFG.velocityDissipation);
    blit();
    velocity.swap();

    u = use("advect", dye.write, dye.read.texel);
    bindTex(u.uVelocity, velocity.read.tex);
    bindTex(u.uSource, dye.read.tex);
    gl.uniform2fv(u.velTexel, velocity.read.texel);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, CFG.dyeDissipation);
    blit();
    dye.swap();
  }

  function render(t) {
    const u = use("display", null, [1 / canvas.width, 1 / canvas.height]);
    bindTex(u.uDye, dye.read.tex);
    gl.uniform1f(u.time, t * 0.001);
    blit();
  }

  // --- Input: the real cursor, or a ghost one when idle ------------------------------
  const pointer = { x: 0.5, y: 0.6, px: 0.5, py: 0.6, moved: false, lastMove: -1e9 };
  let colorIx = 0;
  const nextColor = (k) => PALETTE[(colorIx++ >> 4) % PALETTE.length].map((c) => c * k);

  addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    if (e.clientY > r.bottom || e.clientY < r.top) return;
    pointer.x = (e.clientX - r.left) / r.width;
    pointer.y = 1 - (e.clientY - r.top) / r.height;
    pointer.moved = true;
    pointer.lastMove = performance.now();
  }, { passive: true });

  let ghostT = Math.random() * 100;
  function ghost(t, dt) {
    ghostT += dt * CFG.autoSpeed;
    // Long, wandering sweeps across the whole hero; the inner sine keeps the path from repeating.
    const x = 0.5 + 0.44 * Math.sin(ghostT * 0.9 + Math.sin(ghostT * 0.31) * 1.3);
    const y = 0.58 + 0.24 * Math.sin(ghostT * 1.27 + 0.7 + Math.cos(ghostT * 0.23));
    return [x, y];
  }

  // A burst from the swap card when the direction flips.
  addEventListener("leyden:flip", () => {
    const card = document.getElementById("swapcard");
    if (!card) return;
    const r = canvas.getBoundingClientRect(), c = card.getBoundingClientRect();
    const x = (c.left + c.width / 2 - r.left) / r.width, y = 1 - (c.top + c.height / 2 - r.top) / r.height;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      splat(x, y, Math.cos(a) * 900, Math.sin(a) * 900, nextColor(0.04), 0.02);
    }
  });

  // --- Loop ----------------------------------------------------------------------
  let running = false, last = 0, mode = "ghost";
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.033, (t - last) / 1000 || 0.016);
    last = t;
    let x, y, k;
    const now = t - pointer.lastMove < CFG.idleMs ? "cursor" : "ghost";
    if (now === "cursor") {
      [x, y] = [pointer.x, pointer.y];
      k = 0.026;
    } else {
      [x, y] = ghost(t, dt);
      const since = (t - Math.max(pointer.lastMove, 0) - CFG.idleMs) / 1000;
      k = 0.022 * Math.min(1, Math.max(0, since / CFG.autoRamp));
    }
    // Switching between the real and ghost cursor must not draw a streak between them.
    if (now !== mode) { mode = now; pointer.px = x; pointer.py = y; }
    const dx = (x - pointer.px) * CFG.force, dy = (y - pointer.py) * CFG.force;
    if (Math.abs(dx) + Math.abs(dy) > 0.01) splat(x, y, dx, dy, nextColor(k));
    pointer.px = x;
    pointer.py = y;
    step(0.016);
    render(t);
    requestAnimationFrame(frame);
  }
  const start = () => { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } };
  const stop = () => { running = false; };

  init();
  // Seed a few soft clouds so the first frame is not empty.
  for (let i = 0; i < 5; i++) splat(0.3 + Math.random() * 0.4, 0.55 + Math.random() * 0.3, (Math.random() - 0.5) * 600, (Math.random() - 0.5) * 300, nextColor(0.03), 0.05);
  pointer.px = pointer.x; pointer.py = pointer.y;

  let resizeTimer;
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(init, 150); }).observe(canvas);
  new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(hero);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  hero.classList.add("has-fluid");
})();
