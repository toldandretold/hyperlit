/**
 * Canvas animation orchestrator — dispatches to engine modules by mode.
 * Lazy-loaded via dynamic import() from vibeCSS — zero cost for non-canvas vibes.
 */
import feedback from './canvasEngines/feedback';
import fire from './canvasEngines/fire';
import water from './canvasEngines/water';
import wind from './canvasEngines/wind';
import electricity from './canvasEngines/electricity';

const engines: any = { feedback, fire, water, wind, electricity };

let canvas: any = null;
let ctx: any = null;
let rafId: any = null;
let resizeHandler: any = null;
let activeEngine: any = null;
let activeParams: any = null;
let frameCount = 0;

/**
 * Start (or restart) the canvas with the given mode's engine.
 * @param params — parsed from --vibe-canvas-* keys (without prefix)
 */
export function startVibeCanvas(params: any) {
  stopVibeCanvas();

  const mode = (params.mode && engines[params.mode]) ? params.mode : 'feedback';
  activeEngine = engines[mode];
  activeParams = params;
  frameCount = 0;

  canvas = document.createElement('canvas');
  canvas.id = 'vibe-canvas';
  document.body.prepend(canvas);

  sizeCanvases();
  ctx = canvas.getContext('2d');
  activeEngine.init(params, canvas.width, canvas.height);

  resizeHandler = () => {
    sizeCanvases();
    activeEngine.cleanup();
    activeEngine.init(activeParams, canvas.width, canvas.height);
  };
  window.addEventListener('resize', resizeHandler);

  rafId = requestAnimationFrame(tick);
}

/**
 * Stop the canvas and clean up.
 */
export function stopVibeCanvas() {
  if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
  if (activeEngine) { activeEngine.cleanup(); activeEngine = null; }
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  canvas = null;
  ctx = null;
  activeParams = null;
}

function sizeCanvases() {
  if (!canvas) return;
  canvas.width = Math.round(window.innerWidth / 2);
  canvas.height = Math.round(window.innerHeight / 2);
}

function tick() {
  if (!ctx || !canvas || !activeEngine) return;
  frameCount++;
  activeEngine.tick(ctx, canvas.width, canvas.height, frameCount);
  rafId = requestAnimationFrame(tick);
}
