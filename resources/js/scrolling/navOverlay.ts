/**
 * scrolling/navOverlay — thin wrappers over ProgressOverlayConductor for the
 * navigation loading overlay. Legacy entry points kept for back-compat; the
 * Conductor owns the actual overlay state machine.
 */
import { verbose } from '../utilities/logger.js';
import { ProgressOverlayConductor } from '../navigation/ProgressOverlayConductor.js';

export interface NavigationProgressIndicator {
  updateProgress: (percent: number | null, message?: string) => void;
  setMessage: (message: string) => void;
}

export function showNavigationLoading(targetId: string): NavigationProgressIndicator {
  verbose.nav(`[LEGACY] showNavigationLoading called for ${targetId} - delegating to ProgressOverlayConductor`, 'scrolling/navOverlay');

  // Delegate to the new centralized system (now statically imported)
  ProgressOverlayConductor.showSPATransition(5, `Loading ${targetId}...`);

  return {
    updateProgress: (percent: number | null, message?: string) => {
      ProgressOverlayConductor.updateProgress(percent as any, message as any);
    },
    setMessage: (message: string) => {
      ProgressOverlayConductor.updateProgress(null, message as any);
    }
  };
}

export async function hideNavigationLoading(): Promise<void> {
  verbose.content(`[LEGACY] hideNavigationLoading called - delegating to ProgressOverlayConductor`, 'scrolling/navOverlay');

  // Delegate to the new centralized system (now statically imported)
  await ProgressOverlayConductor.hide();
}

/**
 * DEPRECATED no-op. The ProgressOverlayEnactor handles its own state restoration
 * via _bindElements() (detects overlay visibility on init), so nothing to do here.
 */
export function restoreNavigationOverlayIfNeeded(): boolean {
  verbose.nav('[LEGACY] restoreNavigationOverlayIfNeeded called - now handled by ProgressOverlayEnactor._bindElements()', 'scrolling/navOverlay');

  // Clear any legacy session storage flags (no longer used)
  sessionStorage.removeItem('navigationOverlayActive');
  sessionStorage.removeItem('navigationTargetId');

  return false; // Always return false - restoration handled by Enactor
}
