/**
 * Inline-style stripping that preserves presentational "intensity" custom
 * properties.
 *
 * Editing a contenteditable injects unpredictable inline styles (font-family
 * from execCommand, cursor/styles dragged in via paste, etc.). Rather than try
 * to guess which inline properties are browser junk — an unwinnable game — we
 * strip the whole `style` attribute. The only exceptions are the `*-intensity`
 * custom properties we set ourselves to drive hyperlight / hypercite opacity:
 * those are legitimate presentational state, so we re-apply them after the wipe.
 *
 * Doing this in BOTH the live-DOM strip (divEditor) and the save-time strip
 * (batch.js) keeps the rendered DOM and the persisted content in agreement, so
 * the integrity check doesn't flag a phantom mismatch.
 */

// The only inline style properties worth keeping across a blanket strip.
export const PRESERVED_STYLE_PROPS = ['--highlight-intensity', '--hypercite-intensity'];

/**
 * Remove an element's inline `style` attribute while preserving the intensity
 * custom properties. Mutates the element in place; no-op if it has no style.
 * @param {Element} el
 */
export function stripInlineStylePreservingIntensity(el) {
  if (!el || !el.style || !el.hasAttribute('style')) return;

  const preserved = [];
  for (const prop of PRESERVED_STYLE_PROPS) {
    const val = el.style.getPropertyValue(prop);
    if (val) preserved.push([prop, val]);
  }

  el.removeAttribute('style');

  for (const [prop, val] of preserved) {
    el.style.setProperty(prop, val);
  }
}
