/**
 * minimap — the Sublime-style preview popup for the custom scrollbar.
 *
 * A single fixed <canvas> that fades in beside the track while the user hovers
 * or scrubs. It draws SHAPE APPROXIMATIONS of the book from the precomputed
 * MinimapNode render list (virtualMap.ts) — headings as bars (with real mini
 * text for h1-h3, which is what makes the map navigable), paragraphs as line
 * strokes, figures/tables as boxes, hyperlight/hypercite ticks in right-hand
 * gutters — never by cloning or rendering actual content DOM.
 *
 * Draw-on-demand per paint call, no whole-book offscreen cache: a book-length
 * strip would blow past canvas dimension limits (~32k px) and complicate
 * invalidation, while walking the ~100-400 nodes inside the visible span is
 * well under a millisecond.
 */

import { indexAtVirtual, type VirtualMap, type MinimapNode } from './virtualMap';

export interface MinimapAnchor {
  /** Track geometry in viewport px — the popup clamps itself to this extent. */
  barTop: number;
  barHeight: number;
  thumbTop: number;
  thumbHeight: number;
}

export interface MinimapHooks {
  /** Click inside the preview → jump to the clicked virtual position. */
  onJump(v: number): void;
  /** Pointer entered/left the preview canvas (keeps the popup alive on hover). */
  onHoverChange(hovering: boolean): void;
}

export interface MinimapController {
  show(): void;
  hide(): void;
  /** vCenter: preview span center (glides smoothly); vBandTop: landing band's
   *  top edge (snapped to the landing node by the caller). */
  paint(
    map: VirtualMap,
    vCenter: number,
    vBandTop: number,
    viewportVirtual: number,
    anchor: MinimapAnchor,
  ): void;
  /** Is this node part of the preview surface? (outside-press dismissal check) */
  contains(target: Node): boolean;
  destroy(): void;
}

const CSS_WIDTH = 110;
/**
 * The lens shows this many viewports (screens) of content at most. This is the
 * single knob that trades off the "your screen" band size against scrub speed:
 * the band is ALWAYS a valid true proportion of the lens — band ≈ cssH /
 * SPAN_VIEWPORTS — so at 12 it's ~1/12 of the canvas (clearly visible) and a
 * normal drag advances < one lens per frame (no "hopping over regions"). It is
 * NOT floored/faked: a shorter book simply shows the whole book (span clamps to
 * totalHeight) with a correspondingly larger, still-valid band.
 *
 * Bigger value → smaller band, faster scrub, more chapters visible; smaller
 * value → bigger band, but a long book's content flies past on a fast drag.
 */
const SPAN_VIEWPORTS = 12;
/**
 * The band claims a full screen of the lens: node heights are MEASURED real
 * pixels (measure.ts), so what the band covers is what lands on screen. It is a
 * true proportion (viewportVirtual / span) — never floored — so it stays honest.
 */
const BAND_FRACTION = 1.0;
/** Floor for the shrink-to-content canvas height (a tiny book still needs a
 *  legible strip; the bar itself hides entirely when content can't scroll). */
const MIN_CANVAS = 60;
const PAD_X = 7;
const GUTTER_LIGHT = 6; // px from right edge — hyperlight ticks
const GUTTER_CITE = 13; // second gutter — hypercite ticks
const HEADING_THICKNESS = [0, 4, 3, 2, 2, 2, 2];

interface ThemeColors {
  text: string;
  background: string;
  accent: string;
  cite: string;
}

function sampleTheme(): ThemeColors {
  const cs = getComputedStyle(document.body);
  return {
    text: cs.getPropertyValue('--color-text').trim() || '#ffffff',
    background: cs.getPropertyValue('--color-background').trim() || '#221F20',
    accent: cs.getPropertyValue('--hyperlit-pink').trim() || '#EE4A95',
    cite: cs.getPropertyValue('--hyperlit-aqua').trim() || '#4EACAE',
  };
}

