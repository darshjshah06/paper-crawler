// =============================================================================
// spider-draw.js: pure rendering. Given the spider's state (already in
// screen pixels), paint it, its silk drop-line and its trail threads on a
// 2D canvas. No DOM reads, no game logic, so it's cheap and easy to restyle.
//
// Look: glossy black elongated body (thorax + abdomen), a tiny white eye,
// 8 thin cyan two-segment legs with red dots at knees and feet, 2 short palps.
// =============================================================================

export const COLORS = {
  leg: '#19c3d6',
  joint: '#e0303a',
  body: '#07080a',
  silk: 'rgba(40, 40, 48, 0.55)',
  trail: 'rgba(25, 195, 214, 0.28)',
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} s  spider in screen coords:
 *   x, y, angle            body center and heading (radians, 0 = facing right)
 *   scale                  overall size multiplier
 *   height                 0 on the page, >0 while hanging (enlarges the shadow)
 *   palp                   0..1 palp twitch phase
 *   legs[]                 { hip, knee, foot: {x,y}, lift: 0..1 }
 */
export function drawSpider(ctx, s) {
  const k = s.scale;

  // --- soft shadow (offset grows with height, so a dangling spider "floats") ---
  ctx.save();
  ctx.translate(s.x + 3 + s.height * 0.12, s.y + 5 + s.height * 0.2);
  ctx.rotate(s.angle);
  ctx.fillStyle = `rgba(0,0,0,${0.16 / (1 + s.height * 0.01)})`;
  ctx.beginPath();
  ctx.ellipse(-8 * k, 0, 20 * k, 8 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // --- legs (drawn first so the body covers the hips) ---
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const leg of s.legs) {
    const lift = leg.lift || 0;
    ctx.strokeStyle = COLORS.leg;
    // femur: hip -> knee
    ctx.lineWidth = 1.7 * k;
    ctx.beginPath();
    ctx.moveTo(leg.hip.x, leg.hip.y);
    ctx.lineTo(leg.knee.x, leg.knee.y);
    ctx.stroke();
    // tibia: knee -> foot (slightly thinner)
    ctx.lineWidth = 1.3 * k;
    ctx.beginPath();
    ctx.moveTo(leg.knee.x, leg.knee.y);
    ctx.lineTo(leg.foot.x, leg.foot.y);
    ctx.stroke();
  }
  ctx.fillStyle = COLORS.joint;
  for (const leg of s.legs) {
    dot(ctx, leg.knee.x, leg.knee.y, 1.9 * k);
    // A lifted foot is drawn a little bigger, as if closer to the camera.
    dot(ctx, leg.foot.x, leg.foot.y, (1.8 + (leg.lift || 0) * 1.2) * k);
  }

  // --- body, in the spider's local frame (x = forward, y = right) ---
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  ctx.scale(k, k);

  // palps: two short feelers at the front that twitch
  const tw = Math.sin(s.palp * Math.PI * 2) * 0.25;
  ctx.strokeStyle = COLORS.body;
  ctx.lineWidth = 1.4;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(8, side * 1.6);
    ctx.quadraticCurveTo(12, side * (3.2 + tw * 2), 14 + tw * 2, side * (2.2 + tw));
    ctx.stroke();
  }

  // abdomen: long glossy teardrop behind the thorax
  glossyEllipse(ctx, -15, 0, 13, 6.4);
  // pedicel (the thin waist)
  ctx.fillStyle = COLORS.body;
  ctx.fillRect(-4, -1.4, 4, 2.8);
  // thorax (cephalothorax)
  glossyEllipse(ctx, 2, 0, 7, 4.6);
  // the tiny white eye
  ctx.fillStyle = '#fff';
  dot(ctx, 7.2, 0, 1.15);

  ctx.restore();
}

