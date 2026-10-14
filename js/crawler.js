// =============================================================================
// crawler.js: the spider's brain and body.
//
//   Crawler      the main loop: update() -> draw() -> commit()
//   two-bone IK  solveLeg(): law of cosines, fixed knee direction per leg
//   gait         alternating tetrapod: legs L1 R2 L3 R4 step together, then R1 L2 R3 L4
//   footholds    feet snap to real words via document.elementFromPoint
//   Marker       research-markup effects + "smart targeting" of important words
//
// FRAME DISCIPLINE (how it holds 60fps on a long paper):
//   update()  may only READ the DOM (rects, scrollTop, elementFromPoint)
//   draw()    only touches the <canvas>
//   commit()  applies every queued DOM WRITE (class changes, word wrapping,
//             scrollTop) once, at the end of the frame
// Interleaving reads and writes forces the browser to recompute layout over
// and over ("layout thrashing"). Batching keeps it to at most one layout per frame.
//
// COORDINATES: the spider lives in "doc" coordinates, pixels from the top-left
// of the scrolling paper content. Scrolling doesn't move it relative to the
// words. To draw it we subtract scrollTop to get screen coordinates.
// =============================================================================

import { drawSpider, drawThread, drawTrail, drawDebug } from './spider-draw.js';

export const CFG = {
  scale: 1,
  femur: 34,               // upper leg bone length (px)
  tibia: 40,               // lower leg bone length (px)
  stepThreshold: 24,       // a foot steps once it drifts this far from its rest pose
  stepMsSlow: 180,         // step duration when strolling...
  stepMsFast: 120,         // ...and when running
  stepLift: 7,             // how far a swinging foot arcs outward (px)
  leadTime: 0.16,          // feet aim this many seconds ahead of the body's motion
  cruiseSpeed: 85,         // px/s while reading
  readPace: 1,             // >1 reads down the paper faster, <1 lingers
  chaseSpeed: 170,         // px/s while chasing the cursor
  runSpeed: 300,           // px/s when sent somewhere (click, KEY, selection)
  turnRate: 3.4,           // rad/s
  manualScrollHoldMs: 2500,
  cameraAnchor: 0.42,      // keep the spider ~42% down the screen
  threadSnapDistance: 240, // px walked after landing before the drop-line snaps
  trailWords: 4,           // faint silk threads to this many recent words
  teleportScreens: 1.3,    // gotos farther than this many screens re-drop instead of walking
};

// The 8 legs. Angles are measured from the spider's forward axis; side -1 = left.
// hip:  where the leg attaches on the thorax (local coords, x forward, y right)
// rest: where the foot "wants" to be relative to the body (angle, radius)
// tuck: folded pose while dangling on the thread
const LEG_LAYOUT = [
  { hipX: 5.5, rest: [36, 62], tuck: [18, 13] },   // pair 1 (front)
  { hipX: 3.2, rest: [80, 55], tuck: [55, 11] },   // pair 2
  { hipX: 0.9, rest: [114, 54], tuck: [125, 11] }, // pair 3
  { hipX: -1.4, rest: [150, 62], tuck: [165, 14] }, // pair 4 (back)
];

// Calm / normal / wild: how much markup the spider leaves behind.
const INTENSITY = {
  calm:   { mark: 0.08, neighbor: 0.0,  line: 0.0,   drama: 0.5, important: 0.5 },
  normal: { mark: 0.22, neighbor: 0.06, line: 0.01,  drama: 1.0, important: 0.9 },
  wild:   { mark: 0.6,  neighbor: 0.25, line: 0.04,  drama: 1.6, important: 1.0 },
};

const WORD_BLOCK_SEL = 'p, li, figcaption, td, th, h2, h3, h4, h5, h6, dd, dt, .ltx_bibblock, .paper-head div, .paper-head h1';

// ---------------------------------------------------------------- math utils --
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const rot = (x, y, a) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

