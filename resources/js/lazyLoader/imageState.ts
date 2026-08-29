import { nextScrollReason, scrollTraceEnabled } from '../scrolling/scrollTrace';
import { userScrollState } from '../scrolling/navState';

// Debug ring for the compensation belt — populated only while the
// hyperlit_scroll_trace flag is on (the e2e forensics helper sets it), so the
// scroll-forensics failure dumps can show WHY a write did/didn't happen.
function imgCompDbg(rec: Record<string, unknown>) {
  if (!scrollTraceEnabled()) return;
  const w = window as any;
  (w.__imgComp ??= []).push({ t: Math.round(performance.now()), ...rec });
  if (w.__imgComp.length > 60) w.__imgComp.shift();
}

/**
 * Attach error handlers to images in a chunk element.
 * On 404/error, preserves the image's aspect ratio (preventing layout shift)
 * and shows a broken-image placeholder with a delete button for edit mode.
 *
 * Also attaches the ABOVE-VIEWPORT SETTLE COMPENSATION: an unsized image
 * (no width/height attrs — harvester/paste/imported content) occupies zero
 * height until decode, then grows. When such an image ENTIRELY above the
 * scroller's top edge settles, every pixel of growth shoves the visible
 * content down with (previously) no corrector — the "page slides under my
 * finger" class of bug (prepend path measures chunks pre-decode; refresh
 * teardown rebuilds at zero heights). Here: measure the box delta at fire
 * time, and if the pre-growth box was fully above the scroller's top edge,
 * push scrollTop down by exactly that delta — the viewport content does not
 * move. During navigation/refresh windows (userScrollState.isNavigating) the
 * scrollHelpers navigate-and-correct belt owns corrections, so we stand down
 * to avoid double-compensating; our own writes echo back as bare `scroll`
 * events and are swallowed by the detector via userScrollState.isCompensating
 * (a real wheel/touch/key gesture during that window still registers and
 * cancels this belt).
 */
export function handleBrokenImages(container: any, instance?: any) {
  const images = container.querySelectorAll('img');
  if (images.length === 0) return;

  images.forEach((img: any) => {
    attachSettleCompensation(img, instance);
    // PROACTIVE: Set aspect-ratio immediately to prevent Safari collapse on 404.
    // CSS spec: height:auto uses aspect-ratio as fallback when the image has no
    // intrinsic ratio (broken). This reserves space before the error event fires.
    const w = img.getAttribute('width');
    const h = img.getAttribute('height');
    if (w && h) {
      img.style.aspectRatio = `${w} / ${h}`;
    } else {
      // Self-healing: capture dimensions on load so they persist on next save
      img.addEventListener('load', () => {
        if (img.naturalWidth && img.naturalHeight) {
          img.setAttribute('width', img.naturalWidth);
          img.setAttribute('height', img.naturalHeight);
          img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }
      }, { once: true });
    }

    // If the image is ALREADY flagged broken in stored content, decorate it
    // NOW — don't wait for an error event. On save the sanitizer strips the
    // `.broken-image-wrapper` + delete button but keeps `class="broken-image"`
    // on the <img>; without this, a reload would leave a broken image whose
    // error handler bails on the "already handled" guard, so it could never be
    // deleted (no button).
    if (img.classList.contains('broken-image')) {
      decorateBrokenImage(img, w, h);
    }

    img.addEventListener('error', () => {
      decorateBrokenImage(img, w, h);
    }, { once: true });
  });
}

/**
 * Above-fold settle compensation — FIXED-PROBE DRIFT CLAMP.
 *
 * While any unsized image (no width/height attrs) attached through here is
 * waiting to decode, a rAF loop tracks ONE stable probe: the fold-straddling
 * node at belt start (first `.chunk > [id]` crossing the scroller's top
 * edge). Each frame the loop measures drift = (probeVpTop_now - probeVpTop_at
 * start) + scrollDelta. Growth above the fold pushes the probe down (+vp)
 * with no scroll; wheel gestures move both (vpDelta + scrollDelta ≈ 0). The
 * residue is exactly what above-fold growth did to the fold content, and the
 * loop writes scrollTop by that residue — the fold content never visually
 * moves. The probe element is kept for the whole pend (identity never changes
 * mid-storm, so there is no switchover frame that could absorb growth), which
 * is what made the per-image delta-sum/previous fold-anchor variants
 * under-compensate during big decode storms.
 *
 * Stand-down rules — the loop TRACKS (re-baselines every frame) but does not
 * write while:
 *  - userScrollState.isScrolling (a real gesture owns the scroller: growth
 *    during the gesture is absorbed into the baseline — a small slide is the
 *    price of never fighting a finger)
 *  - userScrollState.isNavigating (scrollHelpers' landing belt owns
 *    corrections during nav/refresh landing windows)
 * The loop's own writes set userScrollState.isCompensating for ~120ms so the
 * bare `scroll` echo is swallowed by userScrollDetection and can't self-mark
 * the user as scrolling (that echo was what poisoned the first delta belt:
 * browser-native anchoring → scroll event → isScrolling → belt skipped
 * everything; anchoring is now disabled on these scrollers — layout.css).
 *
 * Self-limiting: the loop runs only while ≥1 watched image is pending decode,
 * plus a ~400ms tail, then stops. Zero rAF cost in steady state.
 */