export function createMinimap(hooks: MinimapHooks): MinimapController {
  const canvas = document.createElement('canvas');
  canvas.className = 'minimap-preview';
  document.body.appendChild(canvas);

  let visible = false;
  /** Geometry of the last paint — maps a canvas click back to a virtual position. */
  let lastLayout: { spanTop: number; span: number; cssH: number } | null = null;

  canvas.addEventListener('click', (e: MouseEvent) => {
    if (!visible || !lastLayout || lastLayout.cssH <= 0) return;
    const y = e.clientY - canvas.getBoundingClientRect().top;
    hooks.onJump(lastLayout.spanTop + (y / lastLayout.cssH) * lastLayout.span);
  });
  canvas.addEventListener('pointerenter', () => hooks.onHoverChange(true));
  canvas.addEventListener('pointerleave', () => hooks.onHoverChange(false));
  let theme: ThemeColors = {
    text: '#ffffff',
    background: '#221F20',
    accent: '#EE4A95',
    cite: '#4EACAE',
  };

  function show(): void {
    if (visible) return;
    visible = true;
    theme = sampleTheme(); // re-sampled per fade-in → free theme-switch support
    canvas.classList.add('visible');
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    canvas.classList.remove('visible');
  }

  function drawNode(
    ctx: CanvasRenderingContext2D,
    mini: MinimapNode,
    y: number,
    h: number,
    w: number,
    labels: Array<{ text: string; y: number }>,
  ): void {
    const left = PAD_X;
    const right = w - GUTTER_CITE - 3;
    const width = right - left;

    switch (mini.kind) {
      case 'heading': {
        const level = mini.level ?? 3;
        const thickness = HEADING_THICKNESS[level] ?? 2;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = theme.text;
        if (mini.headingText) {
          // Text is drawn in a second pass ON TOP of the shape lines — at
          // book-fraction zoom a node row is ~2-3px, and inline drawing let the
          // following nodes' lines strike through the label.
          labels.push({ text: mini.headingText, y: y + h / 2 });
        } else {
          ctx.fillRect(left, y + h / 2 - thickness / 2, width * 0.8, thickness);
        }
        break;
      }
      case 'figure': {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 1;
        ctx.strokeRect(left, y + 1, width, Math.max(4, h - 2));
        ctx.beginPath();
        ctx.moveTo(left, y + 1);
        ctx.lineTo(left + width, y + Math.max(4, h - 2) + 1);
        ctx.stroke();
        break;
      }
      case 'table': {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 1;
        const boxH = Math.max(4, h - 2);
        ctx.strokeRect(left, y + 1, width, boxH);
        ctx.beginPath();
        ctx.moveTo(left, y + 1 + boxH / 2);
        ctx.lineTo(left + width, y + 1 + boxH / 2);
        ctx.stroke();
        break;
      }
      case 'rule': {
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = theme.text;
        ctx.fillRect(left + width * 0.25, y + h / 2, width * 0.5, 1);
        break;
      }
      default: {
        // para / quote / list / code — rows of thin lines, collapsing to a
        // translucent block when the rows would be denser than 2px.
        const indent = mini.kind === 'quote' || mini.kind === 'list' ? width * 0.08 : 0;
        const lines = mini.lineCount;
        const spacing = h / lines;
        ctx.fillStyle = theme.text;
        if (spacing < 2) {
          ctx.globalAlpha = 0.15;
          ctx.fillRect(left + indent, y, width - indent, h);
        } else {
          ctx.globalAlpha = 0.35;
          for (let i = 0; i < lines; i++) {
            const lw = i === lines - 1 ? (width - indent) * 0.55 : width - indent;
            ctx.fillRect(left + indent, y + i * spacing, lw, 1);
          }
        }
      }
    }

    // Mark gutters: one tick per node that carries marks (counts precomputed).
    if (mini.lightCount > 0) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(w - GUTTER_LIGHT, y, 3, Math.max(2, Math.min(h, 6)));
    }
    if (mini.citeCount > 0) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = theme.cite;
      ctx.fillRect(w - GUTTER_CITE, y, 3, Math.max(2, Math.min(h, 6)));
    }
  }

  function paint(
    map: VirtualMap,
    vCenter: number,
    vBandTop: number,
    viewportVirtual: number,
    anchor: MinimapAnchor,
  ): void {
    if (!visible || map.totalHeight <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Cap the lens at SPAN_VIEWPORTS screens (never more than the whole book) so
    // the "your screen" band is a valid, visible fraction — NOT the unbounded
    // totalHeight/N that made one screen a sliver on a long book.
    const span = Math.min(map.totalHeight, Math.max(1, viewportVirtual * SPAN_VIEWPORTS));

    // Shrink-to-content: a short book gets a SHORTER canvas rather than stretching
    // its content to fill a fixed-height canvas (the sparse "empty slots" bug).
    const cssHMax = Math.min(
      Math.max(MIN_CANVAS, Math.round(window.innerHeight * 0.6)),
      Math.max(MIN_CANVAS, Math.round(anchor.barHeight)),
    );
    const maxScale = cssHMax / Math.max(1, viewportVirtual * SPAN_VIEWPORTS);
    const cssH = Math.min(cssHMax, Math.max(MIN_CANVAS, span * maxScale));
    const scale = cssH / span;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== CSS_WIDTH * dpr || canvas.height !== cssH * dpr) {
      canvas.width = CSS_WIDTH * dpr;
      canvas.height = cssH * dpr;
      canvas.style.width = `${CSS_WIDTH}px`;
      canvas.style.height = `${cssH}px`;
    }

    // Vertically follow the thumb, clamped inside the bar's extent.
    const thumbCenter = anchor.barTop + anchor.thumbTop + anchor.thumbHeight / 2;
    const top = Math.min(
      Math.max(anchor.barTop, thumbCenter - cssH / 2),
      anchor.barTop + Math.max(0, anchor.barHeight - cssH),
    );
    canvas.style.top = `${top}px`;

    const spanTop = Math.min(
      Math.max(0, vCenter - span / 2),
      Math.max(0, map.totalHeight - span),
    );
    lastLayout = { spanTop, span, cssH };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CSS_WIDTH, cssH);

    let i = indexAtVirtual(map, spanTop);
    if (i < 0) return;
    const n = map.nodeIds.length;
    const spanBottom = spanTop + span;
    const labels: Array<{ text: string; y: number }> = [];
    for (; i < n; i++) {
      const nodeTop = map.offsets[i] ?? 0;
      if (nodeTop >= spanBottom) break;
      const nodeBottom = map.offsets[i + 1] ?? nodeTop;
      const mini = map.minimap[i];
      if (!mini) continue;
      const y = (nodeTop - spanTop) * scale;
      const h = Math.max(1, (nodeBottom - nodeTop) * scale);
      drawNode(ctx, mini, y, h, CSS_WIDTH, labels);
    }

    // Second pass: heading labels above everything, with a faint knockout so
    // they stay legible over dense line-work.
    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    for (const label of labels) {
      const tw = Math.min(ctx.measureText(label.text).width, CSS_WIDTH - GUTTER_CITE - 3 - PAD_X);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = theme.background;
      ctx.fillRect(PAD_X - 2, label.y - 6, tw + 4, 12);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = theme.text;
      ctx.fillText(label.text, PAD_X, label.y, CSS_WIDTH - GUTTER_CITE - 3 - PAD_X);
    }

    // "This is your screen" band, drawn LAST (on top of the shapes so it's never
    // buried) as a bordered box. Its height is the TRUE proportion of one screen
    // within the lens (never floored) — valid because the lens span is bounded.
    const rawBandTop = (vBandTop - spanTop) * scale;
    const bandH = Math.min(cssH, viewportVirtual * BAND_FRACTION * scale);
    const bandTop = Math.min(Math.max(0, rawBandTop), cssH - bandH);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = theme.text;
    ctx.fillRect(0, bandTop, CSS_WIDTH, bandH);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, bandTop + 0.75, CSS_WIDTH - 1.5, bandH - 1.5);
    ctx.globalAlpha = 1;
  }

  function contains(target: Node): boolean {
    return canvas === target || canvas.contains(target);
  }

  function destroy(): void {
    canvas.remove();
  }

  return { show, hide, paint, contains, destroy };
}
