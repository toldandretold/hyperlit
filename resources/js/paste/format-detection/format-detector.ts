/**
 * Format Detector
 * Identifies the format of pasted HTML content using CSS selectors
 */

import { getFormatsByPriority, getFormatConfig, type FormatConfig } from './format-registry';
import { createTempDOM } from '../utils/dom-utils';

export interface FormatScore {
  formatType: string;
  config: FormatConfig;
  /** Vendor-specific selectors that matched — these are what DECIDE a format. */
  signatureHits: SelectorHit[];
  /** Generic selectors that matched — corroboration for the log line only. */
  supportingHits: SelectorHit[];
  /** Publisher-domain selectors that matched — a demoted fallback. */
  domainHits: SelectorHit[];
  totalMatches: number;
}

export interface SelectorHit {
  selector: string;
  count: number;
}

function countMatches(root: Element, selectors: readonly string[], formatType: string): SelectorHit[] {
  const hits: SelectorHit[] = [];
  for (const selector of selectors) {
    try {
      const count = root.querySelectorAll(selector).length;
      if (count > 0) hits.push({ selector, count });
    } catch (error: unknown) {
      console.warn(`Invalid selector "${selector}" for format "${formatType}":`, error);
    }
  }
  return hits;
}

/**
 * Score every registered format against the content, in priority order.
 *
 * Single source of truth for matching, so `detectFormat` and
 * `detectFormatVerbose` cannot drift apart — they did before, because the
 * verbose variant reimplemented the loop and omitted the domain-fallback rule
 * entirely, disagreeing on any Wiley / T&F / Sage domain-only payload.
 */
export function scoreFormats(root: Element): FormatScore[] {
  return getFormatsByPriority().map(([formatType, config]) => {
    const signatureHits = countMatches(root, config.signature, formatType);
    const supportingHits = countMatches(root, config.supporting, formatType);
    const domainHits = countMatches(root, config.domain, formatType);
    const totalMatches = [...signatureHits, ...supportingHits, ...domainHits]
      .reduce((sum, hit) => sum + hit.count, 0);

    return { formatType, config, signatureHits, supportingHits, domainHits, totalMatches };
  });
}

function logDetection(score: FormatScore, label: string, hits: readonly SelectorHit[]) {
  console.log(`📚 Detected ${score.formatType} format${label}:`);
  console.log(`  - Matched ${hits.length}/${score.config.selectors.length} selector patterns`);
  console.log(`  - Total elements: ${score.totalMatches}`);
  console.log(`  - Priority: ${score.config.priority}`);
  console.log(`  - Description: ${score.config.description}`);
  hits.forEach((hit) => console.log(`    ✓ ${hit.selector} (${hit.count} matches)`));
  if (score.supportingHits.length > 0 && hits !== score.supportingHits) {
    const corroborating = score.supportingHits.map((h) => `${h.selector} (${h.count})`).join(', ');
    console.log(`    · corroborating: ${corroborating}`);
  }
}

/**
 * Detect the format of HTML content.
 *
 * A format is CHOSEN only on a `signature` match. `supporting` selectors are too
 * generic to decide anything — before that distinction existed, a Webflow
 * think-tank page matched sage's `[role="listitem"]` on 2 elements and was
 * handed to SageProcessor (prod report book_1787965215968). `domain` matches are
 * held back and used only if nothing matched structurally, so quoting a
 * publisher's URL cannot hijack the format.
 *
 * @param {string} htmlContent - HTML content to analyze
 * @returns {string} - Format type identifier (e.g., 'cambridge', 'oup', 'general')
 */
export function detectFormat(htmlContent: string | null | undefined): string {
  if (!htmlContent || typeof htmlContent !== 'string') {
    console.log('📚 No HTML content provided, using general format');
    return 'general';
  }

  const tempDiv = createTempDOM(htmlContent);

  console.log('🔍 Detecting format from pasted content...');

  // Domain-only matches are saved as fallback — structural matches always win
  let domainOnlyFallback: FormatScore | null = null;

  for (const score of scoreFormats(tempDiv)) {
    // Fallback format (general) has no selectors - always matches
    if (score.config.selectors.length === 0) {
      if (domainOnlyFallback) {
        logDetection(domainOnlyFallback, ' (domain-only fallback)', domainOnlyFallback.domainHits);
        return domainOnlyFallback.formatType;
      }
      console.log(`📚 Using fallback format: ${score.formatType}`);
      return score.formatType;
    }

    if (score.signatureHits.length > 0) {
      logDetection(score, '', score.signatureHits);
      return score.formatType;
    }

    if (score.domainHits.length > 0 && !domainOnlyFallback) {
      console.log(`  ⏳ ${score.formatType}: domain-only match, saving as fallback`);
      domainOnlyFallback = score;
      continue;
    }

    if (score.supportingHits.length > 0) {
      const seen = score.supportingHits.map((h) => `${h.selector} (${h.count})`).join(', ');
      console.log(`  ⏭️ ${score.formatType}: only generic selectors matched, not decisive — ${seen}`);
    }
  }

  // Should never reach here (general format always matches)
  console.warn('⚠️ No format matched, falling back to general');
  return 'general';
}

/**
 * Get processor instance for detected format
 * @param {string} htmlContent - HTML content to analyze
 * @returns {{formatType: string, processor: BaseFormatProcessor}} - Format and processor
 */
export function getProcessorForContent(htmlContent: any) {
  const formatType = detectFormat(htmlContent);
  const config = getFormatConfig(formatType);

  if (!config) {
    throw new Error(`No configuration found for format: ${formatType}`);
  }

  const ProcessorClass = config.processor;
  const processor = new ProcessorClass();

  return {
    formatType,
    processor
  };
}

/**
 * Detect format and return detailed information
 * Useful for debugging and logging
 *
 * Delegates the verdict to `detectFormat` rather than re-deriving it: the two
 * used to reimplement the same loop and the verbose one omitted the
 * domain-fallback rule, so they disagreed on any domain-only payload.
 *
 * @param {string} htmlContent - HTML content to analyze
 * @returns {Object} - Detailed format information
 */
export function detectFormatVerbose(htmlContent: string | null | undefined) {
  const tempDiv = createTempDOM(htmlContent || '');

  const allResults = scoreFormats(tempDiv).map((score) => ({
    formatType: score.formatType,
    // A format is only "matched" in the sense that DECIDES anything when a
    // signature or domain selector hit; generic corroboration does not count.
    matched: score.config.selectors.length === 0
      || score.signatureHits.length > 0
      || score.domainHits.length > 0,
    matchCount: score.totalMatches,
    priority: score.config.priority,
    description: score.config.description,
    matchedSelectors: [...score.signatureHits, ...score.supportingHits, ...score.domainHits]
      .map((hit) => ({ selector: hit.selector, count: hit.count })),
    signatureSelectors: score.signatureHits.map((hit) => hit.selector),
    supportingSelectors: score.supportingHits.map((hit) => hit.selector),
    domainSelectors: score.domainHits.map((hit) => hit.selector),
  }));

  return {
    detectedFormat: detectFormat(htmlContent),
    allResults,
  };
}
