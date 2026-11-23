/**
 * Smoke / cloud layer for the lava-lamp background.
 *
 * A handful of pale clouds spread across the page width, in #lava-lamp-mount
 * over the hills and under the scrolling copy: they lift the near-black
 * welcome copy off the saturated lava.
 *
 * - Clouds alone read patchy (dense cores, bare gaps), so an even FOG sits
 *   under them behind the text column only: one soft-edged CSS gradient that
 *   fades in with the rise. The fog does the readability work; the clouds are
 *   the texture.
 * - A BANK of denser, more cloud-shaped puffs hugs the very bottom of the
 *   screen and only comes up late in the scroll — the floor the fainter haze
 *   rises from, so the haze reads as atmosphere rather than a stain mid-page.
 * - Hidden at rest. They RISE with the scroll, on the same 0..1 `rise` the
 *   hills grow by (LavaLampBackground.setRise), from below the viewport to
 *   their resting spots.
 * - They never float above the lava: each cloud's top is clamped under the
 *   hills' skyline at its own x (asked of the lava every frame it redraws, so
 *   a slumping hill pushes its cloud down with it).
 * - Cheap by construction — the first version (live SVG turbulence filters on
 *   full-viewport layers) made the page crawl. Each cloud is a small <canvas>
 *   painted ONCE from radial-gradient puffs; after that only transforms move:
 *   one translate per cloud for rise/clamp, plus an optional compositor-only
 *   CSS drift. No filters, no blend modes.
 *
 * ON for everyone, with the look baked into DEFAULT_SMOKE. The tuning dials
 * are not: the "☁ smoke dials" button only appears in a browser that has
 * opened the page with `?smoke` once (that saves a settings record in
 * localStorage, and the record is the unlock). It is a convenience gate, not
 * a permission — the dials only ever change the look in that one browser.
 * "save look" downloads the JSON to bake into DEFAULT_SMOKE.
 *
 * Owned by LavaLampBackground (same mount, same lifecycle) — not registered
 * separately.
 */

export interface SmokeCfg {
  enabled: boolean;
  seed: number;
  opacity: number; // cloud opacity 0..1
  fog: number;     // even haze behind the text column, 0..1 (0 = clouds only)
  soft: number;    // puff edge softness 0..1 (0 = crisp cartoon outline)
  wisp: number;    // stray small puffs round each cloud's rim, 0..1
  count: number;   // clouds on the page
  size: number;    // base cloud width, % of the page width (floored — see REF_MIN_W)
  headroom: number; // px of bare lava kept between the header and the smoke
  speed: number;   // drift multiplier (0 = still)
  bank: number;        // bottom cloud bank height, % of screen (0 = none)
  bankOpacity: number; // 0..1
  bankSoft: number;    // 0..1 — lower = crisper, more cartoon-cloud
  bankFrom: number;    // rise (0..1) at which the bank starts coming up
  color: string;   // #rrggbb
}

export const DEFAULT_SMOKE: SmokeCfg = {
  enabled: true,
  seed: 4,
  opacity: 0.16,
  fog: 0.18,
  soft: 0.9,
  wisp: 0.5,
  count: 7,
  size: 44,
  headroom: 35,
  speed: 4,
  bank: 40,
  bankOpacity: 0.28,
  bankSoft: 0.33,
  bankFrom: 0,
  color: '#ffffff',
};

/** Screen-px y of the lava's top edge at each given screen-px x. */
export type SkylineFn = (xs: number[]) => number[];

const STORAGE_KEY = 'lavaSmokeCfg';
/** Cloud unit box (shapes are authored in it, then scaled). */
const UNIT_W = 600;
const UNIT_H = 360;
/** The silhouette's top sits about this far down the unit box. */
const SHAPE_TOP = 0.14;
/** Per-cloud canvas pixel budget — soft shapes survive upscaling. */
const MAX_PIXELS = 360_000;
/** Clouds are sized against at least this page width: on a narrow screen they
 *  keep their desktop bulk (and overlap more) instead of shrinking into dots. */
const REF_MIN_W = 1280;

