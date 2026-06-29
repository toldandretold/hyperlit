// renderSourceMatchPrompt — the container-agnostic "Is this the source?" card. Mounts into any
// element and wires Yes/No, so both the source panel and (later) the post-conversion toast reuse it.
import type { SourceCandidate } from './types';

export interface MatchPromptHandlers {
  onYes: () => void;
  onNo: () => void;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A one-line human citation for a candidate: "Title — Author, Year, Journal/Publisher". */
export function formatCandidateCitation(c: SourceCandidate): string {
  const title = (c.title ?? '').toString().trim();
  const meta = [c.author, c.year, c.journal || c.publisher]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(', ');
  if (title && meta) return `${title} — ${meta}`;
  return title || meta || 'Unknown source';
}

export function renderSourceMatchPrompt(
  mount: HTMLElement,
  candidate: SourceCandidate,
  handlers: MatchPromptHandlers,
  score?: number | null,
): void {
  const confidence = typeof score === 'number' ? ` <span style="opacity:0.7;">(${Math.round(score * 100)}% match)</span>` : '';

  mount.innerHTML = `
    <div class="source-match-prompt" style="margin-top: 10px; padding: 10px; border: 1px solid var(--border-subtle); border-radius: 6px;">
      <p style="font-size: 12px; color: var(--color-label); margin: 0 0 6px 0;">Is this the source?</p>
      <p class="source-match-citation" style="font-size: 13px; color: var(--color-text-secondary); margin: 0 0 10px 0; line-height: 1.4;">${escapeHtml(formatCandidateCitation(candidate))}${confidence}</p>
      <div style="display: flex; gap: 8px;">
        <button type="button" class="source-match-yes" style="flex: 1; padding: 6px 10px; font-size: 12px; color: #221F20; background: var(--hyperlit-aqua); border: none; border-radius: 4px; cursor: pointer; font-family: inherit;">Yes, that's it</button>
        <button type="button" class="source-match-no" style="flex: 0 0 auto; padding: 6px 12px; font-size: 12px; color: var(--color-label); background: transparent; border: 1px solid var(--border-subtle); border-radius: 4px; cursor: pointer; font-family: inherit;">No</button>
      </div>
    </div>`;

  mount.querySelector('.source-match-yes')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onYes();
  });
  mount.querySelector('.source-match-no')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onNo();
  });
}
