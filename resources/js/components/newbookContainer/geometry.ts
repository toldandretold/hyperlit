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
}

export function computeFormGeometry(
  { isMobile, isLeftAnchored, buttonRect, innerWidth }: FormGeometryInput,
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

  // Desktop: 400px. Left-anchored (reader) docks to the viewport top-left so the form doesn't
  // run off-screen below the logo nav; right-anchored (home/user) sits just below the + button.
  return {
    width: '400px',
    maxWidth: '400px',
    height: '80vh',
    top: isLeftAnchored ? '50px' : `${buttonRect.bottom + 8}px`,
    padding: '0',
    left: isLeftAnchored ? '50px' : '',
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
