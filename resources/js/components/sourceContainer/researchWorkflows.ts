// "Research Workflows" — a collapsible source-container section, shown on
// owner-less COMMONS books (auto-harvested system texts) to any logged-in
// viewer. It surfaces the same AI Citation Review + Harvest features that a
// book's owner gets in their own tools, on the "requester-pays, everyone
// benefits" model (like the audiobook feature): whoever runs it pays for their
// run, and the resulting canonical source texts benefit every reader.
//
// Wiring reuses the existing id-based handlers: the AI-review elements
// (#ai-review-*) are attached by SourceContainerManager.attachInternalListeners
// wherever they appear; the harvest section is built lazily by loadHarvestSection
// on first expand (mirrors Creator Tools).
import { aiReviewSectionHtml } from './aiReview/section';
import { getAuthContextSync } from '../../utilities/auth/session';

// Keep in sync with App\Services\CanonicalVersions\AutoVersionResolver.
const SYSTEM_CREATOR = 'canonicalizer_v1';
const SYSTEM_CONVERSION_METHODS = ['pdf_ocr_auto_raw', 'jats_fulltext', 'paste_engine_html', 'ar5iv_html'];

/** A commons book = an owner-less, system-created auto-version of a canonical work. */
export function isCommonsBook(record: any): boolean {
  if (!record) return false;
  if (record.creator === SYSTEM_CREATOR) return true;
  return SYSTEM_CONVERSION_METHODS.includes(record.conversion_method);
}

/**
 * The Research Workflows section HTML — only for commons books. A plain heading
 * (like the other source-container sections), not a dropdown. Logged-in viewers
 * get the AI-review + harvest tools; guests get a log-in prompt. Returns '' for
 * non-commons books (owners keep their normal tools).
 */
export function researchWorkflowsSectionHtml(record: any): string {
  if (!isCommonsBook(record)) return '';

  const isLoggedIn = getAuthContextSync()?.isLoggedIn;

  const inner = isLoggedIn
    ? `${aiReviewSectionHtml(record)}
       <div id="harvest-network-section" style="margin-top: 15px;"></div>`
    : `<p style="font-size: 12px; color: var(--color-text-faint); margin: 6px 0 0;">Log in to run these on this commons text.</p>`;

  return `<div id="research-workflows-section" style="margin-top: 15px; padding-top: 15px;">
    <h3>Research Workflows</h3>
    <p style="font-size: 11px; color: var(--color-text-faint); margin: 0 0 6px; line-height: 1.5;">This is an open-access commons text — nobody owns it. Anyone can enrich it; the results benefit every reader, and you only pay for works not already fetched.</p>
    ${inner}
  </div>`;
}

/** Build the harvest button + report link (the AI-review elements are wired by id). */
export function loadResearchWorkflows(self: any): void {
  if (self._researchWorkflowsLoaded) return;
  if (!self.container.querySelector('#harvest-network-section')) return; // guest / not commons
  self._researchWorkflowsLoaded = true;
  self.loadHarvestSection();
}
