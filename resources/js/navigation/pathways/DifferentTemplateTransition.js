/**
 * DifferentTemplateTransition - Universal handler for cross-structure transitions
 * Handles full body replacement for reader↔home, reader↔user, home↔user
 * Structure-aware cleanup and initialization using shared utility functions
 *
 * NOTE: Overlay lifecycle managed by NavigationManager
 * This pathway does NOT hide the overlay - NavigationManager handles that
 */
import { ProgressOverlayConductor } from '../ProgressOverlayConductor.js';
import { LinkNavigationHandler } from '../LinkNavigationHandler.js';
import { cleanupFromStructure } from '../utils/cleanupHelpers.js';
import { initializeToStructure } from '../utils/initHelpers.js';
import { fetchHtml, replaceBodyContent, navigateToHash, updateUrl } from '../utils/contentSwapHelpers.js';
import { log } from '../../utilities/logger.js';

export class DifferentTemplateTransition {
  /**
   * Execute cross-structure transition (full body replacement)
   */
  static async execute(options = {}) {
    const {
      fromStructure: providedFromStructure,
      toStructure: providedToStructure,
      targetUrl,
      toBook,
      hash = '',
      progressCallback
    } = options;

    // Detect structures if not provided
    const fromStructure = providedFromStructure || LinkNavigationHandler.getPageStructure();
    const toStructure = providedToStructure || await this.detectTargetStructure(targetUrl || toBook);

    log.nav(`Page template transition (${fromStructure}→${toStructure})`, '/navigation/pathways/DifferentTemplateTransition.js');

    try {
      const progress = progressCallback || ProgressOverlayConductor.createProgressCallback('spa');

      progress(10, 'Preparing transition...');

      // Step 1: Structure-aware cleanup (using shared utility)
      await cleanupFromStructure(fromStructure);

      progress(30, 'Fetching new page...');

      // Step 2: Fetch target HTML (using shared utility)
      const targetUrlResolved = targetUrl || `/${toBook}`;
      const html = await fetchHtml(targetUrlResolved);

      progress(60, 'Updating page template...');

      // Step 3: Replace body content (using shared utility)
      await replaceBodyContent(html);

      progress(70, 'Waiting for DOM stabilization...');

      // Wait for DOM to stabilize
      const { waitForLayoutStabilization } = await import('../../domReadiness.js');
      await waitForLayoutStabilization();

      progress(80, 'Initializing new page...');

      // Step 4: Structure-aware initialization (using shared utility)
      const bookId = toBook || LinkNavigationHandler.getBookIdFromUrl(targetUrlResolved);
      await initializeToStructure(toStructure, bookId, progress);

      // Step 5: Update URL with state preservation for back button (using shared utility)
      const newUrl = hash ? `${targetUrlResolved}${hash}` : targetUrlResolved;
      updateUrl(newUrl, {
        fromBook: fromStructure === 'reader' ? LinkNavigationHandler.getBookIdFromUrl(window.location.pathname) : null,
        toBook: bookId,
        fromStructure,
        toStructure,
        transitionType: 'template-switch'
      });

      // Step 6: Handle hash navigation if present (using shared utility)
      if (hash) {
        progress(90, 'Navigating to target...');
        await navigateToHash(hash, toStructure);
      }

      progress(100, 'Complete!');

      // NOTE: NavigationManager will hide the overlay when this returns

    } catch (error) {
      console.error(`DifferentTemplateTransition: ${fromStructure}→${toStructure} transition failed:`, error);

      // Fallback to full page navigation
      const fallbackUrl = targetUrl || `/${toBook}${hash}`;
      window.location.href = fallbackUrl;

      throw error;
    }
  }

  /**
   * Detect target structure from URL
   */
  static async detectTargetStructure(url) {
    // For now, use simple heuristics
    // Could be enhanced with fetch + DOM parsing if needed
    const urlObj = new URL(url, window.location.origin);
    const path = urlObj.pathname;

    // Root paths are home
    if (path === '/') {
      return 'home';
    }

    // Check if it's a user page by path
    // This is a simplified check - could enhance with user existence check
    const pathSegments = path.split('/').filter(Boolean);
    if (pathSegments.length === 1) {
      // Could be user page or reader page
      // For now, assume reader unless we can determine it's a user
      // This would need enhancement with actual user detection
      return 'reader';
    }

    return 'reader';
  }
}