// Smooth 1D value noise in [-1, 1]: random values at integers, cosine-blended between.
// Gives organic wandering without any library.
function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => {
    const s = Math.sin((n + seed * 101.3) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const t = (1 - Math.cos(f * Math.PI)) / 2;
  return lerp(h(i), h(i + 1), t);
}

// =============================================================================
// TWO-BONE INVERSE KINEMATICS
//
// Given a hip H, a foot target T and bone lengths a (femur) and b (tibia),
// where is the knee? The triangle H-knee-T has sides a, b and d = |T - H|.
// The law of cosines gives the angle at the hip between the line H->T and the femur:
//
//        cos(A) = (a² + d² - b²) / (2·a·d)
//
// So the knee sits at angle (direction of T) ± A from the hip. The ± is the
// "bend" sign: it decides which way the knee points. We fix it per leg so
// knees always bulge outward like a real spider's (no knee flipping).
// If the target is out of reach we clamp d, so the leg straightens toward it.
// =============================================================================
export function solveLeg(hip, target, a, b, bend) {
  const dx = target.x - hip.x, dy = target.y - hip.y;
  const d = clamp(Math.hypot(dx, dy), Math.abs(a - b) + 0.01, a + b - 0.01);
  const base = Math.atan2(dy, dx);
  const A = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const knee = { x: hip.x + Math.cos(base + bend * A) * a, y: hip.y + Math.sin(base + bend * A) * a };
  // The foot ends where the tibia reaches along the (clamped) hip->target line.
  const foot = { x: hip.x + Math.cos(base) * d, y: hip.y + Math.sin(base) * d };
  return { knee, foot };
}

// =============================================================================
// Crawler
// =============================================================================
export class Crawler {
  constructor({ stage, scroller, canvas, debug = false }) {
    this.stage = stage;
    this.scroller = scroller;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.debug = debug;

    this.paper = null;
    this.listeners = {};
    this.writes = [];        // queued DOM writes, applied in commit()
    this.scrollWrite = null; // queued scrollTop

    this.paused = false;
    this.follow = true;
    this.intensity = 'normal';
    this.mode = 'idle';      // idle | drop | landing | walk | goto | chase
    this.marker = new Marker(this);

    this.pos = { x: 0, y: 0 };
    this.vel = { x: 0, y: 0 };
    this.angle = Math.PI / 2;
    this.speed = 0;
    this.time = 0;
    this.trail = [];         // recently touched words: { el, t }
    this.walked = new Set(); // blocks the spider has stepped on (prioritized for Claude)
    this.sectionIndex = -1;
    this.thread = null;
    this.manualUntil = 0;
    this.expectedScroll = null;
    this.mouse = { cx: 0, cy: 0, movedAt: -1e9, inside: false };
    this.layout = { tops: [], col: { left: 0, right: 600 }, refsTop: Infinity, lastAt: -1e9 };

    this.legs = [];
    for (const side of [-1, 1]) {
      LEG_LAYOUT.forEach((L, i) => {
        const pair = i + 1;
        this.legs.push({
          name: (side < 0 ? 'L' : 'R') + pair,
          side, i,
          // Alternating tetrapod: L1 R2 L3 R4 are group 0; R1 L2 R3 L4 are group 1.
          group: (side < 0) === (i % 2 === 0) ? 0 : 1,
          hipLocal: { x: L.hipX, y: side * 3.4 },
          restLocal: polarLocal(L.rest[0], L.rest[1], side),
          tuckLocal: polarLocal(L.tuck[0], L.tuck[1], side),
          // Knee direction: front pairs bend one way, back pairs the other, mirrored per
          // side, so every knee bulges away from the body.
          bend: side * (i < 2 ? 1 : -1),
          foot: { x: 0, y: 0 },
          anchor: null,  // { el, fx, fy }: the word this foot stands on
          swing: null,   // { from, to, anchor, t0, dur }
          lift: 0,
          needsStep: false,
          knee: { x: 0, y: 0 }, hip: { x: 0, y: 0 }, ideal: { x: 0, y: 0 },
        });
      });
    }

    this.bindInput();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop = this.loop.bind(this);
    this.last = performance.now();
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ events --
  on(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name, data) { for (const fn of this.listeners[name] || []) fn(data); }

  // ------------------------------------------------------------------ setup ---
  setPaper(paper) {
    this.paper = paper;
    this.walked.clear();
    this.trail = [];
    this.sectionIndex = -1;
    this.mode = 'idle';
    this.thread = null;
    this.layout.lastAt = -1e9;
    this.pendingPoint = null;
    for (const leg of this.legs) { leg.anchor = null; leg.swing = null; }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.layout.lastAt = -1e9; // headings moved: re-measure next frame
  }

  bindInput() {
    const sc = this.scroller;
    // Any of these means the human is scrolling: hand them the camera for 2.5s.
    const manual = () => { this.manualUntil = performance.now() + CFG.manualScrollHoldMs; };
    sc.addEventListener('wheel', manual, { passive: true });
    sc.addEventListener('touchmove', manual, { passive: true });
    sc.addEventListener('mousedown', (e) => { if (e.offsetX > sc.clientWidth) manual(); });
    sc.addEventListener('scroll', () => {
      // A scroll we didn't cause (scrollbar drag, keyboard, in-paper link) is manual too.
      if (this.expectedScroll == null || Math.abs(sc.scrollTop - this.expectedScroll) > 3) manual();
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) manual();
    });

    // Mouse: the spider chases the cursor; a click sends it there.
    this.stage.addEventListener('mousemove', (e) => {
      const moved = Math.hypot(e.clientX - this.mouse.cx, e.clientY - this.mouse.cy);
      this.mouse.cx = e.clientX;
      this.mouse.cy = e.clientY;
      this.mouse.inside = true;
      if (moved > 2) this.mouse.movedAt = performance.now();
    });
    this.stage.addEventListener('mouseleave', () => { this.mouse.inside = false; });
    this.stage.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;                  // let links work
      if (String(window.getSelection())) return;           // that was a text selection
      const p = this.clientToDoc(e.clientX, e.clientY);
      this.goto(p, { resume: 'here' });
    });
  }

  // ------------------------------------------------------------- coordinates --
  readFrame() {
    // All per-frame DOM reads that everything else relies on.
    this.stageRect = this.stage.getBoundingClientRect();
    this.scrollTop = this.scroller.scrollTop;
    this.vw = this.scroller.clientWidth;
    this.vh = this.scroller.clientHeight;
    this.maxScroll = this.scroller.scrollHeight - this.vh;
  }
  clientToDoc(cx, cy) {
    const r = this.stageRect || this.stage.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top + this.scroller.scrollTop };
  }
  docToClient(x, y) {
    return { x: x + this.stageRect.left, y: y - this.scrollTop + this.stageRect.top };
  }
  toScreen(p) { return { x: p.x, y: p.y - this.scrollTop }; }
  rectDoc(el) {
    const r = el.getBoundingClientRect();
    return {
      x: r.left - this.stageRect.left, y: r.top - this.stageRect.top + this.scrollTop,
      w: r.width, h: r.height,
    };
  }

  // Re-measure section heading positions and the paper column a couple of times
  // per second (they only change on reflow), instead of every frame.
  refreshLayout(now, force = false) {
    if (!this.paper || (!force && now - this.layout.lastAt < 500)) return;
    this.layout.lastAt = now;
    this.layout.tops = this.paper.sections.map((s) => this.rectDoc(s.heading).y);
    const refs = this.paper.sections.find((s) => s.isRefs);
    this.layout.refsTop = refs ? this.rectDoc(refs.heading).y : Infinity;
    const sheet = this.rectDoc(this.paper.root);
    const pad = Math.min(56, sheet.w * 0.08);
    this.layout.col = { left: sheet.x + pad, right: sheet.x + sheet.w - pad };
    this.layout.bottom = sheet.y + sheet.h;
  }

  sectionAt(y) {
    const tops = this.layout.tops;
    let idx = 0;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= y + 12) idx = i;
    return idx;
  }

  // ------------------------------------------------------------------ public --
  /** Drop in from the top of the screen on a silk thread. */
  drop(target = null, onLand = null) {
    if (!this.paper) return;
    this.readFrame();
    this.refreshLayout(performance.now(), true);
    if (!target) {
      // Default landing: the paper's title.
      const t = this.rectDoc(this.paper.head.querySelector('h1'));
      target = { x: t.x + t.w * rand(0.35, 0.65), y: t.y + t.h * 0.5 };
    }
    // Jump the camera so the landing spot sits at the usual camera anchor.
    const camY = clamp(target.y - this.vh * CFG.cameraAnchor, 0, Math.max(0, this.maxScroll));
    this.queueScroll(camY);
    this.camY = camY;
    this.mode = 'drop';
    this.pos = { x: target.x, y: camY - 70 };
    this.vy = 0;
    this.fallDone = false;
    this.dropTarget = target;
    this.onLand = onLand;
    this.angle = Math.PI / 2 + rand(-0.25, 0.25);
    this.speed = 0;
    this.dropT = 0;
    // The drop-line hangs from the top of the screen at the spider's x.
    this.thread = { attached: true, ax: target.x, travel: 0, snapT: null };
    for (const leg of this.legs) { leg.anchor = null; leg.swing = null; leg.needsStep = false; }
    this.readY = target.y;
  }

  /** Walk (or run) to a doc-space point. Far targets re-drop instead of a long walk. */
  goto(p, { onArrive = null, resume = 'here', speed = CFG.runSpeed } = {}) {
    if (this.mode === 'idle' || this.mode === 'drop' || this.mode === 'landing') {
      this.queuedGoto = [p, { onArrive, resume, speed }];
      return;
    }
    const resumeY = resume === 'back' ? this.readY : null;
    const arrive = () => {
      if (onArrive) onArrive();
      this.readY = resumeY ?? this.pos.y;
      this.mode = 'walk';
      this.waypoint = null;
      this.pauseUntil = this.time + 1.6; // stop and "read" what it found
    };
    if (Math.abs(p.y - this.pos.y) > this.vh * CFG.teleportScreens) {
      this.drop(p, arrive);
      return;
    }
    this.mode = 'goto';
    this.gotoTarget = { p, arrive, speed };
  }

  /** Called with Claude's KEY phrase: find it in the paper, run to it, mark it big. */
  pointAt(phrase, sectionIndex) {
    // findPhrase may wrap words (a DOM write), so it runs in commit().
    this.writes.push(() => {
      const hit = this.paper?.findPhrase(phrase, sectionIndex);
      if (!hit) { this.emit('pointMissed', phrase); return; }
      this.pendingPoint = hit; // measured + walked to on the next update()
    });
  }

  /** "Explain this": run to the user's text selection. */
  gotoSelection(range) {
    const r = range.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const p = this.clientToDoc(r.left + r.width / 2, r.top + r.height / 2);
    this.goto(p, {
      resume: 'here',
      onArrive: () => {
        this.writes.push(() => {
          for (const sp of spansInRange(range).slice(0, 40)) sp.classList.add('m-hl-green', 'm-hit');
        });
      },
    });
  }

  clearMarkup() { this.writes.push(() => this.marker.clearAll()); }
  setIntensity(level) { if (INTENSITY[level]) this.intensity = level; }
  togglePause() { this.paused = !this.paused; return this.paused; }
  toggleFollow() { this.follow = !this.follow; return this.follow; }

  queueScroll(y) {
    this.scrollWrite = Math.round(y);
  }

  // ================================================================ the loop ==
  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); // clamp big gaps (tab switches)
    this.last = now;
    this.readFrame();
    if (!this.paused && this.paper) {
      this.time += dt;
      this.update(dt, now);
    }
    this.draw(now);
    this.commit();
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ update --
  // READS ONLY. Anything that changes the DOM goes into this.writes.
  update(dt, now) {
    this.refreshLayout(now);
    if (this.mode === 'idle') return;

    if (this.mode === 'drop') {
      this.updateDrop(dt, now);
    } else {
      this.updateBrain(dt, now);
      this.updateBody(dt);
      this.updateLegs(dt, now);
      this.updateSection();
    }
    this.updateThread(dt);
    this.updateCamera(dt, now);

    // Trail threads fade out over ~8s.
    this.trail = this.trail.filter((t) => this.time - t.t < 8 && t.el.isConnected);
  }

  // --- the entrance: fall, bounce on the silk, splay legs ---------------------
  updateDrop(dt, now) {
    this.dropT += dt;
    const target = this.dropTarget;
    if (!this.fallDone) {
      this.vy = Math.min(this.vy + 1500 * dt, 560); // gravity with a terminal velocity
      this.pos.y += this.vy * dt;
      if (this.pos.y >= target.y) this.fallDone = true;
    } else {
      // A damped spring around the landing point: the silk stretches and bounces.
      const a = -(this.pos.y - target.y) * 95 - this.vy * 9;
      this.vy += a * dt;
      this.pos.y += this.vy * dt;
    }
    // Gentle pendulum sway while hanging.
    this.pos.x = target.x + Math.sin(this.dropT * 3.1) * 5 * Math.exp(-this.dropT * 0.8);
    this.angle = Math.PI / 2 + Math.sin(this.dropT * 2.3) * 0.12;

    // Legs stay tucked under the body.
    for (const leg of this.legs) {
      leg.hip = this.local(leg.hipLocal);
      leg.foot = this.local(leg.tuckLocal);
      leg.ideal = leg.foot;
      leg.lift = 0.7;
    }
    this.solveKnees();

    if (this.fallDone && Math.abs(this.pos.y - target.y) < 1.5 && Math.abs(this.vy) < 14) {
      this.land(now);
    }
  }

  land(now) {
    this.mode = 'landing';
    this.landedAt = this.time;
    this.vel = { x: 0, y: 0 };
    // Splay: every leg swings from its tucked pose out to a word near its rest pose.
    this.legs.forEach((leg) => {
      const rest = this.local(leg.restLocal);
      this.startStep(leg, rest, now + rand(0, 140), 240);
    });
    this.emit('landed');
  }

  // --- decide where to go ------------------------------------------------------
  updateBrain(dt, now) {
    if (this.mode === 'landing') {
      if (this.time - this.landedAt > 0.45) {
        this.mode = 'walk';
        this.pauseUntil = this.time + 0.8;
        const cb = this.onLand; this.onLand = null;
        if (cb) cb();
        if (this.queuedGoto) { const q = this.queuedGoto; this.queuedGoto = null; this.goto(...q); }
      }
      this.goal = null;
      this.targetSpeed = 0;
      return;
    }

    // A KEY phrase was found in commit(): measure it now and run there.
    if (this.pendingPoint) {
      const hit = this.pendingPoint; this.pendingPoint = null;
      const el = hit.spans[0];
      if (el.isConnected) {
        const r = this.rectDoc(el);
        this.goto({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, {
          resume: 'back',
          onArrive: () => {
            this.writes.push(() => this.marker.markKey(hit.spans));
            this.emit('pointed', hit);
          },
        });
      }
    }

    // Cursor chasing: active while the mouse moved in the last 1.2s.
    const chasing = this.mouse.inside && now - this.mouse.movedAt < 1200 && this.mode !== 'goto';
    if (chasing) {
      if (this.mode !== 'chase') this.mode = 'chase';
      const m = this.clientToDoc(this.mouse.cx, this.mouse.cy);
      this.goal = m;
      this.targetSpeed = CFG.chaseSpeed;
      this.arriveRadius = 26;
      return;
    }
    if (this.mode === 'chase') {
      // Done chasing: resume reading from wherever we ended up.
      this.mode = 'walk';
      this.readY = this.pos.y;
      this.waypoint = null;
    }

    if (this.mode === 'goto') {
      const g = this.gotoTarget;
      this.goal = g.p;
      this.targetSpeed = g.speed;
      this.arriveRadius = 6;
      if (dist(this.pos, g.p) < 10) {
        this.mode = 'walk';
        g.arrive();
      }
      return;
    }

    // --- autonomous reading: waypoints that zig-zag across the column and drift down.
    if (this.time < (this.pauseUntil || 0)) { this.targetSpeed = 0; return; }
    if (!this.waypoint || dist(this.pos, this.waypoint) < 22 || this.time > this.waypointDeadline) {
      if (this.waypoint && Math.random() < 0.3) {
        this.pauseUntil = this.time + rand(0.6, 2.2); // stop to "read"
        this.waypoint = null;
        this.targetSpeed = 0;
        return;
      }
      this.pickWaypoint();
    }
    this.goal = this.waypoint;
    // Speed breathes with noise so it never looks robotic.
    this.targetSpeed = CFG.cruiseSpeed * (0.75 + 0.45 * noise1(this.time * 0.5, 3));
    this.arriveRadius = 0;
  }

  pickWaypoint() {
    const { col, refsTop, bottom } = this.layout;
    this.readY = (this.readY ?? this.pos.y) + rand(40, 170) * CFG.readPace;
    // Stop progressing at References: the spider just mills about near the heading.
    const stopY = Math.min(refsTop + 90, (bottom || Infinity) - 60);
    this.readY = Math.min(this.readY, stopY);
    this.waypoint = {
      // Short hops sideways (like eyes along a line), never the full width at once.
      x: clamp(this.pos.x + rand(-260, 260), col.left + 20, col.right - 20),
      y: this.readY + rand(-25, 45),
    };
    this.waypointDeadline = this.time + 7;
    // Far away (e.g. returning after running back to a KEY phrase)? Re-drop there.
    if (Math.abs(this.waypoint.y - this.pos.y) > this.vh * CFG.teleportScreens) {
      const wp = this.waypoint;
      this.waypoint = null;
      this.drop(wp);
    }
  }

  // --- move the body toward the goal -------------------------------------------
  updateBody(dt) {
    let target = 0;
    if (this.goal && this.mode !== 'landing') {
      const dx = this.goal.x - this.pos.x, dy = this.goal.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      const want = Math.atan2(dy, dx);
      // Turn toward the goal at a limited rate, plus a little wander noise.
      const diff = angleDiff(this.angle, want);
      const turn = clamp(diff, -CFG.turnRate * dt, CFG.turnRate * dt);
      this.angle += turn + noise1(this.time * 0.9, 7) * 0.9 * dt;
      // Slow down when facing the wrong way (turn first) and when arriving.
      const facing = clamp(1 - Math.abs(diff) / 1.6, 0.15, 1);
      const arrive = clamp((d - (this.arriveRadius || 0)) / 50, 0, 1);
      target = (this.targetSpeed || 0) * facing * arrive;
    }
    this.speed = lerp(this.speed, target, clamp(dt * 5, 0, 1));
    const fwd = { x: Math.cos(this.angle), y: Math.sin(this.angle) };
    this.vel = { x: fwd.x * this.speed, y: fwd.y * this.speed };
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    // Stay on the paper.
    const { col } = this.layout;
    this.pos.x = clamp(this.pos.x, col.left - 30, col.right + 30);
    this.pos.y = Math.max(10, this.pos.y);
    if (this.thread?.attached) this.thread.travel += this.speed * dt;
  }

  // --- the gait -----------------------------------------------------------------
  updateLegs(dt, now) {
    const reach = CFG.femur + CFG.tibia;
    const lead = { x: this.vel.x * CFG.leadTime, y: this.vel.y * CFG.leadTime };

    for (const leg of this.legs) {
      leg.hip = this.local(leg.hipLocal);
      const rest = this.local(leg.restLocal);
      leg.ideal = { x: rest.x + lead.x, y: rest.y + lead.y };

      if (leg.swing) continue;
      // Planted feet track their word, so feet stay put as words scroll by.
      // If the word vanished or reflowed away, let go and re-step.
      if (leg.anchor) {
        const p = this.anchorPos(leg.anchor);
        if (!p || dist(p, leg.foot) > 30) { leg.anchor = null; leg.needsStep = true; }
        else leg.foot = p;
      }
      leg.drift = dist(leg.foot, leg.ideal);
      leg.overExtended = dist(leg.hip, leg.foot) > reach * 0.97;
    }

    // Alternating tetrapod: a group may only lift while the other group is fully
    // planted, so the spider always stands on 4 legs. The group that drifted
    // furthest goes first.
    const swinging = [0, 1].map((g) => this.legs.some((l) => l.group === g && l.swing));
    const worst = [0, 1].map((g) => Math.max(...this.legs.filter((l) => l.group === g).map((l) => l.drift || 0)));
    const order = worst[0] >= worst[1] ? [0, 1] : [1, 0];
    const threshold = CFG.stepThreshold * (this.speed < 5 ? 0.7 : 1);
    for (const g of order) {
      if (swinging[0] || swinging[1]) break;
      if (worst[g] > threshold) {
        for (const leg of this.legs) {
          if (leg.group === g && leg.drift > threshold * 0.35) this.startStep(leg, leg.ideal, now);
        }
        break;
      }
    }
    // Emergencies skip the queue: over-stretched legs and feet that lost their word.
    for (const leg of this.legs) {
      if (!leg.swing && (leg.overExtended || leg.needsStep)) this.startStep(leg, leg.ideal, now);
    }

    // Advance swings: eased lift -> swing -> plant arcs.
    for (const leg of this.legs) {
      const s = leg.swing;
      if (!s) { leg.lift = 0; continue; }
      const t = clamp((now - s.t0) / s.dur, 0, 1);
      if (now < s.t0) { leg.lift = 0; continue; } // staggered start (landing splay)
      const to = (s.anchor && this.anchorPos(s.anchor)) || s.to;
      const e = easeInOutCubic(t);
      const arc = Math.sin(t * Math.PI);
      // Arc outward, away from the body, as if the foot were lifted toward the camera.
      const out = { x: to.x - this.pos.x, y: to.y - this.pos.y };
      const ol = Math.hypot(out.x, out.y) || 1;
      leg.foot = {
        x: lerp(s.from.x, to.x, e) + (out.x / ol) * arc * CFG.stepLift,
        y: lerp(s.from.y, to.y, e) + (out.y / ol) * arc * CFG.stepLift,
      };
      leg.lift = arc;
      if (t >= 1) {
        leg.swing = null;
        leg.foot = to;
        leg.anchor = s.anchor;
        leg.lift = 0;
        if (s.anchor) this.onPlant(leg, s.anchor.el);
      }
    }

    this.solveKnees();
  }

  // Solve IK for every leg: where does each knee go, given hip and foot?
  solveKnees() {
    for (const leg of this.legs) {
      leg.knee = solveLeg(leg.hip, leg.foot, CFG.femur, CFG.tibia, leg.bend).knee;
    }
  }

  startStep(leg, target, now, dur) {
    const hold = this.findFoothold(target);
    const t = clamp(this.speed / CFG.runSpeed, 0, 1);
    leg.swing = {
      from: { ...leg.foot },
      to: hold.point,
      anchor: hold.anchor,
      t0: now,
      dur: dur ?? lerp(CFG.stepMsSlow, CFG.stepMsFast, t),
    };
    leg.anchor = null;
    leg.needsStep = false;
  }

  // --- footholds: snap a foot to the nearest real word --------------------------
  findFoothold(p) {
    const c = this.docToClient(p.x, p.y);
    const r = this.stageRect;
    if (c.x < r.left || c.x > r.right || c.y < r.top || c.y > r.bottom) return { point: p, anchor: null };
    // Probe the exact point, then a small ring around it, nearest first.
    const probes = [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [14, 10], [-14, 10], [14, -10], [-14, -10]];
    let fallback = null;
    for (const [ox, oy] of probes) {
      const el = document.elementFromPoint(c.x + ox, c.y + oy);
      if (!el || !this.paper.root.contains(el)) continue;
      const word = el.closest('.w');
      const target = word || el.closest('a, td, th');
      if (!target) continue;
      if (!word && !fallback) { fallback = target; continue; }
      return this.snapTo(target, c.x + ox, c.y + oy);
    }
    if (fallback) return this.snapTo(fallback, c.x, c.y);
    return { point: p, anchor: null };
  }

  snapTo(el, cx, cy) {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return { point: this.clientToDoc(cx, cy), anchor: null };
    // Land inside the word, slightly below its middle (on the "baseline").
    const fx = clamp((cx - rect.left) / rect.width, 0.15, 0.85);
    const fy = 0.6;
    const anchor = { el, fx, fy };
    return { point: this.anchorPos(anchor), anchor };
  }

  anchorPos(a) {
    if (!a.el.isConnected) return null;
    const r = this.rectDoc(a.el);
    if (!r.w && !r.h) return null;
    return { x: r.x + r.w * a.fx, y: r.y + r.h * a.fy };
  }

  onPlant(leg, el) {
    this.trail.push({ el, t: this.time });
    if (this.trail.length > CFG.trailWords) this.trail.shift();
    const block = el.closest(WORD_BLOCK_SEL);
    if (block) this.walked.add(block);
    if (el.classList.contains('w')) this.marker.onPlant(el, block);
  }

  // --- which section is the body in? -------------------------------------------
  updateSection() {
    if (this.mode === 'landing') return;
    const idx = this.sectionAt(this.pos.y);
    if (idx !== this.sectionIndex) {
      this.sectionIndex = idx;
      const s = this.paper.sections[idx];
      if (idx > 0 && s.heading) this.writes.push(() => s.heading.classList.add('m-hl-purple'));
      this.emit('section', { index: idx, section: s });
    }
  }

  // --- the drop-line --------------------------------------------------------------
  updateThread(dt) {
    const th = this.thread;
    if (!th) return;
    if (th.attached && this.mode !== 'drop' && th.travel > CFG.threadSnapDistance) {
      // Walked far enough: the silk snaps and recoils up to the top of the screen.
      th.attached = false;
      th.snapT = this.time;
      th.snapFrom = this.toScreen(this.abdomen());
    }
    if (!th.attached && this.time - th.snapT > 0.6) this.thread = null;
  }

  // --- camera ------------------------------------------------------------------
  updateCamera(dt, now) {
    if (this.mode === 'drop' || this.mode === 'landing') return;
    const manual = now < this.manualUntil;
    if (manual) { this.camY = this.scrollTop; this.wasManual = true; return; }

    if (this.wasManual) {
      this.wasManual = false;
      // The reader scrolled somewhere else. If the spider is off screen, drop
      // it into the new view rather than yanking the camera back.
      const sy = this.pos.y - this.scrollTop;
      if (this.follow && (sy < -40 || sy > this.vh + 40)) {
        const col = this.layout.col;
        this.drop({ x: rand(col.left + 40, col.right - 40), y: this.scrollTop + this.vh * CFG.cameraAnchor });
        return;
      }
    }
    if (!this.follow) { this.camY = this.scrollTop; return; }
    // While chasing the cursor the camera holds still (otherwise the cursor's doc
    // position would move with the scroll and the two would chase each other).
    if (this.mode === 'chase') { this.camY = this.scrollTop; return; }
    // Reached References: stop auto-scrolling.
    const inRefs = this.paper.sections[this.sectionIndex]?.isRefs;
    if (inRefs && this.mode === 'walk') { this.camY = this.scrollTop; return; }

    const want = clamp(this.pos.y - this.vh * CFG.cameraAnchor, 0, Math.max(0, this.maxScroll));
    if (this.camY == null) this.camY = this.scrollTop;
    // Critically-damped-ish follow: fast when far, gentle when close.
    this.camY = lerp(this.camY, want, clamp(dt * (this.mode === 'goto' ? 4 : 1.6), 0, 1));
    if (Math.abs(this.camY - this.scrollTop) >= 1) this.queueScroll(this.camY);
  }

  // ------------------------------------------------------------- body helpers --
  local(p) {
    const r = rot(p.x * CFG.scale, p.y * CFG.scale, this.angle);
    return { x: this.pos.x + r.x, y: this.pos.y + r.y };
  }
  abdomen() { return this.local({ x: -22, y: 0 }); }

  // ==================================================================== draw ==
  draw(now) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.paper || this.mode === 'idle') return;

    const S = (p) => this.toScreen(p);
    const ab = S(this.abdomen());

    // Trail: faint silk to recently touched words.
    const pts = [];
    for (const t of this.trail) {
      const r = t.el.getBoundingClientRect();
      if (!r.width) continue;
      pts.push({
        x: r.left - this.stageRect.left + r.width / 2,
        y: r.top - this.stageRect.top + r.height / 2,
        alpha: 1 - (this.time - t.t) / 8,
      });
    }
    drawTrail(ctx, ab, pts);

    // Drop-line: anchored to the top of the screen, swaying.
    const th = this.thread;
    if (th) {
      const sway = Math.sin(this.time * 1.7) * 10 + Math.sin(this.time * 4.3) * 3;
      if (th.attached) {
        drawThread(ctx, th.ax + Math.sin(this.time * 0.9) * 3, 0, ab.x, ab.y, sway);
      } else {
        // Snapped: the loose end recoils up to the anchor and fades.
        const k = easeInOutCubic(clamp((this.time - th.snapT) / 0.6, 0, 1));
        const end = { x: lerp(th.snapFrom.x, th.ax, k), y: lerp(th.snapFrom.y, 0, k) };
        drawThread(ctx, th.ax, 0, end.x, end.y, sway * (1 + 3 * (1 - k)), 1 - k);
      }
    }

    const p = S(this.pos);
    drawSpider(ctx, {
      x: p.x, y: p.y,
      angle: this.angle,
      scale: CFG.scale,
      height: this.mode === 'drop' ? 40 : 0,
      palp: (this.time * (this.speed > 5 ? 3 : 1.2)) % 1,
      legs: this.legs.map((l) => ({ hip: S(l.hip), knee: S(l.knee), foot: S(l.foot), lift: l.lift })),
    });

    if (this.debug) {
      const sec = this.paper.sections[this.sectionIndex];
      drawDebug(ctx, {
        stepThreshold: CFG.stepThreshold,
        goal: this.goal ? S(this.goal) : null,
        legs: this.legs.map((l) => ({
          name: l.name, hip: S(l.hip), knee: S(l.knee), foot: S(l.foot), ideal: S(l.ideal),
          swinging: !!l.swing, anchored: !!l.anchor, target: l.swing ? S(l.swing.to) : null,
        })),
        hud: [
          `mode: ${this.mode}${this.paused ? ' (paused)' : ''}  speed: ${this.speed.toFixed(0)}px/s`,
          `section: ${sec ? sec.label.slice(0, 28) : '-'}`,
          `pos: ${this.pos.x.toFixed(0)}, ${this.pos.y.toFixed(0)}  readY: ${(this.readY || 0).toFixed(0)}`,
          `follow: ${this.follow}  manual: ${performance.now() < this.manualUntil}  intensity: ${this.intensity}`,
          `fps: ${this.fps || '-'}`,
        ],
      });
      this.fpsFrames = (this.fpsFrames || 0) + 1;
      if (now - (this.fpsAt || 0) > 1000) { this.fps = this.fpsFrames; this.fpsFrames = 0; this.fpsAt = now; }
    }
  }

  // ================================================================== commit ==
  // The only place DOM writes happen.
  commit() {
    if (this.paper) this.paper.wrapper.flush(10);
    const writes = this.writes;
    this.writes = [];
    for (const w of writes) w();
    if (this.scrollWrite != null) {
      this.scroller.scrollTop = this.scrollWrite;
      this.expectedScroll = this.scrollWrite; // remember it so it isn't mistaken for manual
      this.scrollWrite = null;
    }
  }
}

