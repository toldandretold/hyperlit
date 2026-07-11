// The animated "reaping" strip under the harvest stage chain: the combine
// drives left→right across a field of standing wheat, mowing it down as it
// advances (the wheat to its right recedes, leaving stubble behind). Purely
// decorative — driven by the same telemetry that drives the stage chain.
//
// The field markup is created ONCE (persistent DOM) so CSS transitions can
// tween the combine + wheat between poll updates; renderHarvestViz only
// updates positions via positionHarvestField().
import { combineIcon } from './combineIcon';

// One wheat stalk, tiled horizontally as the standing-crop texture. Gold on
// the dark overlay. encodeURIComponent at use-time keeps the data URI safe.
const WHEAT_STALK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 40"><g stroke="#c9a227" stroke-width="1.4" fill="none" stroke-linecap="round"><path d="M11 40 V15"/><path d="M11 16 L5 12 M11 14 L17 10 M11 12 L5 8 M11 10 L17 6 M11 8 L6 4 M11 7 L16 3 M11 6 L9 1 M11 6 L13 1"/></g></svg>`;

/** CSS for the field — injected once into the overlay's <style> block. */
export const HARVEST_FIELD_CSS = `
  .harvest-field { position: relative; height: 66px; margin-top: 22px; overflow: hidden; border-radius: 6px;
    background: linear-gradient(#242424, #1e1e1e); }
  /* Cut stubble across the whole ground — always visible under the crop. */
  .harvest-stubble { position: absolute; left: 0; right: 0; bottom: 0; height: 9px;
    background: repeating-linear-gradient(90deg, transparent 0 5px, rgba(201,162,39,0.45) 5px 6px); }
  /* Standing crop occupies from the combine (left%) to the right edge. */
  .harvest-standing { position: absolute; top: 8px; bottom: 7px; right: 0;
    background-image: url("data:image/svg+xml,${encodeURIComponent(WHEAT_STALK)}");
    background-repeat: repeat-x; background-position: left bottom; background-size: 15px 36px;
    transition: left 1.1s ease; transform-origin: bottom center; }
  .harvest-standing.harvest-sway { animation: harvestSway 2.4s ease-in-out infinite; }
  .harvest-combine { position: absolute; bottom: 4px; transform: translateX(-46%);
    transition: left 1.1s ease; color: #eaeaea; }
  .harvest-combine-bob { display: inline-block; }
  .harvest-combine.harvest-working .harvest-combine-bob { animation: harvestBob 0.45s ease-in-out infinite; }
  /* The source icon already faces right — header leads the rightward drive into the crop. */
  .harvest-combine-flip { display: inline-block; }
  @keyframes harvestBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
  @keyframes harvestSway { 0%,100% { transform: skewX(-2.5deg); } 50% { transform: skewX(2.5deg); } }
`;

/** The persistent field structure. Positions are set later by positionHarvestField. */
export function harvestFieldHtml(): string {
  return `
    <div class="harvest-field" aria-hidden="true">
      <div class="harvest-standing" style="left: 0;"></div>
      <div class="harvest-stubble"></div>
      <div class="harvest-combine" style="left: 0;"><span class="harvest-combine-bob"><span class="harvest-combine-flip">${combineIcon(34)}</span></span></div>
    </div>`;
}

/**
 * Progress 0..1 for the drive. Each stage is an equal slice; the running
 * stage adds a partial (the harvest stage uses attempted/eligible for a
 * finer creep, others a half-slice). Completed = full field mown.
 */
export function computeHarvestProgress(
  stageIds: string[],
  statusOf: (id: string) => string,
  harvest: any,
): number {
  if (harvest.status === 'completed') return 1;
  const total = stageIds.length || 1;
  let done = 0;
  let partial = 0;
  for (const id of stageIds) {
    const st = statusOf(id);
    if (st === 'done' || st === 'skipped') {
      done += 1;
    } else if (st === 'running') {
      if (id === 'harvest') {
        const c = harvest.counts || {};
        partial = Math.min(1, (c.attempted || 0) / Math.max(1, c.eligible || 0));
      } else {
        partial = 0.5;
      }
    }
  }
  return Math.max(0, Math.min(1, (done + partial) / total));
}

/** Slide the combine + crop edge to the current progress. */
export function positionHarvestField(wrap: HTMLElement, progress: number, running: boolean): void {
  const pct = Math.max(0, Math.min(100, progress * 100));
  const standing = wrap.querySelector('.harvest-standing') as HTMLElement | null;
  const combine = wrap.querySelector('.harvest-combine') as HTMLElement | null;
  if (standing) {
    standing.style.left = pct + '%';
    standing.classList.toggle('harvest-sway', running);
  }
  if (combine) {
    combine.style.left = pct + '%';
    combine.classList.toggle('harvest-working', running);
  }
}
