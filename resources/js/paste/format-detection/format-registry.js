/**
 * Format Registry
 * Central registry for all format processors
 * To add a new format, just add an entry here!
 */

import { GeneralProcessor } from '../format-processors/general-processor.js';
import { CambridgeProcessor } from '../format-processors/cambridge-processor.js';
import { TaylorFrancisProcessor } from '../format-processors/taylor-francis-processor.js';
import { OupProcessor } from '../format-processors/oup-processor.js';
import { SageProcessor } from '../format-processors/sage-processor.js';
import { ScienceDirectProcessor } from '../format-processors/science-direct-processor.js';

/**
 * Format registry structure:
 * {
 *   formatType: {
 *     selectors: Array<string>,  // CSS selectors that identify this format
 *     processor: Class,          // Processor class for this format
 *     priority: number,          // Higher = checked first (0-10 range)
 *     description: string        // Human-readable description
 *   }
 * }
 */
export const FORMAT_REGISTRY = {
  // NOTE: Formats are checked in priority order (highest first)
  // More specific formats should have higher priority

  // Science Direct - Priority 5
  'science-direct': {
    selectors: [
      '[data-xocs-content-id^="bib"]',
      '.anchor.anchor-primary[data-sd-ui-side-panel-opener]',
      'span.reference[id^="sref"]'
    ],
    processor: ScienceDirectProcessor,
    priority: 5,
    description: 'Science Direct content with XOCS data attributes'
  },

  // OUP (Oxford University Press) - Priority 4
  'oup': {
    selectors: [
      '[content-id^="bib"]',
      '.js-splitview-ref-item',
      '.footnote[content-id^="fn"]'
    ],
    processor: OupProcessor,
    priority: 4,
    description: 'Oxford University Press content with content-id attributes'
  },

  // Cambridge - Priority 3
  'cambridge': {
    selectors: [
      '.xref.fn',
      '.circle-list__item__grouped__content',
      '[id^="reference-"][id$="-content"]'
    ],
    processor: CambridgeProcessor,
    priority: 3,
    description: 'Cambridge University Press content with xref.fn links'
  },

  // Taylor & Francis - Priority 2
  'taylor-francis': {
    selectors: [
      '.ref-lnk.lazy-ref.bibr',
      '.NLM_sec',
      '.hlFld-Abstract',
      'li[id^="CIT"]'
    ],
    processor: TaylorFrancisProcessor,
    priority: 2,
    description: 'Taylor & Francis content with CIT IDs'
  },

  // Sage - Priority 1
  'sage': {
    selectors: [
      '.citations',
      '.ref',
      '[role="listitem"]'
    ],
    processor: SageProcessor,
    priority: 1,
    description: 'Sage Publications content'
  },

  // General - Priority 0 (fallback, always matches)
  'general': {
    selectors: [],  // Empty = matches anything (fallback)
    processor: GeneralProcessor,
    priority: 0,
    description: 'General format (fallback for unrecognized formats)'
  }
};

/**
 * Get all registered formats sorted by priority (descending)
 * @returns {Array<[string, Object]>} - Array of [formatType, config] tuples
 */
export function getFormatsByPriority() {
  return Object.entries(FORMAT_REGISTRY)
    .sort(([, a], [, b]) => b.priority - a.priority);
}

/**
 * Get format configuration by type
 * @param {string} formatType - Format type identifier
 * @returns {Object|null} - Format configuration or null if not found
 */
export function getFormatConfig(formatType) {
  return FORMAT_REGISTRY[formatType] || null;
}

/**
 * Register a new format dynamically
 * Useful for plugins or extensions
 *
 * @param {string} formatType - Format type identifier
 * @param {Object} config - Format configuration
 */
export function registerFormat(formatType, config) {
  if (FORMAT_REGISTRY[formatType]) {
    console.warn(`Format "${formatType}" is already registered, overwriting...`);
  }

  // Validate config
  if (!config.processor) {
    throw new Error(`Format config must include a processor class`);
  }

  if (!Array.isArray(config.selectors)) {
    throw new Error(`Format config must include selectors array`);
  }

  if (typeof config.priority !== 'number') {
    throw new Error(`Format config must include priority number`);
  }

  FORMAT_REGISTRY[formatType] = {
    selectors: config.selectors,
    processor: config.processor,
    priority: config.priority,
    description: config.description || `Custom format: ${formatType}`
  };

  console.log(`📚 Registered format: ${formatType} (priority ${config.priority})`);
}
