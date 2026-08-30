/**
 * Format Registry
 * Central registry for all format processors
 * To add a new format, just add an entry here!
 */

import { GeneralProcessor } from '../format-processors/general-processor';
import { CambridgeProcessor } from '../format-processors/cambridge-processor';
import { TaylorFrancisProcessor } from '../format-processors/taylor-francis-processor';
import { OupProcessor } from '../format-processors/oup-processor';
import { SageProcessor } from '../format-processors/sage-processor';
import { ScienceDirectProcessor } from '../format-processors/science-direct-processor';
import { SpringerProcessor } from '../format-processors/springer-processor';
import { SubstackProcessor } from '../format-processors/substack-processor';
import { WileyProcessor } from '../format-processors/wiley-processor';
import { MitPressProcessor } from '../format-processors/mit-press-processor';
import { BristolUPProcessor } from '../format-processors/bristol-up-processor';
import type { BaseFormatProcessor } from '../format-processors/base-processor';

/** Constructor of any format processor. */
export type FormatProcessorClass = new () => BaseFormatProcessor;

/**
 * Selectors come in THREE strengths, because "any selector matched" is not
 * evidence. A Webflow think-tank page (common-wealth.org, prod report
 * book_1787965215968) matched sage's `[role="listitem"]` on 2 elements and was
 * handed to SageProcessor, which found nothing and left the page to a
 * double-processing fallback. Webflow puts `role="listitem"` on every Collection
 * List item, so that selector fires on a large slice of the web.
 *
 * - `signature`  — vendor-specific enough to DECIDE a format on its own.
 * - `supporting` — generic; may corroborate in the logs, may NEVER decide.
 * - `domain`     — a link to the publisher's own domain. Strong evidence, but
 *                  deliberately demoted below any structural signature match so
 *                  that quoting a publisher's URL doesn't hijack the format.
 *
 * When a real capture regresses because its only match was demoted, DO NOT
 * re-promote the generic selector — add a narrower signature that matches the
 * fixture and not the rest of the web.
 */
export interface FormatConfig {
  /** Vendor-specific selectors; a match here chooses the format. */
  signature: string[];
  /** Generic selectors; corroborate only, never decide. */
  supporting: string[];
  /** Publisher-domain links; chosen only if nothing else matched structurally. */
  domain: string[];
  /** All three concatenated. Derived — do not hand-author. */
  selectors: string[];
  processor: FormatProcessorClass;
  priority: number;
  description: string;
}

type FormatDefinition = Omit<Partial<FormatConfig>, 'processor' | 'priority' | 'description'> & {
  processor: FormatProcessorClass;
  priority: number;
  description: string;
};

function defineFormat(definition: FormatDefinition): FormatConfig {
  // A bare `selectors` array (the documented plugin contract) is treated as all
  // signature, so third-party registrations keep their previous behaviour.
  const signature = definition.signature ?? definition.selectors ?? [];
  const supporting = definition.supporting ?? [];
  const domain = definition.domain ?? [];

  return {
    signature,
    supporting,
    domain,
    selectors: [...signature, ...supporting, ...domain],
    processor: definition.processor,
    priority: definition.priority,
    description: definition.description,
  };
}

