// The AI Citation Review section markup, extracted so both the owner path
// (buildSourceHtml, gated on canEdit) and the commons Research Workflows
// section (any logged-in viewer) render the identical button + info panel.
// Wiring is by element id (#ai-review-btn / #ai-review-generate), attached in
// SourceContainerManager.attachInternalListeners wherever the ids appear.
import { getAuthContextSync } from '../../../utilities/auth/session';

export function aiReviewSectionHtml(record: any): string {
  const authCtx = getAuthContextSync();
  const isLoggedIn = authCtx?.isLoggedIn;
  const isPremium = authCtx?.user?.status === 'premium';

  const brainSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>';

  let btnHtml = '';
  if (!isLoggedIn) {
    btnHtml = `
      <button type="button" id="ai-review-btn" disabled style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--color-label); border: 1px solid rgba(136,136,136,0.4); background: transparent; border-radius: 4px; cursor: not-allowed; display: flex; align-items: center; justify-content: center; gap: 6px; opacity: 0.6;">
        ${brainSvg}
        AI Citation Review
      </button>
      <p style="font-size: 11px; color: var(--color-text-faint); margin-top: 6px;">Must be logged in.</p>`;
  } else {
    btnHtml = `
      <button type="button" id="ai-review-btn" style="width: 100%; padding: 8px 12px; font-size: 13px; color: var(--hyperlit-orange); border: 1px solid rgba(239,141,52,0.4); background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
        ${brainSvg}
        AI Citation Review
      </button>
      <div id="ai-review-info" style="display: none; margin-top: 10px;">
        <p style="font-size: 12px; color: var(--color-text-secondary); margin: 0 0 10px 0; line-height: 1.5;">AI Citation Review compares all citations in this text to open databases, pulling any available data. It then compares the truth claim of each citation to the source material. The review takes 10-15 minutes. You will be emailed on completion.</p>
        <p style="font-size: 12px; color: var(--color-text-secondary); margin: 0 0 10px 0;">${isPremium
          ? 'Cost: <strong>Included with Premium</strong>'
          : `Estimated cost: <strong>around $1.00</strong> <span style="opacity:0.7">(varies by book length)</span> <span class="ai-review-cost-info-toggle" tabindex="0" role="button" aria-label="Pricing info" style="cursor:pointer;display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;border:1px solid rgba(239,141,52,0.5);font-size:10px;vertical-align:middle;margin-left:4px;">?</span><span class="ai-review-cost-info-detail" style="display:none;"> AI Citation Review uses OCR and multiple LLMs to verify each citation. Cost depends on the number of citations and source length. For no markup, <a href="https://github.com/toldandretold/hyperlit" target="_blank" style="color:inherit;text-decoration:underline;">clone Hyperlit from GitHub</a> (it's free software) and use your own API keys.</span>`
        }</p>
        <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-text-secondary); margin-bottom: 10px; cursor: pointer;">
          <input type="checkbox" id="ai-review-force" style="accent-color: var(--hyperlit-orange);" />
          Rescan all sources from scratch
        </label>
        <button type="button" id="ai-review-generate" style="width: 100%; padding: 8px 12px; font-size: 13px; color: #221F20; background: var(--hyperlit-orange); border: none; border-radius: 4px; cursor: pointer; font-family: inherit;">Generate Review</button>
      </div>`;
  }

  return `<div id="ai-review-section" data-lib-timestamp="${record?.timestamp || 0}" style="margin-top: 15px; padding-top: 15px;">
    <h3>AI Citation Review</h3>
    ${btnHtml}
  </div>`;
}
