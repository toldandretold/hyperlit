// The AI Citation Review section markup, extracted so both the owner path
// (buildSourceHtml, gated on canEdit) and the commons Research Workflows
// section (any logged-in viewer) render the identical heading + button + a
// one-line description with a "?" about-toggle. Clicking the button opens a
// confirm popup (pricing + rescan) — the same shape as the harvester — instead
// of expanding an inline panel. Wiring is by element id, attached in
// SourceContainerManager.attachInternalListeners wherever the ids appear.
import { getAuthContextSync } from '../../../utilities/auth/session';

const BRAIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>';

export function aiReviewSectionHtml(record: any): string {
  // Always render the same button; when logged out it's dimmed and a click
  // routes to login (like the import flow) instead of the confirm popup.
  const isLoggedIn = getAuthContextSync()?.isLoggedIn;
  const dim = isLoggedIn ? '' : ' opacity: 0.5;';

  return `<div id="ai-review-section" data-lib-timestamp="${record?.timestamp || 0}" style="margin-top: 15px; padding-top: 15px;">
    <h3>AI Citation Review</h3>
    <button type="button" id="ai-review-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;${dim}">
      ${BRAIN_SVG} <span>AI Citation Review</span>
    </button>
    <p style="font-size: 11px; color: var(--color-text-faint); margin-top: 6px;">
      Check every citation against open databases to verify truth claims against available source material.
      <span class="ai-review-info-toggle" tabindex="0" role="button" aria-label="What this does" aria-expanded="false" style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;border:1px solid rgba(239,141,52,0.5);font-size:10px;vertical-align:middle;margin-left:2px;color:var(--hyperlit-orange);">?</span>
    </p>
    <div class="ai-review-info-detail" style="display:none; font-size: 11px; line-height: 1.55; color: var(--color-text-faint); margin-top: 2px; padding: 8px 10px; border-left: 2px solid rgba(239,141,52,0.4); background: rgba(239,141,52,0.05); border-radius: 3px;">
      AI Citation Review compares every citation in this text to open databases, pulls whatever data exists, then checks each citation's claim against the source material. It takes 10–15 minutes and you're emailed when it's done. The results open as a companion <em>AI review</em> book.
    </div>
  </div>`;
}
