/**
 * Lava-lamp background: layered "hills" of overlapping gradient domes (leafs),
 * slowly morphing like a lava lamp. Port of the backgrounds/demo.html playground.
 *
 * - Deterministic: same seed → same leaf shapes every frame, so animating the
 *   hill parameters (H/W/x) reads as smooth liquid, never re-randomising.
 * - Only path `d` attributes change per frame (~30fps); gradients are static.
 * - Respects prefers-reduced-motion (renders one static frame, no loop).
 * - Hidden adjuster panel: Shift+L toggles it (tune, then Copy settings and
 *   bake the JSON into DEFAULT_CFG / the fuller playground at backgrounds/demo.html).
 */

import { verbose } from '../../utilities/logger';

interface Cluster {
  x: number;      // apex x of the tallest (back) leaf
  H: number;      // height of the tallest leaf
  W: number;      // half-width of the tallest leaf
  n: number;      // leaf count
  stepDown: number; // size drop per leaf (0 = even row)
  stepX: number;    // sideways march per leaf
  scatter: number;  // random x spread (bumpy horizon)
}

export interface LavaCfg {
  seed: number;
  wobble: number;
  scatterMul: number;
  pinkHold: number;
  orangePos: number;
  aquaPos: number;
  phase: number;
  animSpeed: number;
  animAmt: number;
  clusters: Cluster[];
}

const DEFAULT_CFG: LavaCfg = {
  seed: 5,
  wobble: 0.015,
  scatterMul: 1.0,
  pinkHold: 0.08,
  orangePos: 0.42,
  aquaPos: 0.82,
  phase: 0.16,
  animSpeed: 1.0,
  animAmt: 0.6,
  clusters: [
    { x: 1040, H: 900, W: 210, n: 10, stepDown: 0.06, stepX: 26,  scatter: 30 },
    { x: 860,  H: 320, W: 250, n: 7,  stepDown: 0.02, stepX: -10, scatter: 120 },
    { x: 470,  H: 470, W: 430, n: 9,  stepDown: 0.07, stepX: 30,  scatter: 40 },
    { x: 1390, H: 430, W: 340, n: 6,  stepDown: 0.05, stepX: -25, scatter: 50 },
    { x: 1720, H: 690, W: 520, n: 10, stepDown: 0.06, stepX: -40, scatter: 60 },
    { x: 280,  H: 165, W: 480, n: 7,  stepDown: 0.03, stepX: 18,  scatter: 150 },
    { x: 1080, H: 130, W: 440, n: 6,  stepDown: 0.03, stepX: -15, scatter: 160 },
  ],
};

const BASE_Y = 1001;
const VW = 1600;
const VH = 1000;
const BASE_BLUSH = '#F0A9C9';

type Rng = () => number;