// Per-scroller belt state. The reader has a primary scroller (+ sub-book
// overrides), so key by element; entry is removed when the loop stops.
interface BeltState {
  pending: number;
  watching: boolean;
  tailUntil: number;
  probeEl: Element | null;
  probeVpTop: number | null; // probe top relative to scroller top (px)
  prevScrollTop: number;
  bracketTimer: ReturnType<typeof setTimeout> | null;
  /** Growth displacement banked during a gesture stand-down (px). The belt
   *  never writes against an active gesture — but silently ABSORBING a decode
   *  burst that lands inside the ~1s post-wheel window loses the reading line
   *  by the full burst height (spec-B forensics: 5411px gone because the
   *  images decoded 180ms after the last wheel tick). So drift is banked here
   *  frame-by-frame while isScrolling, and paid back in ONE catch-up write as
   *  soon as the gesture window closes. */
  debtPx: number;
  /** lastGestureScrollTime at the most recent bank. A NEW gesture arriving
   *  after a displacement means the reader has seen the moved layout and
   *  repositioned within it — paying the old debt then would jump them again,
   *  so it is dropped. */
  debtGestureStamp: number;
}
const _belts = new WeakMap<Element, BeltState>();

/**
 * Is the settle-compensation belt quiet on this scroller? Read-only mirror of
 * the belt's own shutdown predicate (minus the give-up debt cap: a belt still
 * holding banked debt is NOT quiet — that debt becomes a scroll write). Used
 * by the resume-curtain reveal gate as the "images have stopped moving the
 * page" half of its stability check. No belt entry at all = quiet.
 */
export function isBeltQuiet(scroller: Element): boolean {
  const s = _belts.get(scroller);
  if (!s) return true;
  return s.pending === 0
    && performance.now() > s.tailUntil
    && Math.abs(s.debtPx) < 2;
}

// Bracket our own write so its bare `scroll` echo doesn't self-cancel the
// belt (see userScrollDetection: the swallow covers ONLY bare scroll events;
// wheel/touchmove/keydown gestures still register and shut the loop's
// corrective arm off via isScrolling).
function bracketCompensationWrite(scroller: any) {
  const s = _belts.get(scroller);
  if (!s) return;
  userScrollState.isCompensating = true;
  if (s.bracketTimer) clearTimeout(s.bracketTimer);
  s.bracketTimer = setTimeout(() => { userScrollState.isCompensating = false; }, 120);
}

// The node content currently straddling the scroller's top edge — the probe
// seed. Any element with an id works; we just need it to stay connected and
// to start near the fold (so growth above it is growth the fold feels).
function pickProbe(scroller: any): { el: any; vpTop: number } | null {
  const sRect = scroller.getBoundingClientRect();
  const nodes = scroller.querySelectorAll('.chunk > [id]');
  for (const el of nodes) {
    const r = (el as any).getBoundingClientRect();
    if (r.bottom > sRect.top + 1) {
      return { el, vpTop: r.top - sRect.top };
    }
    if (r.top > sRect.top + 800) break; // fold long passed — scan no further
  }
  return null;
}

function reseedProbe(s: BeltState, scroller: any) {
  const p = pickProbe(scroller);
  s.probeEl = p ? p.el : null;
  s.probeVpTop = p ? p.vpTop : null;
  s.prevScrollTop = scroller.scrollTop;
}

