/**
 * Iris — the eye (cosmetic only).
 *
 * Canvas 2D, no dependencies. Only LISTENS to `akon:*` events and pointer movement;
 * it never touches the microphone, Spotify, or the network, and every handler is
 * wrapped so a failure here cannot break voice or playback.
 *
 * How it stays cheap:
 *  - The iris texture (fibres, collarette, crypts, furrows, limbal ring) is baked ONCE,
 *    in small time-sliced chunks (<= ~7 ms each) so speech events and the SDK are never
 *    blocked. Sprites (reflections, ruff, halo) are baked once per resize.
 *  - Each frame is ~10 drawImage/fill calls. Pupil size, exposure, gaze and reflections
 *    animate; the texture itself is never recomputed.
 *
 * Phases (from voice.js): off | idle | listening | thinking | speaking.
 */
(() => {
  const canvas = document.getElementById('irisCanvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const caption = document.getElementById('phaseCaption');
  const heard = document.getElementById('heardText');
  const TAU = Math.PI * 2;
  const reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // ---------------------------------------------------------------- noise
  // Value noise, periodic in x (the angle) so the texture has no seam at 360°.
  function hash(i, j, seed) {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function vnoise(x, y, period, seed) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const a = hash(x0, yi, seed);
    const b = hash(x1, yi, seed);
    const c = hash(x0, yi + 1, seed);
    const d = hash(x1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, period, octaves, seed) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * vnoise(x, y, period, seed + o * 101);
      norm += amp;
      x *= 2;
      y *= 2;
      period *= 2;
      amp *= 0.5;
    }
    return sum / norm;
  }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const mix = (a, b, t) => a + (b - a) * t;

  // ---------------------------------------------------------------- palette
  // Central heterochromia: amber around the pupil, grey-green into slate blue outside.
  const PUP_DEEP = [46, 26, 12];
  const AMBER = [192, 128, 44];
  const GOLD = [222, 164, 78];
  const SAGE = [118, 134, 110];
  const SLATE = [78, 112, 130];
  const DEEP = [40, 62, 78];
  const LIMBUS = [9, 13, 17];
  const CRYPT = [26, 22, 22];
  const FRECKLE = [74, 40, 17];

  const U_MAX = 1.08; // texture reaches a little past the limbus for a soft edge
  const FRECKLES = [
    { t: 0.17, u: 0.74, s: 0.016 },
    { t: 0.61, u: 0.6, s: 0.011 },
    { t: 0.84, u: 0.83, s: 0.009 },
    { t: 0.38, u: 0.9, s: 0.007 }
  ];
  const LIGHT_ANGLE = Math.atan2(-1, -0.8); // key light from the upper left

  // ---------------------------------------------------------------- texture bake
  let texture = null;
  let bakeStarted = false;

  function bakeTexture(size) {
    bakeStarted = true;
    const tex = document.createElement('canvas');
    tex.width = tex.height = size;
    const tctx = tex.getContext('2d');
    const img = tctx.createImageData(size, size);
    const data = img.data;
    const half = size / 2;
    const rUnit = half / U_MAX; // pixels per u=1

    // Collarette radius per angle: wavy and slightly jagged, like a real one.
    const N = 2048;
    const collar = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / N;
      collar[i] = 0.43 + (fbm(t * 7, 0.5, 7, 3, 71) - 0.5) * 0.16 + (fbm(t * 48, 3.5, 48, 2, 73) - 0.5) * 0.07;
    }

    let y = 0;
    function chunk() {
      const t0 = performance.now();
      while (y < size && performance.now() - t0 < 7) {
        for (let x = 0; x < size; x++) {
          const dx = x + 0.5 - half;
          const dy = y + 0.5 - half;
          const u = Math.sqrt(dx * dx + dy * dy) / rUnit;
          const o = (y * size + x) * 4;
          if (u > U_MAX) {
            data[o + 3] = 0;
            continue;
          }
          const ang = Math.atan2(dy, dx);
          const t = ang / TAU + 0.5;
          const uc = collar[Math.floor(t * N) % N];

          // Fibres: long radial bundles + fine striations, slightly wavy.
          const warp = (fbm(t * 18, u * 2.4, 18, 2, 11) - 0.5) * 0.012;
          const tw = t + warp;
          const fA = fbm(tw * 150, u * 1.5, 150, 3, 21);
          const fB = fbm(tw * 480, u * 3.6, 480, 2, 31);
          const fib = clamp((fA * 0.6 + fB * 0.4 - 0.5) * 3.4, -1, 1);

          // Zone colour: pupillary (amber, patchy, darker toward the pupil) vs
          // ciliary (sage -> slate -> deep blue).
          const patch = fbm(t * 13, u * 2.2, 13, 3, 81);
          const kp = Math.pow(smooth(0.12, uc, u), 1.15) * (0.55 + 0.6 * patch) * (0.7 + 0.45 * fA);
          let pr = mix(PUP_DEEP[0], AMBER[0], clamp(kp, 0, 1));
          let pg = mix(PUP_DEEP[1], AMBER[1], clamp(kp, 0, 1));
          let pb = mix(PUP_DEEP[2], AMBER[2], clamp(kp, 0, 1));
          const kc = clamp((u - uc) / (0.97 - uc), 0, 1);
          let cr;
          let cg;
          let cb;
          if (kc < 0.35) {
            const k = kc / 0.35;
            cr = mix(SAGE[0], SLATE[0], k); cg = mix(SAGE[1], SLATE[1], k); cb = mix(SAGE[2], SLATE[2], k);
          } else {
            const k = (kc - 0.35) / 0.65;
            cr = mix(SLATE[0], DEEP[0], k); cg = mix(SLATE[1], DEEP[1], k); cb = mix(SLATE[2], DEEP[2], k);
          }
          const tint = (fbm(t * 5, u * 1.3, 5, 2, 87) - 0.5) * 1.6;
          cr += tint * 10; cg += tint * 14; cb -= tint * 6;
          // Amber streaks bleed outward along the fibres past the collarette.
          const spoke = fbm(tw * 90, u * 1.2, 90, 2, 77);
          const spill = smooth(uc + 0.2, uc - 0.01, u) * clamp(spoke * 3.2 - 1.35, 0, 1) * 0.75;
          cr = mix(cr, GOLD[0], spill); cg = mix(cg, GOLD[1], spill); cb = mix(cb, GOLD[2], spill);

          const bw = smooth(uc - 0.015, uc + 0.045, u);
          let r = mix(pr, cr, bw);
          let g = mix(pg, cg, bw);
          let b = mix(pb, cb, bw);

          // Fibre relief.
          const relief = 1 + fib * (u < uc ? 0.34 : 0.44);
          r *= relief; g *= relief; b *= relief;

          // Collarette ridge (raised, catches light) with a shadow just outside it.
          const ridge = Math.exp(-Math.pow((u - uc) / 0.013, 2));
          const ridgeLift = 1 + 0.2 * ridge * (0.2 + 1.3 * fA * fA);
          const shadow = 1 - 0.3 * Math.exp(-Math.pow((u - uc - 0.032) / 0.016, 2));
          r *= ridgeLift * shadow; g *= ridgeLift * shadow; b *= ridgeLift * shadow;

          // Fuchs' crypts: dark pits just outside the collarette, fibres crossing them.
          const cryptZone = smooth(uc + 0.005, uc + 0.035, u) * smooth(uc + 0.34, uc + 0.16, u);
          if (cryptZone > 0) {
            const cn = fbm(t * 64, u * 4.2, 64, 2, 41);
            const crypt = smooth(0.63, 0.72, cn) * cryptZone * (1 - 0.55 * smooth(0.5, 0.72, fA));
            const rim = (smooth(0.58, 0.63, cn) - smooth(0.63, 0.67, cn)) * cryptZone * 0.22;
            r = mix(r, CRYPT[0], crypt * 0.62) * (1 + rim);
            g = mix(g, CRYPT[1], crypt * 0.62) * (1 + rim);
            b = mix(b, CRYPT[2], crypt * 0.62) * (1 + rim);
          }

          // Contraction furrows: broken concentric creases in the outer iris.
          const fz = smooth(0.6, 0.7, u) * smooth(0.97, 0.88, u);
          if (fz > 0) {
            const ring = (u + (fbm(t * 9, u * 2, 9, 2, 51) - 0.5) * 0.05) * 9;
            const crease = Math.pow(0.5 + 0.5 * Math.cos(TAU * ring), 7);
            const broken = smooth(0.5, 0.64, fbm(t * 11, u * 2, 11, 2, 61));
            const k = 1 - 0.26 * crease * fz * broken;
            r *= k; g *= k; b *= k;
          }

          // A few pigment freckles.
          for (let f = 0; f < FRECKLES.length; f++) {
            const fr = FRECKLES[f];
            let dt = t - fr.t;
            dt -= Math.round(dt);
            const ax = dt * TAU * u;
            const ay = u - fr.u;
            const w = Math.exp(-(ax * ax + ay * ay) / (fr.s * fr.s)) * 0.8;
            if (w > 0.002) { r = mix(r, FRECKLE[0], w); g = mix(g, FRECKLE[1], w); b = mix(b, FRECKLE[2], w); }
          }

          // Fibres catching the light.
          const sparkle = smooth(0.64, 0.8, fB) * (u > uc ? 26 : 16) * smooth(0.2, 0.5, u);
          r += sparkle; g += sparkle * 0.96; b += sparkle * 0.9;

          // Key light from the upper left across the gently conical iris surface.
          const lit = 1 + 0.12 * Math.cos(ang - LIGHT_ANGLE) * smooth(0.25, 1, u);
          r *= lit; g *= lit; b *= lit;

          // Limbal ring: dark band where the iris meets the sclera.
          const lim = Math.pow(smooth(0.79, 0.995, u), 1.25) * 0.93;
          r = mix(r, LIMBUS[0], lim); g = mix(g, LIMBUS[1], lim); b = mix(b, LIMBUS[2], lim);

          data[o] = clamp(r, 0, 255);
          data[o + 1] = clamp(g, 0, 255);
          data[o + 2] = clamp(b, 0, 255);
          data[o + 3] = 255 * (1 - smooth(0.995, 1.06, u));
        }
        y++;
      }
      if (y < size) {
        setTimeout(chunk, 0);
      } else {
        tctx.putImageData(img, 0, 0);
        texture = tex;
        revealAt = performance.now();
      }
    }
    setTimeout(chunk, 0);
  }

  // ---------------------------------------------------------------- sprites
  let W = 0; // canvas px
  let R = 0; // iris radius px
  let dpr = 1;
  const sprites = {};

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h || w));
    return c;
  }

  function withBlur(c2d, px) {
    try { c2d.filter = `blur(${px}px)`; } catch (e) { /* older browsers: sharp edges */ }
  }

  function roundRect(c2d, x, y, w, h, r) {
    c2d.beginPath();
    c2d.moveTo(x + r, y);
    c2d.arcTo(x + w, y, x + w, y + h, r);
    c2d.arcTo(x + w, y + h, x, y + h, r);
    c2d.arcTo(x, y + h, x, y, r);
    c2d.arcTo(x, y, x + w, y, r);
    c2d.closePath();
  }

  function buildSprites() {
    // Dim eyeball around the iris, lit from the upper left, sinking into black.
    const halo = makeCanvas(W);
    let h = halo.getContext('2d');
    const c = W / 2;
    let gr = h.createRadialGradient(c - R * 0.12, c - R * 0.16, R * 0.9, c, c, R * 1.33);
    gr.addColorStop(0, 'rgba(66,70,74,0.30)');
    gr.addColorStop(0.3, 'rgba(34,36,40,0.20)');
    gr.addColorStop(0.7, 'rgba(12,13,15,0.07)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    h.fillStyle = gr;
    h.fillRect(0, 0, W, W);
    sprites.halo = halo;

    // Warm light spill used while responding.
    const warm = makeCanvas(W);
    h = warm.getContext('2d');
    gr = h.createRadialGradient(c, c, R * 0.95, c, c, R * 1.33);
    gr.addColorStop(0, 'rgba(216,162,74,0.22)');
    gr.addColorStop(1, 'rgba(216,162,74,0)');
    h.fillStyle = gr;
    h.fillRect(0, 0, W, W);
    sprites.warm = warm;

    // Corneal dome: faint sheen toward the light, darker toward the rim.
    const dome = makeCanvas(R * 2.2);
    h = dome.getContext('2d');
    const d = dome.width / 2;
    gr = h.createRadialGradient(d, d, R * 0.55, d, d, R * 1.04);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.42)');
    h.fillStyle = gr;
    h.beginPath(); h.arc(d, d, R * 1.04, 0, TAU); h.fill();
    gr = h.createRadialGradient(d - R * 0.35, d - R * 0.4, 0, d - R * 0.35, d - R * 0.4, R * 0.95);
    gr.addColorStop(0, 'rgba(200,215,228,0.10)');
    gr.addColorStop(1, 'rgba(200,215,228,0)');
    h.fillStyle = gr;
    h.beginPath(); h.arc(d, d, R * 1.02, 0, TAU); h.fill();
    sprites.dome = dome;

    // Window reflection (2x2 panes) — the wet specular highlight, bent by the cornea.
    const ww = R * 0.3;
    const wh = R * 0.22;
    const win = makeCanvas(ww * 1.9, wh * 1.9);
    h = win.getContext('2d');
    h.translate(win.width / 2, win.height / 2);
    gr = h.createRadialGradient(0, 0, 0, 0, 0, ww * 0.9);
    gr.addColorStop(0, 'rgba(210,225,240,0.16)');
    gr.addColorStop(1, 'rgba(210,225,240,0)');
    h.fillStyle = gr;
    h.fillRect(-win.width / 2, -win.height / 2, win.width, win.height);
    withBlur(h, Math.max(1, R * 0.016));
    h.rotate(-0.28);
    h.transform(1, 0.1, -0.16, 1, 0, 0); // corneal curvature
    const gap = R * 0.016;
    const pw = (ww - gap) / 2;
    const ph = (wh - gap) / 2;
    const glass = h.createLinearGradient(-ww / 2, -wh / 2, ww / 3, wh / 2);
    glass.addColorStop(0, 'rgba(255,253,248,0.9)');
    glass.addColorStop(1, 'rgba(226,236,248,0.32)');
    h.fillStyle = glass;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        roundRect(h, -ww / 2 + i * (pw + gap), -wh / 2 + j * (ph + gap), pw, ph, R * 0.035);
        h.fill();
      }
    }
    sprites.win = win;

    // Small secondary glint.
    const gs = R * 0.14;
    const glint = makeCanvas(gs);
    h = glint.getContext('2d');
    gr = h.createRadialGradient(gs / 2, gs / 2, 0, gs / 2, gs / 2, gs / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    h.fillStyle = gr;
    h.fillRect(0, 0, gs, gs);
    sprites.glint = glint;

    // Ring-light catchlight (listening).
    const rs = R * 1.6;
    const ring = makeCanvas(rs);
    h = ring.getContext('2d');
    withBlur(h, Math.max(1, R * 0.018));
    h.strokeStyle = 'rgba(255,244,228,0.9)';
    h.lineWidth = R * 0.045;
    h.beginPath(); h.arc(rs / 2, rs / 2, R * 0.62, 0, TAU); h.stroke();
    sprites.ring = ring;

    // Pupillary ruff: irregular dark-brown frill at the pupil margin (drawn at P_REF, scaled).
    const P_REF = R * 0.3;
    const rf = makeCanvas(P_REF * 2.6);
    h = rf.getContext('2d');
    const rc = rf.width / 2;
    withBlur(h, Math.max(0.5, R * 0.004));
    h.fillStyle = 'rgba(58,30,14,0.95)';
    h.beginPath();
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * TAU;
      const rr = P_REF * (1.06 + 0.05 * vnoise(i / 8, 0.5, 32, 91) + 0.025 * vnoise(i / 2, 1.5, 128, 93));
      if (i === 0) h.moveTo(rc + Math.cos(a) * rr, rc + Math.sin(a) * rr);
      else h.lineTo(rc + Math.cos(a) * rr, rc + Math.sin(a) * rr);
    }
    h.closePath();
    h.fill();
    sprites.ruff = rf;
    sprites.ruffRef = P_REF;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(rect.width * dpr);
    if (px === W) return;
    W = canvas.width = canvas.height = px;
    R = W * 0.37;
    buildSprites();
    if (!bakeStarted) bakeTexture(clamp(Math.round(2 * R * U_MAX), 480, 1024));
  }

  // ---------------------------------------------------------------- state
  const TARGETS = {
    off: { pupil: 0.27, exposure: 0.62, ring: 0, sweep: 0, warm: 0, win: 0.7 },
    idle: { pupil: 0.285, exposure: 0.86, ring: 0, sweep: 0, warm: 0, win: 1 },
    listening: { pupil: 0.44, exposure: 1.14, ring: 1, sweep: 0, warm: 0, win: 0.55 },
    thinking: { pupil: 0.215, exposure: 0.96, ring: 0.2, sweep: 1, warm: 0, win: 0.75 },
    speaking: { pupil: 0.31, exposure: 1.02, ring: 0.15, sweep: 0, warm: 1, win: 0.9 }
  };
  let phase = 'off';
  const cur = Object.assign({}, TARGETS.off);
  let wakeAt = -1e9;
  let revealAt = 0;

  const gaze = { x: 0, y: 0 };
  const jitter = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };
  let pointer = null; // { x, y, at }

  window.addEventListener('pointermove', (e) => {
    pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
  }, { passive: true });

  // ---------------------------------------------------------------- frame
  let last = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    try { draw(now); } catch (e) { /* never let the eye break the page */ }
  }

  function approach(key, target, tau, dt) {
    cur[key] += (target - cur[key]) * (1 - Math.exp(-dt / tau));
  }

  function draw(now) {
    if (!W) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = now / 1000;
    const reduce = reduceMq.matches;
    const tg = TARGETS[phase] || TARGETS.idle;

    // Pupils dilate a little slower than they constrict — as real ones do.
    approach('pupil', tg.pupil, tg.pupil > cur.pupil ? 0.26 : 0.2, dt);
    approach('exposure', tg.exposure, 0.22, dt);
    approach('ring', tg.ring, 0.16, dt);
    approach('sweep', tg.sweep, 0.35, dt);
    approach('warm', tg.warm, 0.3, dt);
    approach('win', tg.win, 0.3, dt);

    // Idle life: hippus (natural pupil unrest) and a responding "voice" pulse.
    const hippus = reduce ? 0 : 0.012 * Math.sin(time * 0.9) + 0.007 * Math.sin(time * 2.3 + 1.3);
    const voice = reduce ? 0 : Math.max(0, Math.sin(time * 9.4) * 0.6 + Math.sin(time * 5.1 + 0.7) * 0.5) * (0.6 + 0.4 * Math.sin(time * 1.7));
    const pupilFrac = cur.pupil + hippus + cur.warm * voice * 0.045;
    const exposure = cur.exposure + cur.warm * voice * 0.07 + (reduce ? 0 : 0.02 * Math.sin(time * 0.5));

    // Gaze: follow the pointer; wander slowly when it is still.
    let tx = 0;
    let ty = 0;
    const rect = canvas.getBoundingClientRect();
    if (pointer && now - pointer.at < 3500 && rect.width) {
      const ex = rect.left + rect.width / 2;
      const ey = rect.top + rect.height / 2;
      const vx = pointer.x - ex;
      const vy = pointer.y - ey;
      const dist = Math.hypot(vx, vy) || 1;
      const mag = Math.min(0.9, dist / (dist + rect.width * 0.55));
      tx = (vx / dist) * mag;
      ty = (vy / dist) * mag;
    } else if (!reduce) {
      tx = 0.18 * Math.sin(time * 0.23) + 0.08 * Math.sin(time * 0.61 + 2);
      ty = 0.12 * Math.sin(time * 0.19 + 1) + 0.06 * Math.sin(time * 0.53);
    }
    if (phase === 'listening' || phase === 'speaking') { tx *= 0.45; ty *= 0.45; } // attend to the user
    const kg = 1 - Math.exp(-dt / 0.14);
    gaze.x += (tx - gaze.x) * kg;
    gaze.y += (ty - gaze.y) * kg;

    // Micro-saccades: tiny quick fixational jumps so the eye never looks frozen.
    if (!reduce && now > jitter.next) {
      jitter.tx = (Math.random() - 0.5) * 0.07;
      jitter.ty = (Math.random() - 0.5) * 0.07;
      jitter.next = now + 900 + Math.random() * 2200;
    }
    const kj = 1 - Math.exp(-dt / 0.035);
    jitter.x += (jitter.tx - jitter.x) * kj;
    jitter.y += (jitter.ty - jitter.y) * kj;

    const gx = gaze.x + jitter.x;
    const gy = gaze.y + jitter.y;
    const gm = Math.min(1, Math.hypot(gx, gy));
    const ga = Math.atan2(gy, gx);

    const c = W / 2;
    const reveal = texture ? smooth(0, 1400, now - revealAt) : 0;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, W);

    ctx.globalAlpha = 0.35 + 0.65 * reveal;
    ctx.drawImage(sprites.halo, 0, 0);
    if (cur.warm > 0.01) {
      ctx.globalAlpha = cur.warm * (0.55 + 0.45 * voice);
      ctx.drawImage(sprites.warm, 0, 0);
    }

    // ---- the eye (moves with gaze; foreshortens as it turns away)
    ctx.save();
    ctx.translate(c + gx * R * 0.085, c + gy * R * 0.085);
    if (gm > 0.001) {
      ctx.rotate(ga);
      ctx.scale(1 - 0.13 * gm, 1);
      ctx.rotate(-ga);
    }

    if (texture) {
      const D = 2 * R * U_MAX;
      ctx.globalAlpha = reveal;
      ctx.drawImage(texture, -D / 2, -D / 2, D, D);
      if (exposure > 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = reveal * Math.min(0.5, (exposure - 1) * 1.7);
        ctx.drawImage(texture, -D / 2, -D / 2, D, D);
        ctx.globalCompositeOperation = 'source-over';
      } else if (exposure < 1) {
        ctx.globalAlpha = 1 - exposure;
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(0, 0, R * 1.07, 0, TAU); ctx.fill();
      }
    }

    // Pupil + ruff.
    const P = R * pupilFrac;
    const rs = P / sprites.ruffRef;
    const rw = sprites.ruff.width * rs;
    ctx.globalAlpha = 0.25 + 0.75 * reveal;
    ctx.drawImage(sprites.ruff, -rw / 2, -rw / 2, rw, rw);
    const edge = Math.max(1, 1.2 * dpr);
    const pg = ctx.createRadialGradient(0, 0, Math.max(0, P - edge), 0, 0, P + edge);
    pg.addColorStop(0, '#000');
    pg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(0, 0, P + edge, 0, TAU); ctx.fill();

    const dw = sprites.dome.width;
    ctx.globalAlpha = reveal;
    ctx.drawImage(sprites.dome, -dw / 2, -dw / 2);
    ctx.restore();

    // ---- corneal reflections (stay with the light source: parallax against the iris)
    const hx = c - gx * R * 0.03;
    const hy = c - gy * R * 0.03;
    ctx.globalCompositeOperation = 'lighter';

    ctx.globalAlpha = reveal * cur.win * 0.9;
    ctx.drawImage(sprites.win, hx - R * 0.42 - sprites.win.width / 2, hy - R * 0.44 - sprites.win.height / 2);
    ctx.globalAlpha = reveal * cur.win * 0.55;
    const gs = sprites.glint.width;
    ctx.drawImage(sprites.glint, hx + R * 0.3 - gs / 2, hy + R * 0.34 - gs / 2);

    const ringW = sprites.ring.width;
    if (cur.ring > 0.01) {
      ctx.globalAlpha = reveal * cur.ring * 0.5;
      ctx.drawImage(sprites.ring, hx - ringW / 2, hy - ringW / 2);
    }

    // Wake cue: a single bloom of light that expands from the pupil.
    const sinceWake = (now - wakeAt) / 1000;
    if (!reduce && sinceWake >= 0 && sinceWake < 0.6) {
      const k = sinceWake / 0.6;
      const s = 0.45 + 0.75 * (1 - Math.pow(1 - k, 3));
      ctx.globalAlpha = reveal * 0.75 * (1 - k);
      ctx.drawImage(sprites.ring, hx - (ringW * s) / 2, hy - (ringW * s) / 2, ringW * s, ringW * s);
    }

    // Thinking: the light slowly circles the eye.
    if (cur.sweep > 0.01) {
      const a = time * (reduce ? 0.6 : 1.7);
      const sx = hx + Math.cos(a) * R * 0.5;
      const sy = hy + Math.sin(a) * R * 0.46;
      ctx.globalAlpha = reveal * cur.sweep * 0.5;
      const w2 = sprites.win.width * 0.45;
      const h2 = sprites.win.height * 0.45;
      ctx.drawImage(sprites.win, sx - w2 / 2, sy - h2 / 2, w2, h2);
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- phase + caption
  const COPY = {
    off: 'Connect Spotify to begin',
    idle: 'Say \u201cIris\u201d',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Done'
  };
  let offReason = 'login';
  let response = '';

  function renderCaption() {
    if (!caption) return;
    let text = COPY[phase] || '';
    if (phase === 'off') {
      if (offReason === 'muted') text = 'Microphone off';
      else if (offReason === 'blocked') text = 'Microphone blocked \u2014 allow it in the address bar, then turn it on below';
      else if (offReason === 'no-mic') text = 'No microphone found';
    }
    if (phase === 'speaking' && response) text = response;
    caption.textContent = text;
  }

  function setPhase(p, detail) {
    const prev = phase;
    phase = TARGETS[p] ? p : 'idle';
    if (phase === 'listening' && prev !== 'listening') wakeAt = performance.now();
    if (phase === 'off') offReason = (detail && detail.reason) || offReason;
    if (phase === 'listening' || phase === 'thinking') response = '';
    document.body.classList.remove('phase-off', 'phase-idle', 'phase-listening', 'phase-thinking', 'phase-speaking');
    document.body.classList.add(`phase-${phase}`);
    if (heard) {
      if (phase === 'thinking' && detail && detail.command) heard.textContent = `\u201c${detail.command}\u201d`;
      if (phase === 'idle' || phase === 'off' || (phase === 'listening' && prev !== 'listening')) heard.textContent = '';
    }
    renderCaption();
  }

  const on = (name, fn) =>
    window.addEventListener(name, (e) => {
      try { fn(e.detail || {}); } catch (err) { console.warn('[Iris eye]', name, err); }
    });

  on('akon:phase', (d) => setPhase(d.phase, d));
  on('akon:hearing', ({ text }) => { if (heard && phase === 'listening') heard.textContent = text || ''; });
  on('akon:match', ({ name }) => { response = name ? `Playing ${name}` : ''; renderCaption(); });
  on('akon:resolved', ({ action }) => {
    if (action === 'choose') response = 'Which one did you mean?';
    else if (action === 'not_found') response = 'I couldn\u2019t find that song';
    else if (action === 'error') response = 'Search failed. Try again.';
    renderCaption();
  });

  setPhase('off', { reason: 'login' });

  // ---------------------------------------------------------------- boot
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();
