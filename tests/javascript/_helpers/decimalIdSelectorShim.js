/**
 * happy-dom decimal-id selector shim (test-only).
 *
 * The production id generator (utilities/idHelpers.ts) calls isIdInUse(id), which does
 * `document.querySelector('#' + CSS.escape(id))`. For a decimal node/chunk id like "4.1"
 * that selector is `#\34 \.1` (the leading digit must be hex-escaped). Real browsers — and
 * jsdom — parse that valid selector fine; happy-dom's selector parser THROWS on it when no
 * element matches (and is inconsistent when one does). jsdom, meanwhile, ships no `CSS` global
 * at all (so CSS.escape would throw there). happy-dom is the test default and DOES implement
 * getElementById correctly for these ids.
 *
 * So: keep the happy-dom environment, but make querySelector tolerant — on a parse error for a
 * single `#id` selector, recover the id and use getElementById (correct, no parser involved).
 * This lets the REAL generateIdBetween / setElementIds / handleChunkOverflow run unmocked, which
 * is the whole point of the fractional-id tests (mocking the generator is what hid the gap).
 *
 * Install once per test file that drives the real id generator: `installDecimalIdSelectorShim()`.
 */

/** Decode a CSS-escaped identifier fragment (e.g. "\\34 \\.1" → "4.1"). */
function cssUnescape(escaped) {
  return escaped
    // \<hex>{1,6} optionally followed by one whitespace → the code point
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    // \<char> → char (e.g. "\\." → ".")
    .replace(/\\(.)/g, '$1');
}

function tolerantQuerySelector(orig, ctx, selector) {
  try {
    return orig.call(ctx, selector);
  } catch (err) {
    // Only a single `#id` selector. NB: CSS.escape emits a literal space inside hex escapes
    // (e.g. "#\\34 \\.1"), so we can't exclude whitespace here — but a real combinator selector
    // would not have thrown in happy-dom, so reaching this catch means it's the escaped-id case.
    const m = /^#(.+)$/s.exec(selector);
    if (!m) throw err;
    const id = cssUnescape(m[1]);
    const doc = ctx.getElementById ? ctx : ctx.ownerDocument;
    const el = doc && doc.getElementById ? doc.getElementById(id) : null;
    // Element-scoped query must only match descendants of ctx.
    if (el && ctx !== doc && ctx.contains) return ctx.contains(el) ? el : null;
    return el;
  }
}

// Find the prototype in obj's chain that actually OWNS querySelector and wrap it. happy-dom
// defines querySelector on its own Document/Element prototypes (not the bare global
// Document.prototype), so we patch what the live instances really resolve to.
function patchQuerySelectorOn(obj) {
  let proto = obj;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'querySelector')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto || proto.__decimalIdShimInstalled) return;
  const orig = proto.querySelector;
  proto.querySelector = function (selector) {
    return tolerantQuerySelector(orig, this, selector);
  };
  Object.defineProperty(proto, '__decimalIdShimInstalled', { value: true, configurable: true });
}

export function installDecimalIdSelectorShim() {
  patchQuerySelectorOn(document);                       // document.querySelector (isIdInUse)
  patchQuerySelectorOn(document.createElement('div'));  // Element#querySelector (overflow move)
}
