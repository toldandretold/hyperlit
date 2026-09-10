// The auto-metadata proposal card: what the wand suggests, shown for
// confirmation before anything is written. Renders into #auto-meta-mount, a slot
// directly beneath the citation block — under the text it offers to change.
//
// NOT a modal: it lives inside #source-container, which ContainerManager already
// focus-traps, so it needs no trap of its own and no overlaySurfacesInventory
// entry. The ids here are deliberately free of the -overlay/-backdrop/-modal/
// -sheet/-menu suffixes the architecture gate scans for; don't rename them into
// one.
import type { FieldProposal, MetadataProposal } from './types';

const FIELD_LABELS: Record<FieldProposal['field'], string> = {
  title: 'Title',
  author: 'Author',
  year: 'Year',
  type: 'Type',
  journal: 'Journal',
  publisher: 'Publisher',
};

const BTN =
  'padding: 6px 12px; font-size: var(--sc-12); color: var(--hyperlit-aqua); border: 1px solid color-mix(in srgb, var(--hyperlit-aqua) 40%, transparent); background: transparent; border-radius: 4px; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px;';
const BTN_MUTED =
  'padding: 6px 12px; font-size: var(--sc-12); color: var(--color-label); border: 1px solid color-mix(in srgb, var(--color-label) 30%, transparent); background: transparent; border-radius: 4px; cursor: pointer; font-family: inherit;';
const LINK_BTN =
  'margin-top: 10px; background: none; border: none; padding: 0; font-size: var(--sc-12); color: var(--color-label); text-decoration: underline; cursor: pointer; font-family: inherit; text-align: left;';

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rowHtml(f: FieldProposal): string {
  const from = f.current
    ? `<span style="text-decoration: line-through; opacity: .55;">${escapeHtml(f.current)}</span> <span aria-hidden="true">→</span> `
    : '';
  // Filling a blank is ticked; replacing something deliberate is offered unticked.
  const checked = f.checked === false ? '' : ' checked';
  return `
    <li class="auto-meta-row" style="margin-bottom: 6px; display: flex; gap: 6px; align-items: baseline;">
      <input type="checkbox"${checked} data-field="${escapeHtml(f.field)}"
             id="auto-meta-check-${escapeHtml(f.field)}" style="margin: 0; flex: none;">
      <label for="auto-meta-check-${escapeHtml(f.field)}" style="cursor: pointer;">
        <span style="color: var(--color-label);">${escapeHtml(FIELD_LABELS[f.field] || f.field)}</span>
        ${from}<strong>${escapeHtml(f.suggested)}</strong>
        <span style="opacity: .6;">· ${escapeHtml(f.provenance)}</span>
      </label>
    </li>`;
}

export interface CardOptions {
  /** Hide the AI escalation entirely (encrypted book — its text can't be sent). */
  aiBlockedReason?: string | null;
  /** BYO key active: the user's own model answers and nothing is charged. */
  byo?: boolean;
}

export function proposalCardHtml(proposal: MetadataProposal, opts: CardOptions = {}): string {
  const hasFields = proposal.fields.length > 0;

  // Rows and notes both render — a note can be useful ALONGSIDE a suggestion
  // (e.g. explaining a heading that was turned down while other fields still
  // have something to offer).
  const rows = hasFields
    ? `<ul style="list-style: none; margin: 0 0 10px; padding: 0; font-size: var(--sc-12);">
         ${proposal.fields.map(rowHtml).join('')}
       </ul>`
    : '';

  const notes = proposal.notes.length
    ? `<ul style="list-style: none; margin: 0 0 10px; padding: 0; font-size: var(--sc-12); color: var(--color-label);">
         ${proposal.notes.map((n) => `<li style="margin-bottom: 4px;">${escapeHtml(n)}</li>`).join('')}
       </ul>`
    : '';

  const body = `${rows}${notes}`;

  const actions = hasFields
    ? `<div style="display: flex; gap: 8px; flex-wrap: wrap;">
         <button type="button" id="auto-meta-apply" style="${BTN}">Apply</button>
         <button type="button" id="auto-meta-cancel" style="${BTN_MUTED}">Cancel</button>
       </div>`
    : `<div style="display: flex; gap: 8px; flex-wrap: wrap;">
         <button type="button" id="auto-meta-cancel" style="${BTN_MUTED}">Close</button>
       </div>`;

  // The AI tier is offered only when it can actually run, and its price is shown
  // before it is pressed — never after.
  let escalate = '';
  if (opts.aiBlockedReason) {
    escalate = `<p style="font-size: var(--sc-12); color: var(--color-label); margin: 10px 0 0; opacity: .8;">${escapeHtml(opts.aiBlockedReason)}</p>`;
  } else if (proposal.tier === 'local') {
    const label = opts.byo
      ? 'Not right? ⟳ Read the text (your own AI · free)'
      : 'Not right? ⟳ Read the text (AI · about $0.001)';
    escalate = `<button type="button" id="auto-meta-escalate" style="${LINK_BTN}">${escapeHtml(label)}</button>`;
  }

  const heading = proposal.tier === 'ai' ? 'Suggested — read from the text' : 'Suggested from the text';

  return `
    <div id="auto-meta-proposal" role="group" aria-labelledby="auto-meta-heading"
         style="margin-top: 10px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--hyperlit-aqua) 25%, transparent); border-radius: 6px;">
      <p id="auto-meta-heading" style="font-size: var(--sc-12); color: var(--color-label); margin: 0 0 8px;">${escapeHtml(heading)}</p>
      ${body}
      ${actions}
      ${escalate}
      <p id="auto-meta-note" aria-live="polite" style="font-size: var(--sc-12); color: var(--color-label); margin: 8px 0 0;"></p>
    </div>`;
}

