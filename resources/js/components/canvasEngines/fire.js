import { clamp, parseColors } from './utils.js';

const DEFAULT_COLORS = ['#ff4500', '#ff6b35', '#ffa500', '#ff0000', '#ffcc00'];
const MAX = 200;

let particles = [];
let colors, intensity, speed, w0, h0;

export default {
  init(params, w, h) {
    w0 = w; h0 = h;
    colors = parseColors(params.colors);
    if (colors.length === 0 || colors[0] === '#ff0080') colors = DEFAULT_COLORS;
    intensity = Math.round(clamp(parseFloat(params.intensity) || 4, 1, 8));
    speed = clamp(parseFloat(params.speed) || 1, 0.2, 3);
    particles = [];
  },

  tick(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);

    // Spawn new particles from bottom
    for (let i = 0; i < intensity && particles.length < MAX; i++) {
      particles.push({
        x: Math.random() * w,
        y: h + Math.random() * 10,
        vx: (Math.random() - 0.5) * 1.5,
        vy: -(1.5 + Math.random() * 2.5) * speed,
        r: 3 + Math.random() * 6,
        alpha: 0.8 + Math.random() * 0.2,
        color: colors[Math.floor(Math.random() * colors.length)],
        flicker: Math.random() * Math.PI * 2,
      });
    }

    // Update & draw
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx + Math.sin(p.flicker) * 0.8;
      p.y += p.vy;
      p.flicker += 0.15 * speed;
      p.alpha -= 0.008 * speed;
      p.r *= 0.995;

      if (p.alpha <= 0 || p.y < -10) { particles.splice(i, 1); continue; }

      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  cleanup() { particles = []; }
};
