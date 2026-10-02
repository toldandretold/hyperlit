// @vitest-environment jsdom
/**
 * The external-translation accessor: its detection matrix, its stickiness, and —
 * most importantly — what it must NOT fire on.
 *
 * This latch drives user-visible refusals (edit mode, annotations) and suspends
 * chunk windowing, so a false positive is expensive: it disables editing for the
 * rest of the session. That is why detection is deliberately narrow and only
 * carries signals a translator cannot be absent for. The breadth lives in
 * `integrity/canonicalText.domMatchesStored`, which refuses a read-mode write on
 * any text drift and so covers translators leaving no marker at all (Safari).
 *
 * The `<font>` regression is pinned below: a `<font>`-wrapper sniff was tried and
 * removed, because `execCommand` emits `<font>` during ordinary editing and old
 * pasted content carries it — which is exactly why `contentProcessor` unwraps
 * them on save. It made 4 characterization tests fail by latching mid-suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isExternallyTranslated,
  externalTranslationEvidence,
  markExternallyTranslated,
  startExternalTranslationWatch,
} from '../../../resources/js/utilities/externalTranslation';

function reset() {
  document.documentElement.className = '';
  document.body.innerHTML = '';
  delete window.__hyperlitExternalTranslation;
}

describe('externalTranslation accessor', () => {
  beforeEach(reset);
  afterEach(reset);

  it('is negative on an ordinary untranslated page', () => {
    document.body.innerHTML = '<div class="main-content"><div class="chunk"><p>Hello</p></div></div>';
    expect(isExternallyTranslated()).toBe(false);
    expect(externalTranslationEvidence()).toBe('none');
  });

  it('detects Chrome/Google via the <html> class, in both directions', () => {
    document.documentElement.classList.add('translated-ltr');
    expect(isExternallyTranslated()).toBe(true);
    expect(externalTranslationEvidence()).toBe('html-class');

    reset();
    document.documentElement.classList.add('translated-rtl');
    expect(isExternallyTranslated()).toBe(true);
  });

  it('detects Edge/Microsoft via the content-hash attributes', () => {
    document.body.innerHTML = '<div class="main-content"><p _msttexthash="123">Hallo</p></div>';
    expect(isExternallyTranslated()).toBe(true);
    expect(externalTranslationEvidence()).toBe('ms-attrs');
  });

  it('does NOT fire on a <font> wrapper in rendered content', () => {
    // execCommand emits <font> during ordinary editing, and legacy pasted
    // content carries it. Latching here disabled editing for a whole session.
    document.body.innerHTML =
      '<div class="main-content"><div class="chunk">'
      + '<p id="100"><font style="vertical-align: inherit;">Edited text</font></p>'
      + '</div></div>';
    expect(isExternallyTranslated()).toBe(false);
  });

  it('LATCHES: stays true after the marker is removed again', () => {
    // "Show original" is not guaranteed to restore byte-identical DOM, and any
    // chunk appended while translation was on arrived translated — so the page
    // is in a mixed state and only a reload can clear it.
    document.documentElement.classList.add('translated-ltr');
    expect(isExternallyTranslated()).toBe(true);

    document.documentElement.classList.remove('translated-ltr');
    expect(isExternallyTranslated()).toBe(true);
    expect(externalTranslationEvidence()).toBe('html-class');
  });

  it('markExternallyTranslated is idempotent, one-way, and ignores "none"', () => {
    markExternallyTranslated('none');
    expect(isExternallyTranslated()).toBe(false);

    markExternallyTranslated('ms-attrs');
    expect(externalTranslationEvidence()).toBe('ms-attrs');

    // First evidence wins — a later signal must not overwrite the diagnosis.
    markExternallyTranslated('html-class');
    expect(externalTranslationEvidence()).toBe('ms-attrs');
  });

  it('marks the root element and fires its event exactly once', () => {
    let fired = 0;
    const onEvent = () => { fired += 1; };
    window.addEventListener('hyperlit:external-translation', onEvent);
    try {
      markExternallyTranslated('html-class');
      markExternallyTranslated('html-class');
      expect(fired).toBe(1);
      // CSS hook, so a translated page can be styled without asking JS.
      expect(document.documentElement.classList.contains('hl-externally-translated')).toBe(true);
    } finally {
      window.removeEventListener('hyperlit:external-translation', onEvent);
    }
  });

  it('startExternalTranslationWatch latches immediately when already translated', () => {
    // Chrome's "always translate this language" setting translates BEFORE our
    // scripts run, so the watch must probe on start rather than only on change.
    document.documentElement.classList.add('translated-ltr');
    startExternalTranslationWatch();
    expect(isExternallyTranslated()).toBe(true);
  });

  it('startExternalTranslationWatch is idempotent', () => {
    startExternalTranslationWatch();
    startExternalTranslationWatch();
    expect(isExternallyTranslated()).toBe(false);
  });
});