/**
 * The wand itself — a small glyph that sits INLINE at the end of the citation
 * line, right after "anon, Untitled (2026)." rather than as another labelled
 * button in the action row. It is the citation's own little familiar: it points
 * at the exact text it offers to fix.
 *
 * Always rendered for an owner, never hidden after use — the heading (or any
 * other detail) can change later and the user will want to run it again.
 *
 * `fill="currentColor"` matters: the source SVG ships a hardcoded #000000, which
 * is invisible against the panel's dark glass. It carries the panel's aqua (the
 * same accent as [check source]) rather than the muted label colour — at this
 * size a low-contrast glyph simply could not be made out.
 */
export function autoMetaIconHtml(): string {
  return `<button type="button" id="auto-meta-btn" class="auto-meta-icon"
    title="Fill in the citation details from the text"
    aria-label="Fill in the citation details from the text"
    style="background: none; border: 0; padding: 0 0 0 8px; margin: 0; cursor: pointer; color: var(--hyperlit-aqua); line-height: 1; vertical-align: baseline;"
  ><svg width="18" height="18" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true" focusable="false" style="vertical-align: -3px; pointer-events: none;"><path d="M9.5 9.625l-0.906 2.906-0.875-2.906-2.906-0.906 2.906-0.875 0.875-2.938 0.906 2.938 2.906 0.875zM14.563 8.031l-0.438 1.469-0.5-1.469-1.438-0.469 1.438-0.438 0.5-1.438 0.438 1.438 1.438 0.438zM0.281 24l17.906-17.375c0.125-0.156 0.313-0.25 0.531-0.25 0.281-0.031 0.563 0.063 0.781 0.281 0.094 0.063 0.219 0.188 0.406 0.344 0.344 0.313 0.719 0.688 1 1.063 0.125 0.188 0.188 0.344 0.188 0.5 0.031 0.313-0.063 0.594-0.25 0.781l-17.906 17.438c-0.156 0.156-0.344 0.219-0.563 0.25-0.281 0.031-0.563-0.063-0.781-0.281-0.094-0.094-0.219-0.188-0.406-0.375-0.344-0.281-0.719-0.656-0.969-1.063-0.125-0.188-0.188-0.375-0.219-0.531-0.031-0.313 0.063-0.563 0.281-0.781zM14.656 11.375l1.313 1.344 4.156-4.031-1.313-1.375zM5.938 13.156l-0.406 1.438-0.438-1.438-1.438-0.469 1.438-0.438 0.438-1.469 0.406 1.469 1.5 0.438zM20.5 12.063l0.469 1.469 1.438 0.438-1.438 0.469-0.469 1.438-0.469-1.438-1.438-0.469 1.438-0.438z"/></svg></button>`;
}

/** Where the proposal card renders — an empty slot under the citation block. */
export function proposalMountHtml(): string {
  return '<div id="auto-meta-mount"></div>';
}

export function removeProposal(container: ParentNode = document): void {
  const mount = container.querySelector('#auto-meta-mount');
  if (mount) mount.innerHTML = '';
  else container.querySelector('#auto-meta-proposal')?.remove();
}

export function setProposalNote(container: ParentNode, message: string): void {
  const note = container.querySelector('#auto-meta-note');
  if (note) note.textContent = message;
}

/** Which rows the user left ticked. */
export function checkedFields(container: HTMLElement | Document): Set<string> {
  const boxes = container.querySelectorAll<HTMLInputElement>('#auto-meta-proposal input[type="checkbox"][data-field]');
  const out = new Set<string>();
  boxes.forEach((b) => {
    if (b.checked) out.add(b.getAttribute('data-field') || '');
  });
  return out;
}

export interface CardHandlers {
  onApply: () => void;
  onCancel: () => void;
  onEscalate: () => void;
}

/**
 * Render (or re-render) the card and wire its buttons. Idempotent: any existing
 * card is removed first, so the AI tier can call this with a fresh proposal and
 * there is exactly one render path.
 *
 * The card's own buttons are wired HERE, not in attachInternalListeners — they
 * are created and destroyed with the card, and letting the panel-wide wiring own
 * them would leak a listener on every re-render.
 */
export function renderProposal(
  container: HTMLElement,
  proposal: MetadataProposal,
  opts: CardOptions,
  handlers: CardHandlers,
): HTMLElement | null {
  container.querySelector('#check-source-note')?.remove();

  // The card lives in its own slot directly beneath the citation block, so it
  // appears under the text the wand is offering to change.
  const mount = container.querySelector('#auto-meta-mount');
  if (!mount) return null;
  mount.innerHTML = proposalCardHtml(proposal, opts);

  const card = mount.querySelector('#auto-meta-proposal') as HTMLElement | null;
  if (!card) return null;

  card.querySelector('#auto-meta-apply')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onApply();
  });
  card.querySelector('#auto-meta-cancel')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onCancel();
  });
  card.querySelector('#auto-meta-escalate')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.onEscalate();
  });

  // Escape dismisses the CARD, not the whole panel. Without stopPropagation the
  // container's own Escape handler closes #source-container out from under the
  // user, which reads as the wand having crashed.
  card.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    handlers.onCancel();
  });

  const focusTarget = (card.querySelector('#auto-meta-apply') ||
    card.querySelector('#auto-meta-cancel')) as HTMLElement | null;
  focusTarget?.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest' });

  return card;
}

/** Return focus to the wand after the card goes away. */
export function focusWand(container: HTMLElement): void {
  (container.querySelector('#auto-meta-btn') as HTMLElement | null)?.focus({ preventScroll: true });
}