function polarLocal(deg, r, side) {
  const a = (deg * Math.PI) / 180;
  return { x: Math.cos(a) * r, y: side * Math.sin(a) * r };
}

function spansInRange(range) {
  const root = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const all = root.classList?.contains('w') ? [root] : [...root.querySelectorAll('.w')];
  return all.filter((s) => range.intersectsNode(s));
}

// =============================================================================
// Marker: research-markup effects + smart targeting
//
// On every foot plant, onPlant() decides (using only reads) whether and how to
// mark the word, then queues the class changes as writes for commit().
// Words that look important (metrics, model and dataset names, citations,
// equation numbers, claim phrases) are always marked, and get the dramatic
// effects ~3x more often, so it looks like the spider hunts for what matters.
// =============================================================================

const KNOWN_MODELS = /^(transformers?|bert|roberta|albert|electra|gpt(-?\d+)?|t5|bart|llama|llama-?\d|mistral|mixtral|gemini|claude|palm|chinchilla|gopher|lora|qlora|resnet(-?\d+)?|vgg(-?\d+)?|alexnet|inception|efficientnet|mobilenet|densenet|unet|u-net|vit|deit|swin|clip|dall-?e|imagen|stable|diffusion|ddpm|ddim|gan|gans|vae|vaes|lstm|lstms|gru|grus|rnn|rnns|cnn|cnns|mlp|mlps|seq2seq|word2vec|glove|elmo|xlnet|adam|adamw|sgd|dropout|batchnorm|layernorm|bytenet|convs2s|moe|rlhf|dpo|ppo|alphago|alphafold|mamba|rwkv|whisper|sam|yolo|dino|mae|simclr|moco|byol)$/i;
const KNOWN_DATASETS = /^(imagenet(-?\d+k)?|cifar-?10{1,2}|mnist|fashion-?mnist|coco|ms-?coco|glue|superglue|squad|mmlu|wmt|wikitext(-?\d+)?|c4|lambada|hellaswag|piqa|winogrande|boolq|ptb|bookcorpus|wikipedia|commoncrawl|openwebtext|webtext|mnli|multinli|sst-?2|sst|conll(-?\d+)?|humaneval|mbpp|gsm8k|math|arc|triviaqa|naturalquestions|pile|laion(-?\d+[bm])?|kinetics(-?\d+)?|vqa|jft(-?\d+m)?|librispeech|coqa|race|swag|qnli|qqp|sts-?b|mrpc|rte|cola|wnli|ade20k|cityscapes|pascal|voc|celeba|lsun|ffhq|shapenet|nyu|kitti|truthfulqa|bigbench|big-bench|alpacaeval|mt-bench)$/i;
const METRIC_UNITS = /^(%|bleu|rouge(-[l\d])?|f1|em|accuracy|acc|ppl|perplexity|points?|map|auc|fid|is|top-?[15]|wer|cer|mse|mae|flops?|params?|parameters|tokens|x|×|times|days|hours|gpus?|tpus?)\b/i;
const CLAIMS = ['we propose', 'we introduce', 'we present', 'we show', 'outperform', 'novel', 'our results show',
  'state-of-the-art', 'state of the art', 'new state', 'significantly', 'surpass', 'achieves', 'first to'];