type NumKey = 'bank' | 'bankOpacity' | 'bankSoft' | 'bankFrom' | 'headroom' | 'fog' | 'opacity' | 'soft' | 'wisp' | 'count' | 'size' | 'speed';
const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'fog', label: 'fog behind text (even)', min: 0, max: 1, step: 0.01 },
  { key: 'opacity', label: 'cloud opacity', min: 0, max: 1, step: 0.01 },
  { key: 'soft', label: 'softness (0 = crisp outline)', min: 0, max: 1, step: 0.01 },
  { key: 'wisp', label: 'wisp (stray puffs)', min: 0, max: 1, step: 0.01 },
  { key: 'count', label: 'clouds', min: 1, max: 16, step: 1 },
  { key: 'size', label: 'cloud size', min: 15, max: 110, step: 1 },
  { key: 'headroom', label: 'clear band under header', min: 0, max: 300, step: 5 },
  { key: 'speed', label: 'drift (0 = still)', min: 0, max: 4, step: 0.1 },
  { key: 'bank', label: 'bottom bank height % (0 = off)', min: 0, max: 40, step: 1 },
  { key: 'bankOpacity', label: 'bank opacity', min: 0, max: 1, step: 0.01 },
  { key: 'bankSoft', label: 'bank softness (0 = crisp)', min: 0, max: 1, step: 0.01 },
  { key: 'bankFrom', label: 'bank appears after (scroll 0–1)', min: 0, max: 0.95, step: 0.05 },
];

function rngFrom(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadCfg(): SmokeCfg {
  const cfg: SmokeCfg = { ...DEFAULT_SMOKE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cfg;
    const saved = JSON.parse(raw) as Partial<Record<keyof SmokeCfg, unknown>>;
    if (typeof saved.enabled === 'boolean') cfg.enabled = saved.enabled;
    if (typeof saved.seed === 'number' && Number.isFinite(saved.seed)) cfg.seed = saved.seed;
    for (const s of SLIDERS) {
      const v = saved[s.key];
      if (typeof v === 'number' && Number.isFinite(v)) cfg[s.key] = Math.max(s.min, Math.min(s.max, v));
    }
    if (typeof saved.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color)) cfg.color = saved.color;
  } catch { /* private window / blocked storage / junk — defaults */ }
  return cfg;
}

interface Puff { x: number; y: number; r: number; a: number }

/** One cumulus silhouette in the unit box: a flat-ish base, puffs tallest
 *  mid-cloud, plus `wisp` stray puffs round the rim. */
function cloudPuffs(rng: () => number, wisp: number): Puff[] {
  const x0 = 130;
  const x1 = 470;
  const baseY = 270;
  const puffs: Puff[] = [];
  for (let i = 0; i < 7; i++) puffs.push({ x: x0 + ((x1 - x0) * i) / 6, y: baseY - 36, r: 36, a: 1 });
  const n = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const bell = Math.sin(Math.PI * (0.12 + 0.76 * t));
    const r = 32 + 56 * bell * (0.75 + rng() * 0.5);
    puffs.push({
      x: x0 + 30 + (x1 - x0 - 60) * t + (rng() - 0.5) * 26,
      y: baseY - 40 - r * (0.4 + rng() * 0.3),
      r,
      a: 1,
    });
  }
  const strays = Math.round(wisp * 26);
  for (let i = 0; i < strays; i++) {
    const ang = rng() * Math.PI * 2;
    const d = 0.85 + rng() * 0.35;
    puffs.push({
      x: 300 + Math.cos(ang) * 205 * d,
      y: 205 + Math.sin(ang) * 95 * d,
      r: 12 + rng() * 30,
      a: 0.35 + rng() * 0.4,
    });
  }
  return puffs;
}

function drawPuff(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, soft: number, rgb: string): void {
  const outer = r * (1 + 0.55 * soft);
  if (soft < 0.02) {
    ctx.fillStyle = `rgba(${rgb},${a})`;
  } else {
    const g = ctx.createRadialGradient(x, y, r * (1 - soft), x, y, outer);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, Math.PI * 2);
  ctx.fill();
}

interface Cloud {
  el: HTMLDivElement;
  cx: number;     // centre x, screen px
  w: number;
  h: number;
  target: number; // resting top (screen px) once fully risen
  lastY: number;
}

export class LavaSmoke {
  private cfg: SmokeCfg;
  private mount: HTMLElement;
  private skyline: SkylineFn;
  private root: HTMLDivElement | null = null;
  private clouds: Cloud[] = [];
  private cloudLayer: HTMLDivElement | null = null;
  private fogEl: HTMLDivElement | null = null;
  private lastFog = -1;
  private bankEl: HTMLCanvasElement | null = null;
  private lastBank = -1;
  private dialsBtn: HTMLButtonElement | null = null;
  private openDials: () => void;
  private rise = 0;
  private ceiling: number | null = null; // header's bottom edge, screen px
  private raf = 0;
  private onWinResize = () => this.buildSoon();
  private reducedMotion: boolean;

