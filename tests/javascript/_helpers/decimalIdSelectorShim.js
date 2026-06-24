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

// True when `selector` targets a SINGLE escaped id (e.g. "#\\31 " for id "1", "#\\34 \\.1" for
// "4.1") — i.e. once unescaped it is `#<id>` with no combinators. happy-dom mishandles these BOTH
// by throwing (no match) AND by returning wrong results (a match), so we pre-empt rather than rely
// on a try/catch — and only for this shape, leaving real combinator selectors to the engine.
function singleEscapedId(selector) {
  if (typeof selector !== 'string' || selector[0] !== '#') return null;
  const unescaped = cssUnescape(selector);
  return /^#[^\s>+~,]+$/.test(unescaped) ? unescaped.slice(1) : null;
}

function tolerantQuerySelector(orig, ctx, selector) {
  const id = singleEscapedId(selector);
  if (id === null) return orig.call(ctx, selector);
  const doc = ctx.getElementById ? ctx : ctx.ownerDocument;
  const el = doc && doc.getElementById ? doc.getElementById(id) : null;
  // Element-scoped query must only match descendants of ctx.
  if (el && ctx !== doc && ctx.contains) return ctx.contains(el) ? el : null;
  return el;
}

// querySelectorAll twin for isDuplicateId(id) = `querySelectorAll('#'+CSS.escape(id)).length > 1`.
// The escaped-id selector (incl. an INTEGER id like "1" → "#\31 ") trips happy-dom the same way.
// We can't recover via getElementById here — it returns at most ONE element, so it could never
// surface a DUPLICATE. Instead scan all elements (the `*` selector never needs escaping) and
// filter by `.id`, returning EVERY match so the count is correct.
function tolerantQuerySelectorAll(orig, ctx, selector) {
  const id = singleEscapedId(selector);
  if (id === null) return orig.call(ctx, selector);
  const root = ctx.ownerDocument || (ctx.getElementById ? ctx : document);
  const all = Array.from(root.querySelectorAll('*')).filter((e) => e.id === id);
  // Element-scoped query must only match descendants of ctx.
  return (ctx !== root && ctx.contains) ? all.filter((e) => ctx.contains(e)) : all;
}

// Find the prototype in obj's chain that actually OWNS the method and wrap it. happy-dom
// defines these on its own Document/Element prototypes (not the bare global Document.prototype),
// so we patch what the live instances really resolve to.
function patchMethodOn(obj, method, tolerant) {
  let proto = obj;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, method)) {
    proto = Object.getPrototypeOf(proto);
  }
  const flag = `__decimalIdShim_${method}`;
  if (!proto || proto[flag]) return;
  const orig = proto[method];
  proto[method] = function (selector) {
    return tolerant(orig, this, selector);
  };
  Object.defineProperty(proto, flag, { value: true, configurable: true });
}

export function installDecimalIdSelectorShim() {
  patchMethodOn(document, 'querySelector', tolerantQuerySelector);                       // isIdInUse
  patchMethodOn(document.createElement('div'), 'querySelector', tolerantQuerySelector);  // overflow move
  patchMethodOn(document, 'querySelectorAll', tolerantQuerySelectorAll);                       // isDuplicateId
  patchMethodOn(document.createElement('div'), 'querySelectorAll', tolerantQuerySelectorAll);  // scoped count
}