const STOP_CAPS = new Set(['I', 'A', 'AN', 'THE', 'IN', 'OF', 'TO', 'AND', 'OR', 'ON', 'AT', 'BY', 'FOR', 'IS', 'IT', 'AS', 'WE']);
// All-caps words that are metrics or plain acronyms, not model names.
const METRIC_NAMES = /^(bleu|rouge(-[l\d])?|meteor|cider|f1|em|map|auc|fid|wer|cer|ppl|mse|mae|rmse|ndcg|mrr|sota|flops?)$/i;
const NOT_MODELS = new Set(['GPU', 'GPUS', 'TPU', 'TPUS', 'CPU', 'NLP', 'ML', 'AI', 'API', 'RAM', 'US', 'UK', 'II', 'III', 'IV', 'OK', 'PDF', 'URL', 'ID', 'SOTA', 'FLOPS', 'FLOP']);

const BOX_COLORS = ['teal', 'purple', 'orange', 'red', 'green'];
const TEXT_COLORS = ['teal', 'purple', 'orange', 'red', 'magenta', 'green'];

class Marker {
  constructor(crawler) {
    this.c = crawler;
    this.wrappers = [];         // rotate-phrase wrappers we created (unwrapped on clear)
    this.blockWords = new WeakMap(); // block -> its .w spans (cached for neighbor lookups)
    this.noted = new Set();
  }