function mulberry32(a: number): Rng {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface Blob { d: string; pink: number; orange: number; aqua: number; }

function domePath(rng: Rng, cx: number, rx: number, ry: number, wobble: number): string {
  const lean = (rng() - 0.5) * 0.20;
  const terms: Array<[number, number, number]> = [
    [wobble * (0.6 + rng() * 0.6), 3 + rng() * 4, rng() * 6.283],
    [wobble * (0.3 + rng() * 0.4), 7 + rng() * 6, rng() * 6.283],
  ];
  const pts: Array<[number, number]> = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const th = (Math.PI * i) / N;
    let nz = 0;
    for (const [a, k, p] of terms) nz += a * Math.sin(k * th + p);
    const w = 1 + nz * Math.sqrt(Math.sin(th));
    const x = cx - rx * Math.cos(th) * w + lean * rx * Math.sin(th);
    const y = Math.min(BASE_Y, BASE_Y - ry * Math.sin(th) * w);
    pts.push([x, y]);
  }
  const at = (i: number): [number, number] => pts[clamp(i, 0, pts.length - 1)] ?? [0, BASE_Y];
  const start = at(0);
  let d = `M ${start[0].toFixed(0)} ${start[1].toFixed(0)} `;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${c1x.toFixed(0)} ${c1y.toFixed(0)} ${c2x.toFixed(0)} ${c2y.toFixed(0)} ${p2[0].toFixed(0)} ${p2[1].toFixed(0)} `;
  }
  return d + 'Z';
}

class LavaLamp {
  private cfg: LavaCfg;
  private root: HTMLDivElement;
  private pathEls: SVGPathElement[] = [];
  private simT = 0;
  private lastNow = 0;
  private lastFrame = 0;
  private rafId = 0;
  private running = false;
  private reducedMotion: boolean;
  private adjuster: HTMLDivElement | null = null;
  private keyHandler: (e: KeyboardEvent) => void;

  constructor(mount: HTMLElement, cfg: LavaCfg) {
    this.cfg = cfg;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.root = document.createElement('div');
    this.root.className = 'lava-lamp-bg';
    this.root.setAttribute('aria-hidden', 'true');
    mount.prepend(this.root);
    this.renderFull();
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'L' && e.shiftKey && !this.isTypingTarget(e.target)) this.toggleAdjuster();
    };
    document.addEventListener('keydown', this.keyHandler);
    if (this.reducedMotion) {
      // Don't freeze (the deck-art motion IS the page) — go gentle instead:
      // slower cycles, smaller morphs. Shift+L still allows full pause.
      this.cfg.animSpeed *= 0.5;
      this.cfg.animAmt *= 0.4;
      verbose.init('lavaLamp: prefers-reduced-motion — gentle mode (Shift+L to pause/adjust)', 'components/lavaLamp');
    }
    this.start();
  }

  destroy(): void {
    this.stop();
    document.removeEventListener('keydown', this.keyHandler);
    this.adjuster?.remove();
    this.adjuster = null;
    this.root.remove();
  }

  private isTypingTarget(t: EventTarget | null): boolean {
    return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = (now - this.lastNow) / 1000;
      this.lastNow = now;
      this.simT += dt * this.cfg.animSpeed;
      if (now - this.lastFrame > 33) {
        this.lastFrame = now;
        const blobs = this.buildBlobs();
        if (blobs.length !== this.pathEls.length) this.renderFull();
        else blobs.forEach((b, i) => this.pathEls[i]?.setAttribute('d', b.d));
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private animCluster(c: Cluster, ci: number): Cluster {
    const k = this.cfg.animAmt;
    if (this.simT === 0 || k === 0) return c;
    const per = 24 + (((ci * 9301 + 49297) % 233) / 233) * 26;
    const ph = ci * 1.7;
    const e = Math.sin((this.simT * 2 * Math.PI) / per + ph);
    const sway = Math.sin((this.simT * 2 * Math.PI) / (per * 1.9) + ph * 2.3);
    return {
      ...c,
      H: c.H * (1 + e * 0.55 * k),
      W: c.W * (1 - e * 0.45 * k),
      x: c.x + sway * 90 * k,
      stepX: c.stepX * (1 + sway * 0.4 * k),
    };
  }

  private gradStops(rng: Rng, damp: boolean): { pink: number; orange: number; aqua: number } {
    const ph = this.cfg.phase * (damp ? 0.4 : 1);
    const shift = () => (rng() - 0.5) * 2 * ph;
    const pink = clamp(this.cfg.pinkHold + shift() * 0.6, 0.0, 0.45);
    const orange = clamp(this.cfg.orangePos + shift(), pink + 0.08, 0.85);
    const aqua = clamp(this.cfg.aquaPos + shift() * 0.7, orange + 0.08, 0.985);
    return { pink, orange, aqua };
  }

  private buildBlobs(): Blob[] {
    const cfg = this.cfg;
    const blobs: Blob[] = [];
    const k = cfg.animAmt;
    cfg.clusters.forEach((cBase, ci) => {
      const c = this.animCluster(cBase, ci);
      const rng = mulberry32(cfg.seed * 7919 + ci * 1013);
      for (let i = 0; i < c.n; i++) {
        const ry = c.H * Math.pow(1 - c.stepDown, i) * (1 + (rng() - 0.5) * 0.10);
        const rx = c.W * Math.pow(ry / c.H, 0.75) * (1 + (rng() - 0.5) * 0.20);
        const x = c.x + c.stepX * i + (rng() - 0.5) * 2 * c.scatter;
        blobs.push({ d: domePath(rng, x, rx, ry, cfg.wobble), ...this.gradStops(rng, false) });
      }
    });
    const bobX = (i: number) => (this.simT ? Math.sin(this.simT * 0.15 + i * 1.9) * 30 * k : 0);
    const bobY = (i: number) => (this.simT ? 1 + 0.08 * k * Math.sin(this.simT * 0.21 + i * 2.7) : 1);
    const sRng = mulberry32(cfg.seed * 104729 + 17);
    const mid = Math.round(8 * cfg.scatterMul);
    const front = Math.round(12 * cfg.scatterMul);
    const tiny = Math.round(9 * cfg.scatterMul);
    const mids: Blob[] = [];
    for (let i = 0; i < mid; i++) {
      const ry = (140 + sRng() * 180) * bobY(i);
      const rx = ry * (1.3 + sRng() * 1.9);
      mids.push({ d: domePath(sRng, 560 + sRng() * 390 + bobX(i), rx, ry, cfg.wobble), ...this.gradStops(sRng, true) });
    }
    const firstN = cfg.clusters[0] ? cfg.clusters[0].n : 0;
    blobs.splice(firstN, 0, ...mids);
    for (let i = 0; i < front; i++) {
      const ry = (70 + sRng() * 130) * bobY(i + 40);
      const rx = ry * (1.3 + sRng() * 1.9);
      blobs.push({ d: domePath(sRng, -80 + sRng() * 1780 + bobX(i + 40), rx, ry, cfg.wobble), ...this.gradStops(sRng, true) });
    }
    for (let i = 0; i < tiny; i++) {
      const ry = (45 + sRng() * 65) * bobY(i + 80);
      const rx = ry * (1.3 + sRng() * 1.9);
      blobs.push({ d: domePath(sRng, -80 + sRng() * 1780 + bobX(i + 80), rx, ry, cfg.wobble), ...this.gradStops(sRng, true) });
    }
    return blobs;
  }

  private renderFull(): void {
    const blobs = this.buildBlobs();
    let defs = '';
    let paths = '';
    blobs.forEach((b, i) => {
      defs += `<linearGradient id="lava-g${i}" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="var(--hyperlit-pink)"/>`
        + (b.pink > 0.01 ? `<stop offset="${b.pink.toFixed(2)}" stop-color="var(--hyperlit-pink)"/>` : '')
        + `<stop offset="${b.orange.toFixed(2)}" stop-color="var(--hyperlit-orange)"/>`
        + `<stop offset="${b.aqua.toFixed(2)}" stop-color="var(--hyperlit-aqua)"/>`
        + `<stop offset="1" stop-color="${BASE_BLUSH}"/>`
        + `</linearGradient>`;
      paths += `<path d="${b.d}" fill="url(#lava-g${i})"/>`;
    });
    this.root.innerHTML =
      `<svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMax slice"><defs>${defs}</defs>${paths}</svg>`;
    this.pathEls = Array.from(this.root.querySelectorAll('path'));
  }

  /* ---------- hidden adjuster (Shift+L) ---------- */

  private toggleAdjuster(): void {
    if (this.adjuster) {
      this.adjuster.remove();
      this.adjuster = null;
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'lava-adjuster';
    panel.innerHTML =
      `<strong>lava${this.reducedMotion ? ' (reduced motion: gentle mode)' : ''}</strong>`
      + this.sliderRow('speed', 0.2, 4, 0.1, this.cfg.animSpeed)
      + this.sliderRow('amount', 0, 1, 0.05, this.cfg.animAmt)
      + this.sliderRow('wobble', 0, 0.06, 0.005, this.cfg.wobble)
      + this.sliderRow('phase', 0, 0.4, 0.02, this.cfg.phase)
      + `<div><button type="button" data-act="animate">${this.running ? '⏸ pause' : '▶ animate'}</button>`
      + `<button type="button" data-act="reroll">🎲 re-roll</button>`
      + `<button type="button" data-act="copy">copy settings</button></div>`;
    document.body.appendChild(panel);
    panel.querySelectorAll('input[type=range]').forEach(el => {
      el.addEventListener('input', () => {
        const input = el as HTMLInputElement;
        const key = input.dataset.key as 'animSpeed' | 'animAmt' | 'wobble' | 'phase';
        this.cfg[key] = parseFloat(input.value);
        if (key === 'wobble' || key === 'phase') this.renderFull();
      });
    });
    const animate = panel.querySelector('[data-act="animate"]');
    animate?.addEventListener('click', () => {
      // explicit user action — overrides prefers-reduced-motion
      if (this.running) this.stop(); else this.start();
      animate.textContent = this.running ? '⏸ pause' : '▶ animate';
    });
    const reroll = panel.querySelector('[data-act="reroll"]');
    reroll?.addEventListener('click', () => {
      this.cfg.seed = Math.floor(Math.random() * 100000);
      this.renderFull();
    });
    const copy = panel.querySelector('[data-act="copy"]');
    copy?.addEventListener('click', () => {
      void navigator.clipboard.writeText(JSON.stringify(this.cfg, null, 2));
    });
    this.adjuster = panel;
  }

  private sliderRow(label: string, min: number, max: number, step: number, value: number): string {
    const key = { speed: 'animSpeed', amount: 'animAmt', wobble: 'wobble', phase: 'phase' }[label];
    return `<label>${label}<input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
  }
}

let instance: LavaLamp | null = null;

export function initLavaLamp(cfg: Partial<LavaCfg> = {}): void {
  const mount = document.getElementById('lava-lamp-mount');
  if (!mount) return; // page doesn't want the lava background
  if (instance) return; // create-once; survives repeated init calls
  instance = new LavaLamp(mount, { ...DEFAULT_CFG, ...cfg });
}

export function destroyLavaLamp(): void {
  instance?.destroy();
  instance = null;
}
