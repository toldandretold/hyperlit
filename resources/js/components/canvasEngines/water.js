import { clamp, parseColors } from './utils.js';

const DEFAULT_COLORS = ['#1e90ff', '#00bfff', '#4dd0e1', '#0077be', '#87ceeb'];
const MAX = 100;

let ripples = [];
let colors, intensity, speed, spawnTimer;

export default {
  init(params, w, h) {
    colors = parseColors(params.colors);
    if (colors.length === 0 || colors[0] === '#ff0080') colors = DEFAULT_COLORS;
    intensity = Math.round(clamp(parseFloat(params.intensity) || 3, 1, 8));
    speed = clamp(parseFloat(params.speed) || 1, 0.2, 3);
    ripples = [];
    spawnTimer = 0;
  },

  tick(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);

    // Spawn ripples periodically (not every frame)
    spawnTimer++;
    if (spawnTimer >= Math.max(3, Math.round(10 / speed))) {
      spawnTimer = 0;
      for (let i = 0; i < intensity && ripples.length < MAX; i++) {
        ripples.push({
          x: Math.random() * w,
          y: Math.random() * h,
          radius: 1,
          maxRadius: 40 + Math.random() * 60,
          alpha: 0.7 + Math.random() * 0.3,
          color: colors[Math.floor(Math.random() * colors.length)],
          lineWidth: 2 + Math.random() * 2,
        });
      }
    }

    // Update & draw
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.radius += (0.5 + Math.random() * 0.5) * speed;
      const progress = r.radius / r.maxRadius;
      r.alpha = (1 - progress) * 0.8;
      r.lineWidth = Math.max(0.3, (1 - progress) * 3);

      if (r.radius >= r.maxRadius) { ripples.splice(i, 1); continue; }

      ctx.globalAlpha = r.alpha;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.lineWidth;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },

  cleanup() { ripples = []; }
};
