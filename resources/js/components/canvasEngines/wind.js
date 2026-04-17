import { clamp, parseColors } from './utils.js';

const DEFAULT_COLORS = ['#e0e0e0', '#b0c4de', '#d3d3d3', '#a8c8e0', '#f0f0f0'];
const MAX = 150;

let streaks = [];
let colors, intensity, speed, frame;

export default {
  init(params, w, h) {
    colors = parseColors(params.colors);
    if (colors.length === 0 || colors[0] === '#ff0080') colors = DEFAULT_COLORS;
    intensity = Math.round(clamp(parseFloat(params.intensity) || 3, 1, 8));
    speed = clamp(parseFloat(params.speed) || 1, 0.2, 3);
    streaks = [];
    frame = 0;
  },

  tick(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    frame++;

    // Spawn streaks on left edge
    for (let i = 0; i < intensity && streaks.length < MAX; i++) {
      streaks.push({
        x: -Math.random() * 30,
        y: Math.random() * h,
        len: 30 + Math.random() * 80,
        vx: (2 + Math.random() * 4) * speed,
        wobble: Math.random() * Math.PI * 2,
        wobbleAmp: 0.3 + Math.random() * 1.2,
        alpha: 0.2 + Math.random() * 0.4,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    // Update & draw
    for (let i = streaks.length - 1; i >= 0; i--) {
      const s = streaks[i];
      s.x += s.vx;
      s.y += Math.sin(s.wobble + frame * 0.03) * s.wobbleAmp;

      if (s.x > w + s.len) { streaks.splice(i, 1); continue; }

      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1 + Math.random() * 0.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + s.len, s.y + Math.sin(s.wobble + frame * 0.03) * 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },

  cleanup() { streaks = []; }
};
