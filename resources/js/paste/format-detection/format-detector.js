/**
 * Format Detector
 * Identifies the format of pasted HTML content using CSS selectors
 */

import { getFormatsByPriority, getFormatConfig } from './format-registry.js';
import { createTempDOM } from '../utils/dom-utils.js';

/**
 * Detect the format of HTML content
 * Uses CSS selector matching against registered formats
 *
 * @param {string} htmlContent - HTML content to analyze
 * @returns {string} - Format type identifier (e.g., 'cambridge', 'oup', 'general')
 */
export function detectFormat(htmlContent) {
  if (!htmlContent || typeof htmlContent !== 'string') {
    console.log('📚 No HTML content provided, using general format');
    return 'general';
  }

  const tempDiv = createTempDOM(htmlContent);

  // Get formats sorted by priority (highest first)
  const formats = getFormatsByPriority();

  console.log('🔍 Detecting format from pasted content...');

  for (const [formatType, config] of formats) {
    // Fallback format (general) has no selectors - always matches
    if (config.selectors.length === 0) {
      console.log(`📚 Using fallback format: ${formatType}`);
      return formatType;
    }

    // Check if any selector matches
    const matchedSelectors = [];
    let totalMatches = 0;

    for (const selector of config.selectors) {
      try {
        const elements = tempDiv.querySelectorAll(selector);
        if (elements.length > 0) {
          matchedSelectors.push(selector);
          totalMatches += elements.length;
        }
      } catch (error) {
        console.warn(`Invalid selector "${selector}" for format "${formatType}":`, error);
      }
    }

    // If we found matches, this is our format
    if (matchedSelectors.length > 0) {
      console.log(`📚 Detected ${formatType} format:`);
      console.log(`  - Matched ${matchedSelectors.length}/${config.selectors.length} selector patterns`);
      console.log(`  - Total elements: ${totalMatches}`);
      console.log(`  - Priority: ${config.priority}`);
      console.log(`  - Description: ${config.description}`);

      // Log which selectors matched (helpful for debugging)
      matchedSelectors.forEach(sel => {
        const count = tempDiv.querySelectorAll(sel).length;
        console.log(`    ✓ ${sel} (${count} matches)`);
      });

      return formatType;
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
export function getProcessorForContent(htmlContent) {
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
 * @param {string} htmlContent - HTML content to analyze
 * @returns {Object} - Detailed format information
 */
export function detectFormatVerbose(htmlContent) {
  const tempDiv = createTempDOM(htmlContent);
  const formats = getFormatsByPriority();

  const results = [];

  for (const [formatType, config] of formats) {
    if (config.selectors.length === 0) {
      results.push({
        formatType,
        matched: true,
        matchCount: 0,
        priority: config.priority,
        description: config.description,
        matchedSelectors: []
      });
      continue;
    }

    const matchedSelectors = [];
    let totalMatches = 0;

    for (const selector of config.selectors) {
      try {
        const elements = tempDiv.querySelectorAll(selector);
        if (elements.length > 0) {
          matchedSelectors.push({
            selector,
            count: elements.length
          });
          totalMatches += elements.length;
        }
      } catch (error) {
        // Skip invalid selectors
      }
    }

    results.push({
      formatType,
      matched: matchedSelectors.length > 0,
      matchCount: totalMatches,
      priority: config.priority,
      description: config.description,
      matchedSelectors
    });
  }

  // Sort by priority
  results.sort((a, b) => b.priority - a.priority);

  // Find the first match
  const detectedFormat = results.find(r => r.matched);

  return {
    detectedFormat: detectedFormat?.formatType || 'general',
    allResults: results
  };
}
