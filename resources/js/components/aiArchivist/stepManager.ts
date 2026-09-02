/**
 * The AI Archivist's step-checklist UI, shared by the in-reader brain panel
 * (hyperlitContainer/brainQuery.ts) and the hero-page archivist panel
 * (components/aiArchivist/archivistPanel.ts). Extracted verbatim from
 * brainQuery.ts — styling lives in resources/css/components/brainMode.css.
 */

/**
 * The "goo" loader SVG: three brand-colour discs at one centre, fused by an inline
 * goo filter into a single mutating blob with colour plumes (styled in brainMode.css).
 * @param hidden start hidden (main form, until the request actually fires)
 */
export const brainLoaderSvg = (hidden: boolean): string =>
  `<svg class="brain-blobs"${hidden ? ' style="display:none;"' : ''} viewBox="0 0 100 100" aria-hidden="true">`
  + `<defs><filter id="brainGoo"><feGaussianBlur in="SourceGraphic" stdDeviation="8" result="b"/>`
  + `<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/></filter></defs>`
  + `<g filter="url(#brainGoo)" class="brain-goo-g">`
  + `<circle class="bg-pink" cx="50" cy="44" r="19"/>`
  + `<circle class="bg-orange" cx="56" cy="53" r="19"/>`
  + `<circle class="bg-aqua" cx="44" cy="53" r="19"/></g></svg>`;

export interface StepManager {
  /** Queue a step; consecutive duplicates are ignored. */
  enqueueStep(msg: string): void;
  /** Reveal any queued steps immediately (call before rendering a result). */
  flushStepsNow(): void;
  /** Update the current row's text in place (used by the polling view — no stacking). */
  updateCurrent(msg: string): void;
  /** Finalize the checklist and append a red error row (returns it, for extra UI). */
  setError(msg: string): HTMLElement;
  /** Reset to empty (queue + rendered rows). */
  clear(): void;
}

/**
 * Manages the status CHECKLIST: status messages stack as `.brain-step` rows, the
 * previous one ticking off (done) as the next appears, with the goo blob riding the
 * current row. Incoming steps are revealed at a gentle minimum cadence so they read
 * as a checklist filling up rather than all flashing at once (the underlying work
 * still runs full speed — only the reveal is paced).
 */
export function createStepManager(
  statusEl: HTMLElement,
  stepsEl: HTMLElement,
  opts: { blob?: boolean } = {},
): StepManager {
  const MIN_STEP_MS = 400;
  let blobEl: SVGElement | null = null; // moved onto the current row
  // blob: false — the hero-page panel suppresses the row blob because the goo
  // already spins in the Ask button; two wheels at once reads as noise. The
  // in-reader flow keeps it (no Ask button there).
  if (opts.blob !== false) {
    const host = document.createElement('template');
    host.innerHTML = brainLoaderSvg(false).trim();
    blobEl = host.content.firstElementChild as SVGElement | null;
  }

  const queue: string[] = [];
  let draining = false;
  let lastMsg = '';

  const clean = (m: string): string => String(m).replace(/[.…]+\s*$/, '').trim();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // The checklist grows while the request is in flight and the panel is height-capped,
  // so without this the live row — the one carrying the goo blob — stacks below the fold
  // and the user watches a frozen list instead of the progress animation. Follow the
  // bottom on every append; rAF so the new row is laid out before we measure.
  const scrollerEl = statusEl.closest('.scroller') as HTMLElement | null;
  const keepStepVisible = (): void => {
    if (!scrollerEl) return;
    requestAnimationFrame(() => {
      scrollerEl.scrollTo({ top: scrollerEl.scrollHeight, behavior: 'smooth' });
    });
  };

  const finalizeCurrent = (): void => {
    const cur = stepsEl.querySelector('.brain-step.current');
    if (cur) { cur.classList.remove('current'); cur.classList.add('done'); }
  };

  const renderStep = (msg: string): void => {
    finalizeCurrent();
    const step = document.createElement('div');
    step.className = 'brain-step current';
    const mark = document.createElement('span'); mark.className = 'brain-step-mark';
    const text = document.createElement('span'); text.className = 'brain-step-text'; text.textContent = clean(msg);
    step.append(mark, text);
    if (blobEl) step.appendChild(blobEl);
    stepsEl.appendChild(step);
    statusEl.style.display = 'flex';
    keepStepVisible();
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      renderStep(queue.shift() as string);
      if (queue.length) await sleep(MIN_STEP_MS);
    }
    draining = false;
  };

  const flushNow = (): void => { while (queue.length) renderStep(queue.shift() as string); };

  return {
    enqueueStep(msg: string): void {
      const c = clean(msg);
      if (!c || c === lastMsg) return;
      lastMsg = c;
      queue.push(msg);
      void drain();
    },
    flushStepsNow(): void { flushNow(); },
    updateCurrent(msg: string): void {
      const cur = stepsEl.querySelector('.brain-step.current');
      if (!cur) { renderStep(msg); return; }
      const t = cur.querySelector('.brain-step-text');
      if (t) t.textContent = clean(msg);
      statusEl.style.display = 'flex';
      keepStepVisible();
    },
    setError(msg: string): HTMLElement {
      flushNow();
      finalizeCurrent();
      if (blobEl && blobEl.parentNode) blobEl.parentNode.removeChild(blobEl);
      const step = document.createElement('div');
      step.className = 'brain-step error';
      const mark = document.createElement('span'); mark.className = 'brain-step-mark';
      const text = document.createElement('span'); text.className = 'brain-step-text'; text.textContent = msg;
      step.append(mark, text);
      stepsEl.appendChild(step);
      statusEl.style.display = 'flex';
      keepStepVisible();
      return step;
    },
    clear(): void { queue.length = 0; lastMsg = ''; stepsEl.innerHTML = ''; },
  };
}
