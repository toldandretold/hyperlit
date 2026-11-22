/**
 * Code-block decoration stripper — ZERO-IMPORT LEAF.
 *
 * Syntax colouring and the header bar are RENDER-TIME ONLY. They must never
 * reach IndexedDB / Postgres: spans in stored content fragment text for every
 * downstream consumer (TOC, TTS, search — see the "no spans in the DB" rule),
 * and the header's buttons are UI, not content. The save path
 * (indexedDB/nodes/contentProcessor.ts) calls {@link stripCodeDecoration} on its
 * clone; codeBlocks/highlight.ts uses the same constants when it decorates, so
 * the two sides can never disagree about what is decoration.
 *
 * Kept import-free because contentProcessor sits under indexedDB/, where the
 * circular-import TDZ class has bitten before.
 */

/** Marks a token span we inserted. */
export const CODE_TOKEN_ATTR = 'data-code-tok';
/** Marks any element that exists only at render time (the header bar). */
export const RENDER_ONLY_ATTR = 'data-render-only';
/** Render-time state attributes stamped on a decorated <pre>. */
export const CODE_STATE_ATTRS = ['data-code-decorated', 'data-code-label', 'data-code-detected'] as const;
/** Render-time class tokens (hljs's own root class, our state classes). */
export const CODE_STATE_CLASSES = ['hljs', 'code-decorated', 'code-wrapped-off'] as const;

/** A span is a highlighter token if every class it carries is an hljs scope. */
function isHljsTokenSpan(span: Element): boolean {
  if (span.attributes.length === 0) return false;
  // Only `class` allowed — a span with an id/data attr is something else.
  for (const attr of Array.from(span.attributes)) {
    if (attr.name !== 'class') return false;
  }
  const classes = Array.from(span.classList);
  if (classes.length === 0) return false;
  return classes.every((c) => c.startsWith('hljs-') || /^[a-z]+_$/.test(c));
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/**
 * Remove every trace of code-block decoration from `root` (inclusive). Also
 * unwraps hljs token spans that arrived from OUTSIDE (pasting already-
 * highlighted HTML from a docs site), so they never persist either.
 * Returns true if anything was removed.
 */
export function stripCodeDecoration(root: Element): boolean {
  let changed = false;

  root.querySelectorAll(`[${RENDER_ONLY_ATTR}]`).forEach((el) => {
    el.remove();
    changed = true;
  });

  const pres: Element[] = root.tagName === 'PRE' ? [root] : [];
  root.querySelectorAll('pre').forEach((p) => pres.push(p));

  // Our own tokens anywhere (a stray one outside a <pre> is still ours).
  root.querySelectorAll(`span[${CODE_TOKEN_ATTR}]`).forEach((span) => {
    unwrap(span);
    changed = true;
  });

  for (const pre of pres) {
    // Foreign hljs spans inside code blocks only — outside a <pre>, a span with
    // an `hljs-*` class is not ours to judge.
    pre.querySelectorAll('span').forEach((span) => {
      if (isHljsTokenSpan(span)) {
        unwrap(span);
        changed = true;
      }
    });
    const targets: Element[] = [pre, ...Array.from(pre.querySelectorAll('code'))];
    for (const el of targets) {
      for (const attr of CODE_STATE_ATTRS) {
        if (el.hasAttribute(attr)) {
          el.removeAttribute(attr);
          changed = true;
        }
      }
      for (const cls of CODE_STATE_CLASSES) {
        if (el.classList.contains(cls)) {
          el.classList.remove(cls);
          changed = true;
        }
      }
      if (el.getAttribute('class') === '') el.removeAttribute('class');
    }
    if (changed) pre.normalize();
  }

  return changed;
}
