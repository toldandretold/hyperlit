/**
 * Canvas feedback loop engine for psychedelic vibe effects.
 * Each frame redraws itself with rotation/scale/blur/fade, seeding new colored shapes.
 * Lazy-loaded via dynamic import() from vibeCSS.js — zero cost for non-canvas vibes.
 */

let canvas = null;
let buffer = null;
let ctx = null;
let bufferCtx = null;
let rafId = null;
let resizeHandler = null;

// Parsed params
let blur = 0.5;
let rotation = 0.2;
let scale = 1.003;
let fade = 0.92;
let colors = [];
let intensity = 3;

/**
 * Start (or restart) the canvas feedback loop.
 * @param {object} params — parsed from --vibe-canvas-* keys (without prefix)
 */
export function startVibeCanvas(params) {
  stopVibeCanvas();

  // Parse params with defaults
  blur = clamp(parseFloat(params.blur) || 0.5, 0.1, 3);
  rotation = (clamp(parseFloat(params.rotation) || 0.2, 0.05, 1)) * Math.PI / 180;
  scale = clamp(parseFloat(params.scale) || 1.003, 1.001, 1.01);
  fade = clamp(parseFloat(params.fade) || 0.92, 0.8, 0.98);
  intensity = Math.round(clamp(parseFloat(params.intensity) || 3, 1, 8));

  // Parse colors — comma-separated hex, or fall back to CSS variables
  if (params.colors && params.colors.trim()) {
    colors = params.colors.split(',').map(c => c.trim()).filter(Boolean);
  } else {
    const style = getComputedStyle(document.documentElement);
    colors = ['--color-primary', '--color-accent', '--color-secondary']
      .map(k => style.getPropertyValue(k).trim())
      .filter(Boolean);
  }
  if (colors.length === 0) colors = ['#ff0080', '#00ff41', '#8338ec'];

  // Create main canvas
  canvas = document.createElement('canvas');
  canvas.id = 'vibe-canvas';
  document.body.prepend(canvas);

  // Create offscreen buffer
  buffer = document.createElement('canvas');

  // Size to half resolution
  sizeCanvases();

  ctx = canvas.getContext('2d');
  bufferCtx = buffer.getContext('2d');

  // Resize listener
  resizeHandler = () => sizeCanvases();
  window.addEventListener('resize', resizeHandler);

  // Start loop
  rafId = requestAnimationFrame(tick);
}

/**
 * Stop the canvas feedback loop and clean up.
 */
export function stopVibeCanvas() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
  canvas = null;
  buffer = null;
  ctx = null;
  bufferCtx = null;
}

function sizeCanvases() {
  const w = Math.round(window.innerWidth / 2);
  const h = Math.round(window.innerHeight / 2);
  if (canvas) { canvas.width = w; canvas.height = h; }
  if (buffer) { buffer.width = w; buffer.height = h; }
}

function tick() {
  if (!ctx || !bufferCtx || !canvas || !buffer) return;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;

  // Copy main → buffer
  bufferCtx.drawImage(canvas, 0, 0);

  // Clear main
  ctx.clearRect(0, 0, w, h);

  // Redraw buffer with rotation, scale, blur, fade
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  ctx.globalAlpha = fade;
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(buffer, -cx, -cy);
  ctx.restore();

  // Reset compositing state
  ctx.globalAlpha = 1;
  ctx.filter = 'none';

  // Seed new shapes
  for (let i = 0; i < intensity; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = Math.random() * 8 + 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  rafId = requestAnimationFrame(tick);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