function beltFrame(scroller: any) {
  const s = _belts.get(scroller);
  if (!s || !scroller.isConnected) return;
  const now = performance.now();
  // Outstanding gesture-window debt keeps the loop alive past the tail (the
  // catch-up write can only happen after isScrolling clears) — hard-capped at
  // 10s past the tail so a never-idle scroller can't pin the loop forever.
  if (
    s.pending === 0 && now > s.tailUntil &&
    (Math.abs(s.debtPx) < 2 || now > s.tailUntil + 10_000)
  ) {
    s.watching = false;
    _belts.delete(scroller);
    return;
  }

  const probe = s.probeEl;
  const probeRect = probe && (probe as any).isConnected ? (probe as any).getBoundingClientRect() : null;
  const sRect = probeRect ? scroller.getBoundingClientRect() : null;
  if (!probeRect || !sRect) {
    reseedProbe(s, scroller); // chunk eviction / re-render — silent rebaseline
  } else if (s.probeVpTop !== null) {
    const probeVpNow = probeRect.top - sRect.top;
    const cur = scroller.scrollTop;
    const scrollDelta = cur - s.prevScrollTop;
    // drift: fold-content movement NOT explained by scroll
    const drift = (probeVpNow - s.probeVpTop) + scrollDelta;
    // What a write must correct: this frame's drift PLUS anything banked
    // during gesture stand-down frames (see BeltState.debtPx).
    const effective = drift + s.debtPx;

    // A displacement larger than the viewport is corrected IMMEDIATELY, even
    // inside the gesture window: the finger moves tens of px per frame, the
    // shove moved the page a full screen-plus — leaving it standing until the
    // ~1s scroll flag decays is an 850ms visible teleport-and-snap-back
    // (spec-B forensics: 5926px paid back late). Proportionally the gesture
    // noise is nothing; re-pinning the content under the finger IS the
    // correct physics.
    const viewportH = scroller.clientHeight || 0;
    const overwhelming = viewportH > 0 && Math.abs(effective) > viewportH;

    if (
      Math.abs(effective) > 2 &&
      (!userScrollState.isScrolling || overwhelming) &&
      !userScrollState.isNavigating
    ) {
      const debtPaid = s.debtPx;
      imgCompDbg({
        op: 'fold-clamp', probeId: (probe as any).id || '?', drift: Math.round(drift),
        debt: Math.round(debtPaid),
        prevTop: Math.round(s.prevScrollTop), newTop: Math.round(cur + effective),
      });
      s.debtPx = 0;
      bracketCompensationWrite(scroller);
      nextScrollReason('image-above-compensation');
      scroller.scrollTop = cur + effective;
      // Baseline on what the browser ACTUALLY applied, not what we asked for:
      // at the bottom of the scroller the write clamps to scrollHeight -
      // clientHeight, and a baseline of the requested value makes next frame's
      // scrollDelta negative with an unmoved probe → negative drift → the belt
      // scrolls UP → self-sustaining oscillation at book end.
      const applied = scroller.scrollTop;
      s.prevScrollTop = applied;
      if (Math.abs(applied - (cur + effective)) > 1) {
        // Clamped: the growth is un-correctable from here — accept it by
        // re-baselining the probe at its current position instead of retrying.
        s.probeVpTop = (probe as any).getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      } else if (debtPaid !== 0 && s.probeVpTop !== null) {
        // The drift component returns the probe to its pin; the DEBT component
        // moves the pin itself (that growth was accepted into the baseline
        // during the gesture, and paying it back shifts the probe up by
        // exactly debtPaid). Without this shift the next frame reads -debtPaid
        // as fresh drift and writes straight back — a one-frame oscillation.
        s.probeVpTop = s.probeVpTop - debtPaid;
      }
      s.tailUntil = now + 400;
    } else {
      // Gesture stand-down: never write against a finger, but BANK the drift
      // (growth displacement) so it is paid back the moment the gesture window
      // closes — silently absorbing it loses the reading line by the full
      // burst height. Navigation stand-down deliberately banks nothing: the
      // scrollHelpers landing belt owns corrections there, and paying debt on
      // top of its re-anchor would double-correct.
      if (userScrollState.isScrolling && !userScrollState.isNavigating) {
        if (userScrollState.lastGestureScrollTime > s.debtGestureStamp) {
          s.debtPx = 0; // reader gestured AFTER the displacement — re-anchored
        }
        s.debtPx += drift;
        s.debtGestureStamp = userScrollState.lastGestureScrollTime;
      } else if (userScrollState.isNavigating) {
        s.debtPx = 0;
      }
      // Track: rebaseline so the next frame's drift is relative to NOW (this
      // is both normal convergence AND the absorbed-growth path during
      // stand-down windows).
      //
      // Reseed here — and ONLY here — when the probe has left the viewport
      // band. At a rebaseline moment we are accepting current state anyway, so
      // a probe far from the fold (the user scrolled away from it) would from
      // now on measure growth BETWEEN the fold and itself as drift and scroll
      // the fold content off the screen (the first prepend forensics: probe
      // 5600px below, release shoved scrollTop +5411). Critically this check
      // must NOT run before the drift computation above: a decode burst can
      // push a legitimately-pinned probe out of the band in a single frame,
      // and reseeding then would ABSORB the growth instead of compensating it
      // (the second prepend forensics: fold content slid ~2800px with only a
      // +258 correction).
      if (probeRect.bottom <= sRect.top || probeRect.top >= sRect.bottom) {
        reseedProbe(s, scroller);
      } else {
        s.probeVpTop = probeVpNow;
        s.prevScrollTop = cur;
      }
    }
  }
  requestAnimationFrame(() => beltFrame(scroller));
}

