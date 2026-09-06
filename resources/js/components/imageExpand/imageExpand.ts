/**
 * imageExpand — the ⤢ affordance on reader content images.
 *
 * ONE shared body-mounted button (never a per-image wrapper: the <img> is
 * often itself the node, and wrapping it would sit a foreign element between
 * `.chunk` and the node — the id/save hazard the broken-image machinery works
 * around). The button repositions onto the hovered/tapped image and opens the
 * existing figureViewer (already focus-trapped + inventoried). Because it
 * never enters the editable DOM, nothing needs stripping on save (a defensive
 * belt exists in contentProcessor anyway), and E2EE works for free — by click
 * time the img's src is already a decrypted blob URL, and the viewer clones
 * the element.
 *
 * Suppressed while the image is inside a live contenteditable (edit mode) and
 * for broken / still-loading / locked / video-embed images.
 *
 * Lifecycle via ButtonRegistry (pages: ['reader']) — create-once + reset.
 */
import { openFigureViewer } from '../../utilities/figureViewer';

const BTN_CLASS = 'image-expand-btn';

let buttonEl: HTMLButtonElement | null = null;
let currentImg: HTMLImageElement | null = null;
let onPointerOver: ((e: Event) => void) | null = null;
let onPointerOut: ((e: Event) => void) | null = null;
let onClick: ((e: Event) => void) | null = null;
let onHide: (() => void) | null = null;

function qualifies(el: Element | null): el is HTMLImageElement {
  if (!el || el.tagName !== 'IMG') return false;
  const img = el as HTMLImageElement;
  if (!img.closest('.chunk')) return false;
  if (img.closest('[contenteditable="true"]')) return false;
  if (img.classList.contains('broken-image') || img.closest('.broken-image-wrapper')) return false;
  if (img.classList.contains('e2ee-img-loading') || img.classList.contains('e2ee-img-locked')) return false;
  if (img.closest('.video-embed')) return false;
  return true;
}

function ensureButton(): HTMLButtonElement {
  if (buttonEl) return buttonEl;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BTN_CLASS;
  btn.setAttribute('aria-label', 'Expand image');
  btn.textContent = '⤢';
  // Inline-styled (figureViewer precedent) so it never depends on which CSS
  // bundle the page loaded.
  btn.style.cssText = [
    'position:fixed', 'z-index:1500', 'display:none',
    'width:32px', 'height:32px', 'padding:0',
    'border:1px solid rgba(255,255,255,0.35)', 'border-radius:8px',
    'background:rgba(34,31,32,0.65)', 'color:#fff',
    'font-size:18px', 'line-height:30px', 'text-align:center',
    'cursor:pointer', 'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
  ].join(';');
  document.body.appendChild(btn);
  buttonEl = btn;
  return btn;
}

function showFor(img: HTMLImageElement): void {
  const btn = ensureButton();
  currentImg = img;
  const rect = img.getBoundingClientRect();
  btn.style.display = 'block';
  btn.style.top = `${rect.top + 8}px`;
  btn.style.left = `${rect.right - 40}px`;
}

function hide(): void {
  if (buttonEl) buttonEl.style.display = 'none';
  currentImg = null;
}

function downloadNameFor(img: HTMLImageElement): string {
  const canonical = img.dataset.hlSrc ?? img.getAttribute('src') ?? 'figure';
  const base = canonical.split('?')[0]?.split('/').pop() ?? 'figure';
  return base || 'figure';
}

export function initializeImageExpand(): void {
  destroyImageExpand();

  onPointerOver = (e: Event) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (buttonEl && (target === buttonEl || buttonEl.contains(target))) return; // hovering the button keeps it
    if (qualifies(target)) {
      showFor(target);
    }
  };

  onPointerOut = (e: Event) => {
    if (!currentImg) return;
    const to = (e as PointerEvent).relatedTarget;
    // Leaving the image toward the button (or vice versa) keeps it shown.
    if (to instanceof Element && (to === buttonEl || buttonEl?.contains(to) || to === currentImg)) return;
    if (e.target === currentImg || e.target === buttonEl) hide();
  };

  // Click: the button opens the viewer; a tap on a qualifying image arms the
  // button (touch has no hover — pointerover usually covers it, this is the
  // belt for browsers that skip pointerover on tap).
  onClick = (e: Event) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (buttonEl && (target === buttonEl || buttonEl.contains(target))) {
      const img = currentImg;
      if (img) {
        openFigureViewer(img, { downloadName: downloadNameFor(img), fit: 'contain' });
      }
      return;
    }
    if (qualifies(target)) {
      showFor(target);
    } else if (currentImg) {
      hide();
    }
  };

  onHide = () => hide();

  document.addEventListener('pointerover', onPointerOver, true);
  document.addEventListener('pointerout', onPointerOut, true);
  document.addEventListener('click', onClick, true);
  window.addEventListener('scroll', onHide, { capture: true, passive: true });
  window.addEventListener('resize', onHide);
}

export function destroyImageExpand(): void {
  if (onPointerOver) document.removeEventListener('pointerover', onPointerOver, true);
  if (onPointerOut) document.removeEventListener('pointerout', onPointerOut, true);
  if (onClick) document.removeEventListener('click', onClick, true);
  if (onHide) {
    window.removeEventListener('scroll', onHide, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', onHide);
  }
  onPointerOver = onPointerOut = null;
  onClick = null;
  onHide = null;
  buttonEl?.remove();
  buttonEl = null;
  currentImg = null;
}
