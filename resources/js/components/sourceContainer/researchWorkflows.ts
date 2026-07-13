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
 * The Research Workflows section HTML — only for commons books. A collapsible
 * heading (styled like the standard source-container headings, with a chevron),
 * open by default. Logged-in viewers get the AI-review + harvest tools, each
 * under its own heading; guests get a log-in prompt. Returns '' for non-commons
 * books (owners keep their normal tools).
 */
export function researchWorkflowsSectionHtml(record: any, canEdit = false): string {
  const commons = isCommonsBook(record);
  // Shown to the book's owner (their own book) OR any viewer of a commons book.
  if (!commons && !canEdit) return '';

  const isLoggedIn = getAuthContextSync()?.isLoggedIn;

  // Always render both tools (each under its own heading). When logged out the
  // buttons render dimmed and a click routes to login — the same behaviour as
  // trying to import a PDF while anonymous.
  const loginHint = isLoggedIn ? '' :
    `<p style="font-size: var(--sc-12); color: var(--color-text-faint); margin: 6px 0 0;">Log in to run these on this commons text.</p>`;
  const inner = `${aiReviewSectionHtml(record)}
       <h3 style="margin-top: 15px;">Knowledge Commons Harvester</h3>
       <div id="harvest-network-section"></div>
       ${loginHint}`;

  // Intro reflects the two contexts. Commons: anyone can enrich it. Owned book:
  // the owner enriches their own text (results still benefit every reader).
  const intro = commons
    ? 'These tools use AI-integrated data pipelines to certify and import sources. They rely on external services, so are not free. But because this open-access book is part of the digital commons, the results are cumulative and benefit everyone. Please report any issues to fml@hyperlit.io'
    : 'These tools use AI-integrated data pipelines to certify and import sources. They rely on external services, so are not free.';

  return `<div id="research-workflows-section" style="margin-top: 15px; padding-top: 15px;">
    <button type="button" id="research-workflows-toggle" aria-expanded="false">
      <span>Research Workflows</span>
      <svg class="research-workflows-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>
    <div id="research-workflows-content" style="display: none;">
      <p style="font-size: var(--sc-11); color: var(--color-text-faint); margin: 0 0 6px; line-height: 1.5;">${intro}</p>
      ${inner}
    </div>
  </div>`;
}

/** Build the harvest button + report link (the AI-review elements are wired by id). */
export function loadResearchWorkflows(self: any): void {
  if (self._researchWorkflowsLoaded) return;
  if (!self.container.querySelector('#harvest-network-section')) return; // guest / not commons
  self._researchWorkflowsLoaded = true;
  self.loadHarvestSection();
}