function glossyEllipse(ctx, cx, cy, rx, ry) {
  // Black body with a soft specular highlight up and to the left.
  const g = ctx.createRadialGradient(cx - rx * 0.35, cy - ry * 0.45, 0.5, cx, cy, Math.max(rx, ry));
  g.addColorStop(0, '#5b6370');
  g.addColorStop(0.25, '#1b1e24');
  g.addColorStop(1, COLORS.body);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The drop-line: a single silk thread from the top of the screen to the spider.
 * `sway` bends it into a gentle curve; `slack` (0..1) makes it droop after a snap.
 */
export function drawThread(ctx, ax, ay, bx, by, sway, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = COLORS.silk;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  const mx = (ax + bx) / 2 + sway;
  const my = (ay + by) / 2;
  ctx.quadraticCurveTo(mx, my, bx, by);
  ctx.stroke();
  // a tiny glint where the thread is anchored
  ctx.fillStyle = COLORS.silk;
  dot(ctx, ax, ay, 1.6);
  ctx.restore();
}

/** Faint threads from the abdomen to the last few words the spider touched. */
export function drawTrail(ctx, from, points) {
  ctx.save();
  ctx.lineWidth = 0.8;
  for (const p of points) {
    ctx.strokeStyle = `rgba(25, 195, 214, ${0.32 * p.alpha})`;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // sag slightly, like real silk
    const mx = (from.x + p.x) / 2;
    const my = (from.y + p.y) / 2 + Math.min(30, Math.hypot(p.x - from.x, p.y - from.y) * 0.08);
    ctx.quadraticCurveTo(mx, my, p.x, p.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** ?debug overlay: IK bones, rest targets, step thresholds, and a HUD. */
export function drawDebug(ctx, dbg) {
  ctx.save();
  ctx.font = '11px ui-monospace, Menlo, monospace';
  for (const leg of dbg.legs) {
    // step threshold circle around the leg's ideal (rest) foot position
    ctx.strokeStyle = leg.swinging ? 'rgba(255,122,61,.8)' : 'rgba(123,44,255,.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(leg.ideal.x, leg.ideal.y, dbg.stepThreshold, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // ideal target
    ctx.fillStyle = 'rgba(123,44,255,.9)';
    ctx.fillRect(leg.ideal.x - 2, leg.ideal.y - 2, 4, 4);
    // IK chain hip -> knee -> foot in contrasting colors
    ctx.strokeStyle = 'rgba(255,0,120,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leg.hip.x, leg.hip.y);
    ctx.lineTo(leg.knee.x, leg.knee.y);
    ctx.lineTo(leg.foot.x, leg.foot.y);
    ctx.stroke();
    // a line from foot to its swing target while stepping
    if (leg.swinging && leg.target) {
      ctx.strokeStyle = 'rgba(255,122,61,.9)';
      ctx.beginPath();
      ctx.moveTo(leg.foot.x, leg.foot.y);
      ctx.lineTo(leg.target.x, leg.target.y);
      ctx.stroke();
    }
    ctx.fillStyle = leg.anchored ? '#2fbf5b' : '#999';
    ctx.fillText(leg.name, leg.foot.x + 4, leg.foot.y - 4);
  }
  if (dbg.goal) {
    ctx.strokeStyle = 'rgba(0,160,255,.9)';
    ctx.beginPath();
    ctx.arc(dbg.goal.x, dbg.goal.y, 8, 0, Math.PI * 2);
    ctx.moveTo(dbg.goal.x - 12, dbg.goal.y);
    ctx.lineTo(dbg.goal.x + 12, dbg.goal.y);
    ctx.moveTo(dbg.goal.x, dbg.goal.y - 12);
    ctx.lineTo(dbg.goal.x, dbg.goal.y + 12);
    ctx.stroke();
  }
  // HUD
  ctx.fillStyle = 'rgba(0,0,0,.75)';
  ctx.fillRect(8, 8, 270, 16 * dbg.hud.length + 8);
  ctx.fillStyle = '#7ff3ff';
  dbg.hud.forEach((line, i) => ctx.fillText(line, 14, 24 + i * 16));
  ctx.restore();
}