function ensureBeltWatching(scroller: any) {
  let s = _belts.get(scroller);
  if (!s) {
    s = {
      pending: 0, watching: false, tailUntil: 0,
      probeEl: null, probeVpTop: null, prevScrollTop: scroller.scrollTop,
      bracketTimer: null,
      debtPx: 0, debtGestureStamp: 0,
    };
    _belts.set(scroller, s);
    reseedProbe(s, scroller);
  }
  if (!s.watching) {
    s.watching = true;
    imgCompDbg({ op: 'belt-start', scrollTop: Math.round(scroller.scrollTop) });
    requestAnimationFrame(() => beltFrame(scroller));
  }
  return s;
}

function attachSettleCompensation(img: any, instance: any) {
  if (!instance) return;
  const scroller = instance.scrollableParent;
  if (!scroller || scroller === window) return;
  if (img.getAttribute('width') && img.getAttribute('height')) return;
  if (instance.pagingMode) return;
  if (img.complete && img.naturalWidth > 0) return;
  if (img.dataset.foldWatch) return;
  img.dataset.foldWatch = '1';

  const s = ensureBeltWatching(scroller);
  s.pending++;
  const settle = (cause: string) => {
    s.pending--;
    s.tailUntil = performance.now() + 400; // tail: catch trailing reflow
    imgCompDbg({
      cause, op: 'img-settle', pending: s.pending,
      src: (img.currentSrc || img.src || '').split(/[?#]/)[0].split('/').pop(),
      nowH: img.offsetHeight || 0,
    });
  };

  img.addEventListener('load', () => settle('load'), { once: true });
  img.addEventListener('error', () => queueMicrotask(() => settle('error')), { once: true });
}

/**
 * Mark an image as broken and ensure it's wrapped with a delete button.
 * Idempotent: safe to call on an already-decorated image (re-uses the existing
 * wrapper / button rather than duplicating them).
 */
function decorateBrokenImage(img: any, w: string | null, h: string | null) {
  img.classList.add('broken-image');

  if (!w || !h) {
    img.style.minHeight = '200px';
  }
  img.style.width = '100%';
  img.alt = 'Image failed to load';

  const picture = img.closest('picture') || img;

  // Already wrapped (fresh error after we decorated, or a wrapper survived in
  // stored content) → just make sure the delete button is present.
  const existingWrapper = picture.closest('.broken-image-wrapper');
  if (existingWrapper) {
    ensureDeleteButton(existingWrapper);
    return;
  }

  const parent = picture.parentNode;
  if (!parent) return;

  // Wrap in a container with contenteditable="false" to prevent mutation tracking
  const wrapper = document.createElement('div');
  wrapper.className = 'broken-image-wrapper';
  wrapper.setAttribute('contenteditable', 'false');

  parent.insertBefore(wrapper, picture);
  wrapper.appendChild(picture);
  ensureDeleteButton(wrapper);
}

/** Append the broken-image delete button to a wrapper if it doesn't have one. */
function ensureDeleteButton(wrapper: any) {
  if (wrapper.querySelector('.broken-image-delete-btn')) return;

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'broken-image-delete-btn';
  deleteBtn.setAttribute('data-action', 'delete-broken-image');
  deleteBtn.setAttribute('aria-label', 'Delete broken image');
  deleteBtn.title = 'Delete broken image';
  wrapper.appendChild(deleteBtn);
}
