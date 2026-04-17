import { clamp, parseColors } from './utils.js';

let buffer = null;
let bufferCtx = null;
let blur, rotation, scale, fade, colors, intensity, blend, drift, shape, speed, frame;

function drawShape(ctx, x, y, type) {
  const SHAPES = ['circle', 'line', 'rect'];
  const pick = type === 'mixed' ? SHAPES[Math.floor(Math.random() * SHAPES.length)] : type;

  if (pick === 'line') {
    const len = Math.random() * 20 + 8;
    const angle = Math.random() * Math.PI * 2;
    ctx.lineWidth = Math.random() * 2 + 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  } else if (pick === 'rect') {
    const size = Math.random() * 12 + 3;
    ctx.fillRect(x - size / 2, y - size / 2, size, size * (0.5 + Math.random()));
  } else {
    const r = Math.random() * 8 + 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default {
  init(params, w, h) {
    blur = clamp(parseFloat(params.blur) || 0.5, 0.1, 3);
    rotation = clamp(parseFloat(params.rotation) || 0.2, 0.05, 1) * Math.PI / 180;
    scale = clamp(parseFloat(params.scale) || 1.003, 1.001, 1.01);
    fade = clamp(parseFloat(params.fade) || 0.92, 0.8, 0.98);
    intensity = Math.round(clamp(parseFloat(params.intensity) || 3, 1, 8));
    speed = clamp(parseFloat(params.speed) || 1, 0.2, 3);
    colors = parseColors(params.colors);
    frame = 0;

    const VALID_BLENDS = ['source-over', 'lighter', 'screen', 'overlay', 'multiply'];
    blend = VALID_BLENDS.includes(params.blend) ? params.blend : 'source-over';
    drift = clamp(parseFloat(params.drift) || 0, 0, 50);
    const VALID_SHAPES = ['circle', 'line', 'rect', 'mixed'];
    shape = VALID_SHAPES.includes(params.shape) ? params.shape : 'circle';

    buffer = document.createElement('canvas');
    buffer.width = w;
    buffer.height = h;
    bufferCtx = buffer.getContext('2d');
  },

  tick(ctx, w, h) {
    if (!bufferCtx || !buffer) return;
    const cx = w / 2;
    const cy = h / 2;
    frame++;

    bufferCtx.drawImage(ctx.canvas, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const driftX = drift ? Math.sin(frame * 0.013 * speed) * drift : 0;
    const driftY = drift ? Math.cos(frame * 0.009 * speed) * drift : 0;

    ctx.save();
    ctx.globalCompositeOperation = blend;
    ctx.translate(cx + driftX, cy + driftY);
    ctx.rotate(rotation * speed);
    ctx.scale(scale, scale);
    ctx.globalAlpha = fade;
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(buffer, -cx, -cy);
    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';

    for (let i = 0; i < intensity; i++) {
      const color = colors[Math.floor(Math.random() * colors.length)];
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      drawShape(ctx, Math.random() * w, Math.random() * h, shape);
    }
  },

  cleanup() {
    buffer = null;
    bufferCtx = null;
  }
};