  constructor(mount: HTMLElement, skyline: SkylineFn, openDials: () => void) {
    this.mount = mount;
    this.openDials = openDials;
    this.skyline = skyline;
    this.cfg = loadCfg();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onWinResize);
    this.root?.remove();
    this.root = null;
    this.cloudLayer = null;
    this.fogEl = null;
    this.lastFog = -1;
    this.bankEl = null;
    this.lastBank = -1;
    this.dialsBtn?.remove();
    this.dialsBtn = null;
    this.clouds = [];
  }

  /** The `?smoke` URL door: layer on, and the dials button unlocked for this
   *  browser from now on (save() writes the record hasDials() looks for). */
  enable(): void {
    this.cfg.enabled = true;
    this.save();
    this.build();
  }

  /** Has this browser ever tuned the smoke? Only then does it get the button. */
  private hasDials(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) !== null; } catch { return false; }
  }

  /** 0..1 — the same scroll-driven rise the hills grow by. */
  setRise(f: number): void {
    this.rise = f;
    this.follow();
  }

  /** The header's bottom edge (screen px; null = none). The smoke keeps
   *  `headroom` px below it, so a band of full-colour lava survives above
   *  the text. */
  setCeiling(linePx: number | null): void {
    if (linePx === this.ceiling) return;
    this.ceiling = linePx;
    this.follow();
  }

  private save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cfg)); } catch { /* best effort */ }
  }

  private buildSoon(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.build());
  }

  private build(): void {
    this.destroy();
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw === 0 || vh === 0) return;
    const root = document.createElement('div');
    root.className = 'lava-smoke';
    root.setAttribute('aria-hidden', 'true');
    // even haze behind the text column: soft on every edge, so it never reads
    // as a box. Runs off the bottom of the screen on purpose (no lower edge).
    const copy = document.querySelector('#app-container.lava-lamp-background .welcome-copy')?.getBoundingClientRect();
    if (copy && copy.width > 0 && cfg.fog > 0) {
      const reach = Math.min(160, vw * 0.12);
      const left = Math.max(0, copy.left - reach);
      const right = Math.min(vw, copy.right + reach);
      const fog = document.createElement('div');
      fog.className = 'lava-smoke-fog';
      fog.style.left = `${left.toFixed(0)}px`;
      fog.style.width = `${(right - left).toFixed(0)}px`;
      fog.style.background =
        `radial-gradient(ellipse 50% 50% at 50% 50%, ${cfg.color} 0, ${cfg.color} 84%, transparent 100%)`;
      root.appendChild(fog);
      this.fogEl = fog;
    }
    const cloudLayer = document.createElement('div');
    cloudLayer.className = 'lava-smoke-clouds';
    cloudLayer.style.opacity = String(cfg.opacity);
    root.appendChild(cloudLayer);
    this.cloudLayer = cloudLayer;
    const speed = cfg.speed * (this.reducedMotion ? 0.5 : 1);
    const rgb = [1, 3, 5].map(i => parseInt(cfg.color.slice(i, i + 2), 16)).join(',');
    const rng = rngFrom(cfg.seed * 6151 + 11);
    // a jittered grid across the WHOLE page width: loosely random, but a
    // handful still covers the copy instead of clumping in one corner
    const cols = Math.max(1, Math.ceil(Math.sqrt(cfg.count * (vw / vh) * 0.9)));
    const rows = Math.ceil(cfg.count / cols);
    for (let i = 0; i < cfg.count; i++) {
      const w = (Math.max(vw, REF_MIN_W) * cfg.size) / 100 * (0.7 + rng() * 0.7);
      const h = (w * UNIT_H) / UNIT_W;
      const cx = (((i % cols) + 0.5 + (rng() - 0.5) * 0.9) / cols) * vw;
      // resting spots sit in the lower two-thirds: the top third is the
      // header + the clear band (follow() enforces it; this just avoids every
      // cloud queueing up against that line)
      const cy = vh * (0.5 + 0.6 * ((Math.floor(i / cols) + 0.5 + (rng() - 0.5) * 0.9) / rows));

      const el = document.createElement('div');
      el.className = 'lava-smoke-cloud';
      el.style.width = `${w.toFixed(0)}px`;
      const canvas = document.createElement('canvas');
      if (speed > 0) {
        const dur = (50 + rng() * 50) / speed;
        canvas.className = 'lava-smoke-drift';
        canvas.style.animationDuration = `${dur.toFixed(1)}s`;
        canvas.style.animationDelay = `-${(rng() * dur).toFixed(1)}s`;
        canvas.style.setProperty('--dx', `${((rng() < 0.5 ? -1 : 1) * (3 + rng() * 6)).toFixed(1)}vw`);
        canvas.style.setProperty('--dy', `${((rng() - 0.5) * 3).toFixed(1)}vh`);
      }
      this.paintCloud(canvas, w, h, rng, rgb);
      el.appendChild(canvas);
      cloudLayer.appendChild(el);
      this.clouds.push({ el, cx, w, h, target: cy - h / 2, lastY: NaN });
    }
    this.buildBank(root, vw, vh, rgb);
    // a visible way into the dials — only for a browser that has unlocked
    // them (see hasDials). On <body>: the mount is pointer-events:none.
    if (this.hasDials()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lava-smoke-dials-btn';
      btn.textContent = '☁ smoke dials';
      btn.addEventListener('click', () => this.openDials());
      document.body.appendChild(btn);
      this.dialsBtn = btn;
    }
    this.mount.appendChild(root); // after .lava-lamp-bg → painted over the hills
    this.root = root;
    window.addEventListener('resize', this.onWinResize);
    this.follow();
  }

  private paintCloud(canvas: HTMLCanvasElement, w: number, h: number, rng: () => number, rgb: string): void {
    const cfg = this.cfg;
    const puffs = cloudPuffs(rng, cfg.wisp); // drawn or not, the rng advances the same
    const flip = rng() < 0.5 ? -1 : 1;
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const k = (w / UNIT_W) * scale;
    for (const p of puffs) {
      drawPuff(ctx, (flip < 0 ? UNIT_W - p.x : p.x) * k, p.y * k, p.r * k, p.a, cfg.soft, rgb);
    }
  }

  /** The bottom bank: one full-width strip of overlapping cumulus bumps on a
   *  solid floor. `u` = how far its tallest bumps stand above the screen's
   *  bottom edge. Slides up from below in follow(). */
  private buildBank(root: HTMLElement, vw: number, vh: number, rgb: string): void {
    const cfg = this.cfg;
    const u = (vh * cfg.bank) / 100;
    if (u < 4 || cfg.bankOpacity <= 0) return;
    const pad = u * 0.6 * cfg.bankSoft + 2; // room for the soft edge above the tallest bump
    const H = u + pad;
    const canvas = document.createElement('canvas');
    canvas.className = 'lava-smoke-bank';
    canvas.style.height = `${H.toFixed(0)}px`;
    canvas.style.opacity = String(cfg.bankOpacity);
    canvas.width = Math.max(1, Math.round(vw));
    canvas.height = Math.max(1, Math.round(H));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const rng = rngFrom(cfg.seed * 3571 + 5);
      // solid floor, so gaps between bumps never show lava at the very edge
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fillRect(0, H - u * 0.28, vw, u * 0.28);
      // bumps in clumps: a big one flanked by smaller ones reads as cumulus,
      // an even row of equal circles reads as a scalloped border
      let x = -u * 0.5;
      while (x < vw + u * 0.5) {
        // sized so the tallest bump (centre lift + radius + soft edge) tops out
        // at ~u — inside the canvas, never sliced by its top edge
        const big = u * (0.3 + rng() * 0.14);
        drawPuff(ctx, x, H - big * (0.3 + rng() * 0.45), big, 1, cfg.bankSoft, rgb);
        const sides = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < sides; i++) {
          const r = big * (0.45 + rng() * 0.35);
          drawPuff(ctx, x + (rng() - 0.5) * big * 2.4, H - r * (0.3 + rng() * 0.5), r, 1, cfg.bankSoft, rgb);
        }
        x += big * (1.1 + rng() * 1.3);
      }
    }
    root.appendChild(canvas);
    this.bankEl = canvas;
  }

  /** Place every cloud for the current rise, clamped under the lava skyline.
   *  Called on rise changes and after each lava redraw. Transform-only. */
  follow(): void {
    if (!this.root) return;
    const vh = window.innerHeight;
    const floorY = (this.ceiling ?? 0) + this.cfg.headroom; // nothing above this
    if (this.fogEl) {
      // the gradient's own soft top edge starts here (transform, not `top`:
      // no layout on scroll)
      this.fogEl.style.transform = `translate3d(0,${floorY.toFixed(0)}px,0)`;
      // eased in over the first part of the rise, so it is there by the time
      // the copy has properly arrived over the lava
      const t = Math.min(1, this.rise / 0.6);
      const op = this.cfg.fog * t * t * (3 - 2 * t);
      if (Math.abs(op - this.lastFog) > 0.004) {
        this.lastFog = op;
        this.fogEl.style.opacity = op.toFixed(3);
      }
    }
    if (this.bankEl) {
      // comes up only late in the scroll: 0 below `bankFrom`, fully up at 1
      const from = Math.min(0.95, this.cfg.bankFrom);
      const t = Math.max(0, Math.min(1, (this.rise - from) / (1 - from)));
      const up = t * t * (3 - 2 * t);
      if (Math.abs(up - this.lastBank) > 0.002) {
        this.lastBank = up;
        this.bankEl.style.transform = `translate3d(0,${((1 - up) * 105).toFixed(1)}%,0)`;
      }
    }
    if (this.rise <= 0) {
      // at rest: parked below the fold, no skyline maths needed
      for (const c of this.clouds) this.place(c, vh + 20);
      return;
    }
    // three samples per cloud (centre and both shoulders): the LOWEST lava top
    // under the cloud's body is the one it must stay beneath
    const xs: number[] = [];
    for (const c of this.clouds) xs.push(c.cx - c.w * 0.22, c.cx, c.cx + c.w * 0.22);
    const sky = this.skyline(xs);
    this.clouds.forEach((c, i) => {
      const rest = vh + 20;
      const want = rest + (c.target - rest) * this.rise;
      const lavaTop = Math.max(sky[i * 3] ?? vh, sky[i * 3 + 1] ?? vh, sky[i * 3 + 2] ?? vh);
      this.place(c, Math.max(want, lavaTop + 14 - c.h * SHAPE_TOP, floorY - c.h * SHAPE_TOP));
    });
  }

  private place(c: Cloud, y: number): void {
    if (Math.abs(y - c.lastY) < 0.5) return;
    c.lastY = y;
    c.el.style.transform = `translate3d(${(c.cx - c.w / 2).toFixed(1)}px,${y.toFixed(1)}px,0)`;
  }

  /** Adds the smoke section to the lava adjuster panel (Shift+L). */
  appendControls(panel: HTMLElement): void {
    const c = this.cfg;
    const box = document.createElement('div');
    box.className = 'lava-adjuster-smoke';
    box.innerHTML =
      `<strong>smoke (rises as you scroll)</strong>`
      + `<label class="lava-adjuster-check"><input type="checkbox" data-smoke="enabled"${c.enabled ? ' checked' : ''}> show smoke layer</label>`
      + SLIDERS.map(s =>
        `<label>${s.label} <output>${c[s.key]}</output>`
        + `<input type="range" data-smoke="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${c[s.key]}"></label>`).join('')
      + `<label class="lava-adjuster-inline">colour <input type="color" data-smoke="color" value="${c.color}"></label>`
      + `<div><button type="button" data-smoke-act="reroll">🎲 re-roll</button>`
      + `<button type="button" data-smoke-act="save">💾 save look</button>`
      + `<button type="button" data-smoke-act="reset">reset</button>`
      + `<button type="button" data-smoke-act="close">✕ close</button></div>`;
    panel.appendChild(box);

    box.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      const key = el.dataset.smoke;
      if (key === 'enabled') {
        c.enabled = el.checked;
      } else if (key === 'color') {
        c.color = el.value;
      } else {
        const spec = SLIDERS.find(s => s.key === key);
        if (!spec) return;
        c[spec.key] = parseFloat(el.value);
        const out = el.parentElement?.querySelector('output');
        if (out) out.textContent = el.value;
        if (spec.key === 'opacity' && this.cloudLayer) {
          this.cloudLayer.style.opacity = el.value; // no repaint needed
          this.save();
          return;
        }
      }
      this.buildSoon(); // a handful of small canvases — cheap enough to redo
      this.save();
    });

    box.addEventListener('click', (e) => {
      const act = e.target instanceof HTMLElement ? e.target.dataset.smokeAct : undefined;
      if (act === 'close') {
        this.openDials(); // toggles the adjuster shut
      } else if (act === 'reroll') {
        c.seed = Math.floor(Math.random() * 100000);
        this.build();
        this.save();
      } else if (act === 'save') {
        // hands the look over: a JSON file in Downloads (+ the clipboard)
        const json = JSON.stringify(this.cfg, null, 2);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        a.download = 'hyperlit-smoke-settings.json';
        a.click();
        URL.revokeObjectURL(a.href);
        void navigator.clipboard?.writeText(json).catch(() => { /* file is the real handover */ });
        if (e.target instanceof HTMLElement) e.target.textContent = '✓ saved to Downloads';
      } else if (act === 'reset') {
        // keep it showing — reset is "back to the default LOOK", not "off"
        this.cfg = { ...DEFAULT_SMOKE, enabled: c.enabled };
        this.build();
        this.save();
        box.remove();
        this.appendControls(panel);
      }
    });
  }
}