  words(block) {
    let list = this.blockWords.get(block);
    if (!list) { list = [...block.querySelectorAll('.w')]; this.blockWords.set(block, list); }
    return list;
  }

  /** What kind of word is this? Returns a set of tags. */
  classify(span, block) {
    const raw = span.textContent;
    const text = raw.replace(/^[(\[{"'“]+|[)\]}"'”,.;:!?]+$/g, '');
    const tags = new Set();
    const words = block ? this.words(block) : [span];
    const i = words.indexOf(span);
    const next = words[i + 1]?.textContent || '';

    if (span.closest('cite, .ltx_cite') || /^\[\d+([,–-]\s*\d*)*\]?[,.;]?$/.test(raw) || /^\(?[A-Z][a-z]+,?$/.test(raw) && /^et$/.test(next)) {
      tags.add('citation');
    }
    if (span.closest('.ltx_tag_equation') || /^\(\d+(\.\d+)?\)$/.test(raw)) tags.add('eqnum');

    const hasDigit = /\d/.test(text);
    if (hasDigit && (
      /%|×|x$/i.test(text) ||                // 92.1%  4x
      /^[+\-−]\d/.test(text) ||              // +3.2
      /^\d+\.\d+$/.test(text) ||             // 28.4
      /^\d{1,3}(,\d{3})+$/.test(text) ||     // 3,500
      /^\d+(\.\d+)?[kmbt]$/i.test(text) ||   // 175B, 65M
      METRIC_UNITS.test(next)                // 28.4 BLEU, 8 GPUs
    ) && !tags.has('citation')) tags.add('metric');

    if (METRIC_NAMES.test(text)) tags.add('metric');
    else if (KNOWN_DATASETS.test(text) || (/^wmt$/i.test(text) && /^\d{2,4}/.test(next))) tags.add('dataset');
    else if (KNOWN_MODELS.test(text) ||
             /^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(text) ||                    // CamelCase: BatchNorm, AlphaFold
             (/^[A-Z][A-Z0-9\-]{1,}[a-z]?s?$/.test(text) && !STOP_CAPS.has(text) && !NOT_MODELS.has(text.toUpperCase()))) { // ALL-CAPS: BERT, RLHF
      if (!/^[IVXLC]+$/.test(text)) tags.add('model'); // skip roman numerals
    }

    // Claim phrases ("we propose", "outperforms"...): look at a small window of
    // words around this one, but only tag words that are part of the phrase.
    const windowText = words.slice(Math.max(0, i - 2), i + 3).map((w) => w.textContent).join(' ').toLowerCase();
    const lower = text.toLowerCase();
    if (lower && CLAIMS.some((c) => windowText.includes(c) && c.split(/[\s-]/).some((part) => part && lower.startsWith(part)))) {
      tags.add('claim');
    }
    return tags;
  }

  onPlant(span, block) {
    const c = this.c;
    if (span.closest('h1, h2, h3, h4, h6')) return; // headings get the purple bar instead
    if (span.classList.contains('m-key')) return;    // keep the AI's KEY mark clean
    const cfg = INTENSITY[c.intensity];
    const tags = this.classify(span, block);
    const important = tags.size > 0;

    // Log metrics, models and datasets to the "Crawler Notes" tab (not the header's arXiv ID).
    if (!span.closest('.paper-head')) for (const type of ['metric', 'model', 'dataset']) {
      if (tags.has(type)) this.note(type, span, block);
    }

    if (Math.random() > (important ? cfg.important : cfg.mark)) return;
    if (span.dataset.m && Math.random() < 0.6) return; // already marked: usually leave it

    const effect = this.pick(span, tags, cfg);
    this.apply(effect, span, block);

    // Occasional bonus marks on nearby words or the whole line.
    if (block && Math.random() < cfg.neighbor * (important ? 2 : 1)) {
      const words = this.words(block);
      const i = words.indexOf(span);
      const j = i + (Math.random() < 0.5 ? -1 : 1) * Math.ceil(rand(1, 4));
      if (words[j]) this.apply(this.pick(words[j], new Set(), cfg), words[j], block);
    }
    if (block && Math.random() < cfg.line) this.apply('cyan-line', span, block);
  }

  /** Weighted random effect. Dramatic effects get x3 weight on important words. */
  pick(span, tags, cfg) {
    const important = tags.size > 0;
    const numeric = /\d/.test(span.textContent);
    const D = (important ? 3 : 1) * cfg.drama; // the smart-targeting multiplier
    const table = [
      ['box', 5],
      ['green', 2.2],
      ['color', 2],
      ['magenta', 0.8 * D],
      ['orange', 0.8 * D],
      ['cyan-line', 0.08 * D],
      ['rotate', 0.25 * D],
      ['blowup', numeric ? 1.6 * D : 0],
      ['promote', c_isWild(cfg) && important ? 0.4 * D : 0],
    ];
    // Nudge by category so each kind of thing gets a recognizable look.
    if (tags.has('metric')) table.push(['blowup', 4 * D], ['orange', 1.5 * D]);
    if (tags.has('model')) table.push(['box-purple', 3], ['magenta', 1.5 * D]);
    if (tags.has('dataset')) table.push(['box-green', 3], ['green', 2]);
    if (tags.has('citation')) table.push(['box-teal', 3], ['color-red', 2]);
    if (tags.has('eqnum')) table.push(['blowup-red', 4 * D]);
    if (tags.has('claim')) table.push(['orange', 3 * D], ['rotate', 1 * D]);

    let total = 0;
    for (const [, w] of table) total += w;
    let r = Math.random() * total;
    for (const [name, w] of table) { if ((r -= w) <= 0) return name; }
    return 'box';
  }

  /** Queue the DOM writes for an effect. Reads (line detection) happen here, now. */
  apply(effect, span, block) {
    const c = this.c;
    let classes = [];
    let targets = [span];
    switch (effect) {
      case 'box': classes = ['m-box-' + pickOne(BOX_COLORS)]; break;
      case 'box-purple': classes = ['m-box-purple']; break;
      case 'box-green': classes = ['m-box-green']; break;
      case 'box-teal': classes = ['m-box-teal']; break;
      case 'green': classes = ['m-hl-green']; break;
      case 'color': classes = ['m-color-text', 'm-c-' + pickOne(TEXT_COLORS)]; break;
      case 'color-red': classes = ['m-color-text', 'm-c-red']; break;
      case 'orange': classes = ['m-hl-orange']; break;
      case 'promote': classes = ['m-hl-orange', 'm-promote']; break;
      case 'magenta': classes = ['m-hl-magenta'].concat(Math.random() < 0.35 ? ['m-stretch'] : []); break;
      case 'blowup': classes = ['m-blowup'].concat(Math.random() < 0.3 ? ['m-red'] : [], Math.random() < 0.3 ? ['m-xl'] : []); break;
      case 'blowup-red': classes = ['m-blowup', 'm-red']; break;
      case 'cyan-line': {
        // The whole visual line: every word in the block sharing this word's top edge.
        if (!block) break;
        const top = span.getBoundingClientRect().top;
        targets = this.words(block).filter((w) => Math.abs(w.getBoundingClientRect().top - top) < 4);
        classes = ['m-hl-cyan'];
        break;
      }
      case 'rotate': {
        const words = block ? this.words(block) : [span];
        const i = words.indexOf(span);
        const phrase = words.slice(i, i + Math.ceil(rand(1, 3)));
        c.writes.push(() => this.rotatePhrase(phrase));
        return;
      }
    }
    if (!classes.length) return;
    c.writes.push(() => {
      for (const t of targets) {
        t.classList.add(...classes, 'm-hit');
        t.dataset.m = '1';
      }
    });
  }

  // Wrap 1–3 adjacent words in a rotated green span (they must share a parent).
  rotatePhrase(words) {
    if (!words.length || words[0].closest('.m-rotate-green')) return;
    const parent = words[0].parentNode;
    const run = [words[0]];
    for (const w of words.slice(1)) {
      if (w.parentNode !== parent) break;
      run.push(w);
    }
    const wrap = document.createElement('span');
    wrap.className = 'm-rotate-green m-hit';
    run[0].before(wrap);
    // Move the words, and the whitespace between them, into the wrapper.
    let node = run[0];
    const last = run[run.length - 1];
    while (node) {
      const nextNode = node.nextSibling;
      wrap.append(node);
      if (node === last) break;
      node = nextNode;
    }
    run.forEach((w) => { w.dataset.m = '1'; });
    this.wrappers.push(wrap);
  }

  /** The AI found this: biggest markup. Orange blow-up + red box. */
  markKey(spans) {
    const short = spans.length <= 3;
    for (const sp of spans) {
      if (sp.localName === 'math') { sp.classList.add('m-key', 'm-hl-orange', 'm-hit'); continue; }
      // Start clean: unwrap a rotated phrase and drop earlier marks on this word.
      const rotated = sp.closest('.m-rotate-green');
      if (rotated) rotated.replaceWith(...rotated.childNodes);
      for (const cls of [...sp.classList]) if (cls.startsWith('m-')) sp.classList.remove(cls);
      if (short || /\d/.test(sp.textContent)) sp.classList.add('m-blowup', 'm-key', 'm-hit');
      else sp.classList.add('m-hl-orange', 'm-key', 'm-hit');
      sp.dataset.m = '1';
    }
  }

  note(type, span, block) {
    const c = this.c;
    const section = c.paper.sections[c.sectionIndex]?.label || '';
    const text = span.textContent.replace(/[,.;:)\]]+$/, '');
    const key = `${type}|${text.toLowerCase()}|${section}`;
    if (this.noted.has(key)) return;
    this.noted.add(key);
    c.emit('note', { type, text, section, sentence: sentenceAround(block, span, c.paper), time: Date.now() });
  }

  clearAll() {
    for (const wrap of this.wrappers) {
      if (wrap.isConnected) wrap.replaceWith(...wrap.childNodes);
    }
    this.wrappers = [];
    for (const el of this.c.paper.root.querySelectorAll('[class*="m-"]')) {
      for (const cls of [...el.classList]) if (cls.startsWith('m-')) el.classList.remove(cls);
      delete el.dataset.m;
    }
  }
}

function c_isWild(cfg) { return cfg === INTENSITY.wild; }
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// The sentence containing a word, for the Crawler Notes log.
function sentenceAround(block, span, paper) {
  if (!block) return span.textContent;
  const text = paper.blockText(block);
  const word = span.textContent.trim();
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(\[])/);
  const hit = sentences.find((s) => s.includes(word)) || text;
  return hit.length > 320 ? hit.slice(0, 317) + '…' : hit;
}