// NOTE: Formats are checked in priority order (highest first), and ties resolve
// in the insertion order below — keep both stable when editing.
export const FORMAT_REGISTRY: Record<string, FormatConfig> = {
  // Science Direct - Priority 5
  'science-direct': defineFormat({
    signature: [
      '[data-xocs-content-id^="b"]',
      '.anchor.anchor-primary[data-sd-ui-side-panel-opener]',
    ],
    // `class="reference"` is a plausible class on any site.
    supporting: ['span.reference[id]'],
    processor: ScienceDirectProcessor,
    priority: 5,
    description: 'Science Direct content with XOCS data attributes',
  }),

  // MIT Press (direct.mit.edu, Silverchair) - Priority 5
  // Distinguished from OUP by data-content-id / data-modal-source-id (OUP uses
  // bare content-id), so it must be checked before OUP.
  'mit-press': defineFormat({
    signature: [
      'a[data-modal-source-id^="bib"]',
      '[data-content-id^="bib"]',
      '.fn[content-id^="fn"]',
    ],
    processor: MitPressProcessor,
    priority: 5,
    description: 'MIT Press (direct.mit.edu) Silverchair content with data-content-id attributes',
  }),

  // OUP (Oxford University Press) - Priority 4
  'oup': defineFormat({
    signature: [
      '[content-id^="bib"]',
      '.js-splitview-ref-item',
      '.footnote[content-id^="fn"]',
    ],
    processor: OupProcessor,
    priority: 4,
    description: 'Oxford University Press content with content-id attributes',
  }),

  // Springer - Priority 4
  'springer': defineFormat({
    signature: [
      '[id^="ref-CR"]',
      'a[href*="#ref-CR"]',
    ],
    // `Fn`-prefixed ids are SELF-INFLICTED: base-processor mints footnote ids as
    // `Fn{timestamp}_{rand}`, so re-pasting Hyperlit's own output used to detect
    // as Springer. Demoting the id selector without its href twin would be
    // cosmetic, so both move.
    supporting: [
      '[id^="Fn"]',
      'a[href*="#Fn"]',
      'a[data-track="click"][data-track-label="link"][href*="springer.com"]',
    ],
    processor: SpringerProcessor,
    priority: 4,
    description: 'Springer Nature content with ref-CR and Fn ID patterns',
  }),

  // Substack - Priority 4
  'substack': defineFormat({
    signature: [
      'a[data-component-name="FootnoteAnchorToDOM"]',
      '[id^="footnote-anchor-"]',
      'a[href*="substack.com"][href*="#footnote-"]',
    ],
    supporting: ['.footnote-content'],
    processor: SubstackProcessor,
    priority: 4,
    description: 'Substack newsletter content with FootnoteAnchorToDOM components',
  }),

  // Wiley Online Library - Priority 4
  'wiley': defineFormat({
    signature: [
      'a.bibLink',                                              // citation links with bibLink class
      '[data-bib-id]',                                          // reference list items
      'a.tab-link[href^="#"][data-tab="pane-pcw-references"]',  // links into the references pane
    ],
    domain: ['a[href*="onlinelibrary.wiley"]'],
    processor: WileyProcessor,
    priority: 4,
    description: 'Wiley Online Library journals with bibId-based citations',
  }),

  // Cambridge - Priority 3
  'cambridge': defineFormat({
    signature: [
      '.xref.fn',
      '.circle-list__item__grouped__content',
      '[id^="reference-"][id$="-content"]',
    ],
    processor: CambridgeProcessor,
    priority: 3,
    description: 'Cambridge University Press content with xref.fn links',
  }),

  // Taylor & Francis - Priority 4
  'taylor-francis': defineFormat({
    signature: [
      '.ref-lnk.lazy-ref.bibr',
      '.NLM_sec',
      '.hlFld-Abstract',
      'li[id^="CIT"]',
    ],
    domain: ['a[href*="tandfonline.com"]'],
    processor: TaylorFrancisProcessor,
    priority: 4,
    description: 'Taylor & Francis content with CIT IDs',
  }),

  // Bristol University Press Digital - Priority 5
  // Must outrank sage (3): a BUP page matches sage's generic `[role="listitem"]` selector and
  // was being processed by SageProcessor, which left the hidden mixed-citation duplicates and
  // the whole surrounding site in the imported book. (The signature/supporting split below is
  // the real fix for that class of bug; the priority ordering is kept for the tie-break.)
  'bristol-up': defineFormat({
    signature: [
      '.content-references-list',
      '.reference[id^="CIT"]',
    ],
    // A generic CMS id — any site can have one.
    supporting: ['#articleBody'],
    domain: ['a[href*="bristoluniversitypressdigital.com"]'],
    processor: BristolUPProcessor,
    priority: 5,
    description: 'Bristol University Press Digital (Global Social Challenges Journal et al.)',
  }),

  // Sage - Priority 3
  'sage': defineFormat({
    signature: [],
    // NONE of these is Sage-specific. `[role="doc-noteref"]` is the standard
    // W3C DPUB-ARIA role for a footnote reference — Pandoc and every other
    // conforming generator emits it, so it identifies "this page has footnotes",
    // not "this page is Sage". `.citations`, `.ref` and `[role="listitem"]` fire
    // on a large slice of the web; `[role="listitem"]` is on every Webflow
    // Collection List. Sage is therefore identified by its domain alone.
    supporting: ['a[role="doc-noteref"]', '.citations', '.ref', '[role="listitem"]'],
    domain: ['a[href*="sagepub.com"]'],
    processor: SageProcessor,
    priority: 3,
    description: 'Sage Publications content',
  }),

  // General - Priority 0 (fallback, always matches)
  'general': defineFormat({
    selectors: [], // Empty = matches anything (fallback)
    processor: GeneralProcessor,
    priority: 0,
    description: 'General format (fallback for unrecognized formats)',
  }),
};

/**
 * Get all registered formats sorted by priority (descending)
 * @returns {Array<[string, Object]>} - Array of [formatType, config] tuples
 */
export function getFormatsByPriority(): Array<[string, FormatConfig]> {
  return Object.entries(FORMAT_REGISTRY)
    .sort(([, a], [, b]) => b.priority - a.priority);
}

/**
 * Get format configuration by type
 * @param {string} formatType - Format type identifier
 * @returns {Object|null} - Format configuration or null if not found
 */
export function getFormatConfig(formatType: string): FormatConfig | null {
  return FORMAT_REGISTRY[formatType] || null;
}

/**
 * Register a new format dynamically
 * Useful for plugins or extensions
 *
 * Accepts either the three-strength shape (`signature` / `supporting` / `domain`)
 * or a bare `selectors` array, which is treated as all-signature so existing
 * registrations behave exactly as before.
 *
 * @param {string} formatType - Format type identifier
 * @param {Object} config - Format configuration
 */
export function registerFormat(formatType: string, config: FormatDefinition) {
  if (FORMAT_REGISTRY[formatType]) {
    console.warn(`Format "${formatType}" is already registered, overwriting...`);
  }

  if (!config.processor) {
    throw new Error(`Format config must include a processor class`);
  }

  const hasSelectors = Array.isArray(config.selectors)
    || Array.isArray(config.signature)
    || Array.isArray(config.supporting)
    || Array.isArray(config.domain);
  if (!hasSelectors) {
    throw new Error(`Format config must include selectors array`);
  }

  if (typeof config.priority !== 'number') {
    throw new Error(`Format config must include priority number`);
  }

  FORMAT_REGISTRY[formatType] = defineFormat({
    ...config,
    description: config.description || `Custom format: ${formatType}`,
  });

  console.log(`📚 Registered format: ${formatType} (priority ${config.priority})`);
}
