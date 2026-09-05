// Single source of truth for the import-form's size + anchoring. Previously this mobile/desktop
// math was written THREE times (setResponsiveFormSize + two blocks in openContainer); they're
// collapsed here. `computeFormGeometry` is pure; `applyFormGeometry` writes the result onto the
// container (optionally including left/right anchoring). Leaf module — imports nothing.
import type { ButtonRect } from './host';

export interface FormGeometry {
  width: string;
  height: string;
  top: string;
  padding: string;
  maxWidth: string;
  left: string;
  right: string;
}

export interface FormGeometryInput {
  isMobile: boolean;
  isLeftAnchored: boolean;
  buttonRect: ButtonRect;
  innerWidth: number;
  /** Right edge of #logoNavWrapper (left-anchored desktop only): the form flies
      out to the right of the logo-nav glass column instead of covering it. */
  navRight?: number | null;
}

export function computeFormGeometry(
  { isMobile, isLeftAnchored, buttonRect, innerWidth, navRight }: FormGeometryInput,
): FormGeometry {
  if (isMobile) {
    // Full-width sheet on left-anchored (reader); right-edge-sized on right-anchored (home/user).
    const width = isLeftAnchored ? innerWidth - 30 : buttonRect.right - 15;
    return {
      width: `${width}px`,
      maxWidth: `${width}px`,
      height: 'calc(100vh - 100px)',
      top: '50px',
      padding: '15px',
      left: '15px',
      right: '',
    };
  }

  // Desktop: 400px. Left-anchored (reader) flies out to the right of the logo-nav column
  // (start-menu style; falls back to the old 50/50 dock if the wrapper is missing),
  // clamped to the viewport — on narrow windows it slides left over the nav, stacking
  // on top of it (the panel z-index sits above the nav for exactly this case);
  // right-anchored (home/user) sits just below the + button.
  const leftFlyout = navRight != null
    ? Math.max(10, Math.min(navRight + 4, innerWidth - 400 - 10))
    : 50;
  return {
    width: '400px',
    maxWidth: '400px',
    height: '80vh',
    top: isLeftAnchored ? '15px' : `${buttonRect.bottom + 8}px`,
    padding: '0',
    left: isLeftAnchored ? `${leftFlyout}px` : '',
    right: isLeftAnchored ? '' : `${innerWidth - buttonRect.right}px`,
  };
}

// Apply size to the container. `anchor` also writes left/right — used on a fresh open (the
// container has no prior position); the buttons→form transition leaves the already-set
// left/right alone (anchor:false) so it doesn't jump.
export function applyFormGeometry(
  container: HTMLElement,
  geom: FormGeometry,
  { anchor = false }: { anchor?: boolean } = {},
): void {
  container.style.width = geom.width;
  container.style.height = geom.height;
  container.style.top = geom.top;
  container.style.padding = geom.padding;
  container.style.maxWidth = geom.maxWidth;
  if (anchor) {
    container.style.left = geom.left;
    container.style.right = geom.right;
  }
}
