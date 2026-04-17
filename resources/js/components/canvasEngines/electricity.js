import { clamp, parseColors } from './utils.js';

const DEFAULT_COLORS = ['#00ffff', '#ffffff', '#8080ff', '#00ccff'];
const MAX = 20;

let bolts = [];
let colors, intensity, speed, spawnTimer;

function generateBolt(x0, y0, x1, y1) {
  const points = [{ x: x0, y: y0 }];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const segments = 6 + Math.floor(Math.random() * 8);
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    points.push({
      x: x0 + dx * t + (Math.random() - 0.5) * 60,
      y: y0 + dy * t + (Math.random() - 0.5) * 60,
    });
  }
  points.push({ x: x1, y: y1 });
  return points;
}

export default {
  init(params, w, h) {
    colors = parseColors(params.colors);
    if (colors.length === 0 || colors[0] === '#ff0080') colors = DEFAULT_COLORS;
    intensity = Math.round(clamp(parseFloat(params.intensity) || 3, 1, 8));
    speed = clamp(parseFloat(params.speed) || 1, 0.2, 3);
    bolts = [];
    spawnTimer = 0;
  },

  tick(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);

    // Spawn bolts periodically
    spawnTimer++;
    const interval = Math.max(3, Math.round(15 / speed));
    if (spawnTimer >= interval) {
      spawnTimer = 0;
      for (let i = 0; i < Math.min(intensity, 3) && bolts.length < MAX; i++) {
        const x0 = Math.random() * w;
        const y0 = Math.random() * h * 0.3;
        const x1 = x0 + (Math.random() - 0.5) * w * 0.4;
        const y1 = y0 + h * 0.3 + Math.random() * h * 0.4;
        bolts.push({
          points: generateBolt(x0, y0, x1, y1),
          color: colors[Math.floor(Math.random() * colors.length)],
          life: 8 + Math.floor(Math.random() * 12),
          age: 0,
          width: 1 + Math.random() * 2,
        });
      }
    }

    // Draw & age bolts
    ctx.save();
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.age += speed;
      const progress = b.age / b.life;
      if (progress >= 1) { bolts.splice(i, 1); continue; }

      const alpha = 1 - progress;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.width;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 15 * alpha;

      ctx.beginPath();
      ctx.moveTo(b.points[0].x, b.points[0].y);
      for (let j = 1; j < b.points.length; j++) {
        ctx.lineTo(b.points[j].x, b.points[j].y);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  cleanup() { bolts = []; }
};
