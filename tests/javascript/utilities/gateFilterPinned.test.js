/**
 * gateFilter.ts — the pinned-hypercite deep-link exemption + hypercite gate parity +
 * the conservative singles mirror. These are the CLIENT half of the server-side
 * singles/pinned filtering (DatabaseToIndexedDBController::getHypercites, pinned via
 * tests/Feature/Api/HyperciteGateParityTest.php):
 *   - pinHypercite: shape-validated, sessionStorage-persisted, FIFO-capped at 20
 *   - applyGateFilter: pinned ids always pass (incl. hideAll); foreign singles
 *     (is_user_hypercite === false EXPLICITLY) are dropped in every mode; undefined
 *     ownership is KEPT (local/legacy records must never vanish on their creator)
 *   - global default now hides AI hypercites (parity with hyperlights)
 *   - appendGateParam emits pinned= independently of a stored gate setting
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fresh module state per test — the pinned set is cached at module level.
async function freshGateFilter() {
  vi.resetModules();
  return import('../../../resources/js/components/utilities/gateFilter');
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const single = (over = {}) => ({
  hyperciteId: 'hypercite_s1', relationshipStatus: 'single', citedIN: [],
  creator: 'someone', is_user_hypercite: false, ...over,
});
const couple = (over = {}) => ({
  hyperciteId: 'hypercite_c1', relationshipStatus: 'couple', citedIN: ['/x#hypercite_y'],
  creator: 'someone', is_user_hypercite: false, ...over,
});

describe('pinned set semantics', () => {
  it('pins, persists to sessionStorage, and round-trips through a module reload', async () => {
    let gf = await freshGateFilter();
    gf.pinHypercite('hypercite_abc123');
    expect(gf.getPinnedHyperciteIds()).toEqual(['hypercite_abc123']);
    expect(JSON.parse(sessionStorage.getItem('hyperlit_pinned_hypercites'))).toEqual(['hypercite_abc123']);

    // New module instance (fresh page / different chunk) rehydrates from sessionStorage
    gf = await freshGateFilter();
    expect(gf.getPinnedHyperciteIds()).toEqual(['hypercite_abc123']);
  });

  it('rejects ids that do not match the hypercite shape', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('HL_notacite');
    gf.pinHypercite('hypercite_bad!chars');
    gf.pinHypercite('');
    expect(gf.getPinnedHyperciteIds()).toEqual([]);
  });

  it('clearPinnedHypercites wipes the set + sessionStorage (gate Apply outranks pins)', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_deep1');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll' }));
    // Pinned survives hideAll…
    expect(gf.applyGateFilter([couple({ hyperciteId: 'hypercite_deep1' })], 'hypercite')).toHaveLength(1);
    // …until the user applies gate settings, which clears pins: hideAll now really hides all
    gf.clearPinnedHypercites();
    expect(gf.getPinnedHyperciteIds()).toEqual([]);
    expect(sessionStorage.getItem('hyperlit_pinned_hypercites')).toBeNull();
    expect(gf.applyGateFilter([couple({ hyperciteId: 'hypercite_deep1' })], 'hypercite')).toHaveLength(0);
    expect(gf.appendGateParam('/api/x')).not.toContain('pinned=');
  });

  it('FIFO-caps at 20 and re-pinning moves an id to the freshest slot', async () => {
    const gf = await freshGateFilter();
    for (let i = 1; i <= 20; i++) gf.pinHypercite(`hypercite_n${i}`);
    gf.pinHypercite('hypercite_n1'); // re-pin → freshest
    gf.pinHypercite('hypercite_new'); // evicts the OLDEST (n2), not n1
    const pinned = gf.getPinnedHyperciteIds();
    expect(pinned).toHaveLength(20);
    expect(pinned).toContain('hypercite_n1');
    expect(pinned).toContain('hypercite_new');
    expect(pinned).not.toContain('hypercite_n2');
  });
});

describe('applyGateFilter: singles mirror', () => {
  it('drops a foreign single (is_user_hypercite === false) in every mode', async () => {
    const gf = await freshGateFilter();
    for (const mode of ['default', 'all', 'custom']) {
      localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode, custom: {} }));
      const out = gf.applyGateFilter([single(), couple()], 'hypercite');
      expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_c1']);
    }
  });

  it('KEEPS the user\'s own single and KEEPS undefined ownership (local/legacy records)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const own = single({ hyperciteId: 'hypercite_own', is_user_hypercite: true });
    const legacy = single({ hyperciteId: 'hypercite_legacy', is_user_hypercite: undefined });
    const out = gf.applyGateFilter([own, legacy], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_own', 'hypercite_legacy']);
  });

  it('a PINNED foreign single passes (deep-link target must render)', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_s1');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const out = gf.applyGateFilter([single()], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_s1']);
  });
});

describe('applyGateFilter: pinned bypass of gate modes', () => {
  it('hideAll keeps only own + pinned hypercites', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_c1');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll' }));
    const own = couple({ hyperciteId: 'hypercite_mine', is_user_hypercite: true });
    const foreign = couple({ hyperciteId: 'hypercite_other' });
    const out = gf.applyGateFilter([own, couple(), foreign], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_mine', 'hypercite_c1']);
  });

  it('custom hideAI drops AI hypercites but keeps a pinned AI one', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_aipinned');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'custom', custom: { hideAI: true } }));
    const ai = couple({ hyperciteId: 'hypercite_ai', creator: 'AIreview:gpt' });
    const aiPinned = couple({ hyperciteId: 'hypercite_aipinned', creator: 'AIreview:gpt' });
    const out = gf.applyGateFilter([ai, aiPinned, couple()], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_aipinned', 'hypercite_c1']);
  });
});

describe('applyGateFilter: global-default parity (per-type defaults)', () => {
  it('global default hides AI hypercites (parity with hyperlights) but keeps normal couples', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const ai = couple({ hyperciteId: 'hypercite_ai', creator: 'AIreview:gpt' });
    const out = gf.applyGateFilter([ai, couple()], 'hypercite');
    expect(out.map((h) => h.hyperciteId)).toEqual(['hypercite_c1']);
  });

  it('global default hides AIarchivist hypercites (the Archivist ≠ AIreview: prefix)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const archivist = couple({ hyperciteId: 'hypercite_arch', creator: 'AIarchivist' });
    expect(gf.applyGateFilter([archivist], 'hypercite')).toHaveLength(0);
    // …but a server-flagged co-author copy (is_user_hypercite true) always passes
    const mine = couple({ hyperciteId: 'hypercite_arch2', creator: 'AIarchivist', is_user_hypercite: true });
    expect(gf.applyGateFilter([mine], 'hypercite')).toHaveLength(1);
  });

  it('global default hides ANONYMOUS hypercites but NOT anonymous hyperlights', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const anonCite = couple({ hyperciteId: 'hypercite_anon', creator: null });
    expect(gf.applyGateFilter([anonCite], 'hypercite')).toHaveLength(0);
    // Anonymous hyperlight WITH an annotation survives the default (hideAnonymous is
    // hypercite-only in the global default; the HL default is hideAI + hideNoAnnotation)
    const anonHl = { highlightID: 'HL_anon', creator: null, annotation: 'a real note', is_user_highlight: false };
    expect(gf.applyGateFilter([anonHl], 'hyperlight')).toHaveLength(1);
  });

  it('the empty-annotation default check stays hyperlight-only (hypercites have no annotation)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    // A couple with no annotation field must NOT be dropped by the hideNoAnnotation default
    const out = gf.applyGateFilter([couple()], 'hypercite');
    expect(out).toHaveLength(1);
  });
});

describe('applyGateFilter: nested per-type custom shape', () => {
  it('applies flags independently per type (hyperlight flags never bleed into hypercites)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({
      mode: 'custom',
      custom: { hyperlight: { hideAI: true }, hypercite: { hideAI: false } },
    }));
    const aiCite = couple({ hyperciteId: 'hypercite_ai', creator: 'AIreview:gpt' });
    expect(gf.applyGateFilter([aiCite], 'hypercite')).toHaveLength(1); // hypercite col says keep
    const aiHl = { highlightID: 'HL_ai', creator: 'AIreview:gpt', annotation: 'x', is_user_highlight: false };
    expect(gf.applyGateFilter([aiHl], 'hyperlight')).toHaveLength(0); // hyperlight col says hide
  });

  it('legacy FLAT custom shape still applies to both types', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({
      mode: 'custom',
      custom: { hideAnonymous: true },
    }));
    const anonCite = couple({ hyperciteId: 'hypercite_anon', creator: null });
    const anonHl = { highlightID: 'HL_anon', creator: null, annotation: 'x', is_user_highlight: false };
    expect(gf.applyGateFilter([anonCite], 'hypercite')).toHaveLength(0);
    expect(gf.applyGateFilter([anonHl], 'hyperlight')).toHaveLength(0);
  });
});

describe('pinned hyperlights (deep-link #HL_ exemption, mirror of hypercites)', () => {
  const aiHl = (over = {}) => ({
    hyperlight_id: 'HL_ai1', creator: 'AIreview:gpt', annotation: '',
    is_user_highlight: false, ...over,
  });

  it('pins, persists under its own sessionStorage key, and rejects wrong shapes', async () => {
    let gf = await freshGateFilter();
    gf.pinHyperlight('HL_123abc');
    gf.pinHyperlight('hypercite_notahl');
    gf.pinHyperlight('HL_bad!chars');
    expect(gf.getPinnedHyperlightIds()).toEqual(['HL_123abc']);
    expect(JSON.parse(sessionStorage.getItem('hyperlit_pinned_hyperlights'))).toEqual(['HL_123abc']);
    // Fresh module instance rehydrates
    gf = await freshGateFilter();
    expect(gf.getPinnedHyperlightIds()).toEqual(['HL_123abc']);
  });

  it('a pinned AI hyperlight passes the default gate (AI + empty-annotation would hide it)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    expect(gf.applyGateFilter([aiHl()], 'hyperlight')).toHaveLength(0); // gated without the pin
    gf.pinHyperlight('HL_ai1');
    expect(gf.applyGateFilter([aiHl()], 'hyperlight')).toHaveLength(1); // pinned → passes
  });

  it('hideAll keeps only own + pinned hyperlights', async () => {
    const gf = await freshGateFilter();
    gf.pinHyperlight('HL_pinned1');
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll' }));
    const own = aiHl({ hyperlight_id: 'HL_mine', is_user_highlight: true });
    const pinned = aiHl({ hyperlight_id: 'HL_pinned1' });
    const foreign = aiHl({ hyperlight_id: 'HL_other' });
    const out = gf.applyGateFilter([own, pinned, foreign], 'hyperlight');
    expect(out.map((h) => h.hyperlight_id)).toEqual(['HL_mine', 'HL_pinned1']);
  });

  it('clearPinnedHypercites clears hyperlight pins too (gate Apply outranks all pins)', async () => {
    const gf = await freshGateFilter();
    gf.pinHyperlight('HL_deep1');
    gf.clearPinnedHypercites();
    expect(gf.getPinnedHyperlightIds()).toEqual([]);
    expect(sessionStorage.getItem('hyperlit_pinned_hyperlights')).toBeNull();
  });

  it('appendGateParam emits pinned_hl= independently of a stored gate setting', async () => {
    const gf = await freshGateFilter();
    gf.pinHyperlight('HL_deep1');
    expect(gf.appendGateParam('/api/x')).toBe(`/api/x?pinned_hl=${encodeURIComponent('HL_deep1')}`);
  });
});

describe('book-level gate defaults (keyed per book)', () => {
  const showAiDefaults = {
    hyperlight: { hideAI: false, hideAnonymous: false, hideNoAnnotation: false },
    hypercite: { hideAI: true, hideAnonymous: true, hideNoAnnotation: false },
  };
  const aiHlIn = (book, over = {}) => ({
    hyperlight_id: 'HL_ai1', book, creator: 'AIreview:gpt', annotation: 'note',
    is_user_highlight: false, ...over,
  });

  it('default mode uses the item book\'s saved defaults (creator unchecked hideAI → AI highlights show)', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    gf.setBookGateDefaults('bookA', showAiDefaults);
    expect(gf.applyGateFilter([aiHlIn('bookA')], 'hyperlight')).toHaveLength(1); // book default wins
    expect(gf.applyGateFilter([aiHlIn('bookB')], 'hyperlight')).toHaveLength(0); // other book → global default
  });

  it('a sub-book resolves through its parent\'s defaults; setting a sub-book row never clobbers the parent', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    gf.setBookGateDefaults('bookA', showAiDefaults);
    gf.setBookGateDefaults('bookA/Fn2', null); // sub-book library row has no gate_defaults
    expect(gf.getBookGateDefaults('bookA/Fn2')).toEqual(showAiDefaults); // falls back to parent
    expect(gf.getBookGateDefaults('bookA')).toEqual(showAiDefaults);     // parent untouched
    expect(gf.applyGateFilter([aiHlIn('bookA/Fn2')], 'hyperlight')).toHaveLength(1);
  });

  it('gateQueryParam attaches bookDefaults in default mode — even with NO stored gate setting', async () => {
    const gf = await freshGateFilter();
    document.body.innerHTML = '<div class="main-content" id="bookA"></div>';
    gf.setBookGateDefaults('bookA', showAiDefaults);
    // No localStorage gate: previously returned '' and the server raced the async
    // library save — now the just-saved defaults ride the fetch explicitly.
    const noStored = decodeURIComponent(gf.gateQueryParam());
    expect(JSON.parse(noStored.replace(/^gate=/, ''))).toEqual({ mode: 'default', bookDefaults: showAiDefaults });
    // With a stored default-mode setting they ride too
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'default', custom: {} }));
    const stored = decodeURIComponent(gf.gateQueryParam('bookA'));
    expect(JSON.parse(stored.replace(/^gate=/, '')).bookDefaults).toEqual(showAiDefaults);
    document.body.innerHTML = '';
  });
});

describe('appendGateParam', () => {
  it('emits pinned= even when NO gate setting is stored (fresh user following a deep link)', async () => {
    const gf = await freshGateFilter();
    gf.pinHypercite('hypercite_deep1');
    const url = gf.appendGateParam('/api/x');
    expect(url).toBe(`/api/x?pinned=${encodeURIComponent('hypercite_deep1')}`);
  });

  it('emits both gate= and pinned= when both exist', async () => {
    const gf = await freshGateFilter();
    localStorage.setItem('hyperlit_gate_filter', JSON.stringify({ mode: 'hideAll' }));
    gf.pinHypercite('hypercite_deep1');
    const url = gf.appendGateParam('/api/x?foo=1');
    expect(url).toContain('&gate=');
    expect(url).toContain('&pinned=');
  });

  it('returns the url unchanged with no gate and no pins', async () => {
    const gf = await freshGateFilter();
    expect(gf.appendGateParam('/api/x')).toBe('/api/x');
  });
});
